"""全量 LLM 输入/输出日志(code-review / 排障用)。

设计:
- **env 开关**:源码开发默认开启,正式包默认关闭。只有明确的真值才会开启;
  拼错或未知值一律关闭。
- **不截断文本**:prompt / 工具结果 / LLM 回答全文照写。唯一例外是 base64 图片数据(image_url 里
  ``data:image/...;base64,XXXX``),只留一个 ``[image …N bytes]`` 标记——那是给视觉模型的二进制、不是
  要读的内容。单条超大记录会按文件上限裁剪,避免调试日志无限占用磁盘。
- **隔离**:默认只写 ``$FAN_HOME/llm-io.log``。仅当 ``FAN_LLM_IO_STDOUT=1`` 时才输出到
  stdout,避免原始提示词和页面内容被复制进正式 ``desktop.log``。
- **有界且私有**:日志最多保留当前文件和一个轮转文件,并以用户私有权限创建。
- **永不抛错**:任何异常都吞掉,绝不影响 agent 主流程。

插桩点(单一总闸,流式/非流式都过):
- 主脑输入  : run_agent ``_build_api_kwargs`` 转发后
- 主脑输出  : run_agent ``_build_assistant_message`` 转发后(按内容去重,避开流式 interim 重复)
- 辅助脑输入: auxiliary_client ``call_llm`` / ``async_call_llm`` 组好 kwargs 后
- 辅助脑输出: auxiliary_client ``_validate_llm_response``(所有辅助响应的唯一汇流点)
"""
from __future__ import annotations

import json
import os
import stat
import sys
import threading
import time
from collections import deque
from typing import Any

_LOCK = threading.Lock()
_RECENT_HASHES: deque[int] = deque(maxlen=64)  # 响应去重(流式 interim 会重复构造同一条助手消息)
_PATH_CACHE: list[str | None] = [None]
_TOOLS_SIG: list[int | None] = [None]  # 工具集签名:没变就不重复打完整 schema(避免每条请求刷爆终端)
_TURN_STATE = threading.local()
_MAX_BYTES = 8 * 1024 * 1024
_BACKUP_COUNT = 1
_TRUE_VALUES = frozenset({"1", "true", "yes", "on", "full"})
_FALSE_VALUES = frozenset({"0", "false", "no", "off"})


def _explicit_flag(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    value = raw.strip().lower()
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    return False


def _is_dev() -> bool:
    """开发/源码运行判定。

    ``FAN_INSTALL_METHOD`` 是桌面进程传入的权威身份。目录检查只服务于
    直接运行 Python 源码、尚未经过 Electron 启动器的开发场景。
    """
    install_method = os.environ.get("FAN_INSTALL_METHOD", "").strip().lower()
    if install_method == "packaged":
        return False
    if install_method == "dev":
        return True
    if os.environ.get("FAN_DESKTOP_DEV_SERVER"):
        return True
    try:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.isdir(os.path.join(root, ".git")) or os.path.isdir(
            os.path.join(root, "apps", "desktop", "electron")
        )
    except Exception:
        return False


def enabled() -> bool:
    """开发默认开、正式默认关;明确开关始终优先。"""
    explicit = _explicit_flag("FAN_LLM_IO_LOG")
    return explicit if explicit is not None else _is_dev()


def _log_path() -> str | None:
    if _PATH_CACHE[0] is not None:
        return _PATH_CACHE[0]
    try:
        from fan_constants import get_fan_home
        base = str(get_fan_home())
    except Exception:
        base = os.path.expandvars(r"%LOCALAPPDATA%\fan") if os.name == "nt" else os.path.expanduser("~/.fan")
    try:
        os.makedirs(base, mode=0o700, exist_ok=True)
    except Exception:
        pass
    path = os.path.join(base, "llm-io.log")
    _PATH_CACHE[0] = path
    return path


def _redact(obj: Any) -> Any:
    """递归把 base64 图片数据换成短标记;其它内容原样保留(不截断)。"""
    if isinstance(obj, str):
        if obj.startswith("data:") and ";base64," in obj:
            head, b64 = obj.split(";base64,", 1)
            return f"[{head[5:]} image base64 {len(b64)} chars]"
        return obj
    if isinstance(obj, dict):
        return {k: _redact(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_redact(v) for v in obj]
    return obj


def _tighten_private_regular_file(path: str) -> None:
    """Apply 0600 to an existing regular log without following symlinks."""
    try:
        current = os.lstat(path)
        if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode):
            return
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                return
            try:
                os.fchmod(descriptor, 0o600)
            except (AttributeError, OSError):
                pass
        finally:
            os.close(descriptor)
    except OSError:
        pass


def _emit(banner: str, body: str, sep: str = "=") -> None:
    line = f"\n{sep*100}\n{banner}\n{sep*100}\n{body}\n"
    path = _log_path()
    with _LOCK:
        if path:
            try:
                encoded = line.encode("utf-8", errors="replace")
                if len(encoded) > _MAX_BYTES:
                    marker = b"\n[llm-io record truncated to bounded log size]\n"
                    encoded = (
                        encoded[: max(0, _MAX_BYTES - len(marker))]
                        .decode("utf-8", errors="ignore")
                        .encode("utf-8")
                        + marker
                    )

                try:
                    current = os.lstat(path)
                except FileNotFoundError:
                    current = None
                if current is not None and stat.S_ISLNK(current.st_mode):
                    raise OSError("refusing to write llm-io.log through a symlink")
                if current is not None and not stat.S_ISREG(current.st_mode):
                    raise OSError("llm-io.log target is not a regular file")

                backup = f"{path}.{_BACKUP_COUNT}"
                _tighten_private_regular_file(backup)
                if current is not None and current.st_size + len(encoded) > _MAX_BYTES:
                    if os.path.lexists(backup):
                        backup_mode = os.lstat(backup).st_mode
                        if not (
                            stat.S_ISREG(backup_mode)
                            or stat.S_ISLNK(backup_mode)
                        ):
                            raise OSError("refusing to replace non-file llm-io backup")
                        os.unlink(backup)
                    os.replace(path, backup)
                    _tighten_private_regular_file(backup)

                flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
                flags |= getattr(os, "O_NOFOLLOW", 0)
                descriptor = os.open(path, flags, 0o600)
                try:
                    try:
                        os.fchmod(descriptor, 0o600)
                    except (AttributeError, OSError):
                        pass
                    view = memoryview(encoded)
                    while view:
                        written = os.write(descriptor, view)
                        if written <= 0:
                            break
                        view = view[written:]
                finally:
                    os.close(descriptor)
            except Exception:
                pass
        if _explicit_flag("FAN_LLM_IO_STDOUT") is True:
            try:
                sys.stdout.write(line)
                sys.stdout.flush()
            except Exception:
                pass


def _dumps(obj: Any) -> str:
    try:
        return json.dumps(_redact(obj), ensure_ascii=False, indent=2, default=str)
    except Exception:
        try:
            return str(obj)
        except Exception:
            return "<unserializable>"


def _readable(obj: Any) -> str:
    """把已解析的 JSON 结构铺成可读文本:字符串值保留真实换行/缩进(DOM 才看得清),dict 逐键一行。"""
    if isinstance(obj, str):
        if obj.startswith("data:") and ";base64," in obj:
            return _redact(obj)
        return obj
    if isinstance(obj, dict):
        lines = []
        for k, v in obj.items():
            vs = _readable(v)
            lines.append(f"{k}:\n{vs}" if "\n" in vs else f"{k}: {vs}")
        return "\n".join(lines)
    if isinstance(obj, (list, tuple)):
        return "\n".join(_readable(x) for x in obj)
    return str(obj)


def _render_content(content: Any) -> str:
    """把一条 message 的 content 渲染成【真实换行】的可读文本(不走 json.dumps,避免把换行转义成 \\n)。
    content 可能是字符串、JSON 字符串(工具结果常是 {"dom":"...\\n\\t..."})、或多模态内容块列表。"""
    if content is None or content == "":
        return "(空)"
    if isinstance(content, str):
        # 工具结果常是 JSON 字符串,里头的 \n\t 是转义的(DOM 被挤成一坨)。像 JSON 就解析后按真实
        # 换行/缩进铺开;普通文本(系统提示词)不是 JSON,原样返回。
        s = content.strip()
        if s[:1] in "{[":
            try:
                parsed = json.loads(s)
                if isinstance(parsed, (dict, list)):
                    return _readable(parsed)
            except Exception:
                pass
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                t = block.get("type")
                if t == "text":
                    parts.append(str(block.get("text", "")))
                elif t == "image_url":
                    parts.append(_redact(((block.get("image_url") or {}).get("url", ""))))
                else:
                    parts.append(_dumps(block))
            else:
                parts.append(str(block))
        return "\n".join(parts)
    return str(content)


def _render_messages(messages: Any) -> str:
    """逐条渲染 messages,每条:分隔头 [role] + 真实换行的 content（+ tool_calls / tool_call_id）。
    比 json.dumps 整块 dump 可读得多——系统提示词里的换行会真换行,不再是一行 \\n。"""
    if not isinstance(messages, (list, tuple)):
        return _dumps(messages)
    out = []
    for m in messages:
        if not isinstance(m, dict):
            out.append(f"───── [?] ─────\n{m}")
            continue
        role = m.get("role", "?")
        name = m.get("name")
        out.append(f"───── [{role}{'/' + str(name) if name else ''}] ─────")
        out.append(_render_content(m.get("content")))
        if m.get("tool_calls"):
            out.append("· tool_calls: " + _dumps(m.get("tool_calls")))
        if m.get("tool_call_id"):
            out.append(f"· (回应 tool_call_id: {m.get('tool_call_id')})")
    return "\n".join(out)


def log_request(source: str, model: Any = None, messages: Any = None, tools: Any = None) -> None:
    """记录一次 LLM 请求(发出去的完整 prompt)。source 例:'main' / 'aux:vision'。"""
    if not enabled():
        return
    try:
        parts = [f"模型: {model}"]
        if tools:
            n = len(tools) if isinstance(tools, (list, tuple)) else "?"
            names = []
            try:
                names = [t.get("function", {}).get("name", t.get("name", "?")) if isinstance(t, dict) else "?" for t in tools]
                parts.append(f"工具({n}) [这是和 messages 平级的 tools= 请求参数,不在 messages 里]: {', '.join(names)}")
            except Exception:
                parts.append(f"工具: {n} 个")
            # 完整 schema 只在【工具集首次出现/变化】时铺一次——工具是静态的,每条请求都铺 67 个 schema
            # 会瞬间刷爆终端回滚。后续请求只留一行"同上",大幅压低单条体积。
            sig = hash(tuple(names))
            if sig != _TOOLS_SIG[0]:
                _TOOLS_SIG[0] = sig
                parts.append(f"──── tools 完整 schema(共 {n} 个,本会话首次打印,后续请求不再重复)────")
                parts.append(_dumps(tools))
            else:
                parts.append(f"(tools schema 同上,共 {n} 个,见本会话首条请求)")
        parts.append("messages:")
        parts.append(_render_messages(messages))  # 真实换行渲染,不再 json 转义成 \n
        if isinstance(source, str) and source.startswith("aux:"):
            _emit(f"┄┄ 辅助调用 {source} · 请求(非主对话/干扰项,看主流程可略过)", "\n".join(parts), "┈")
        else:
            _emit(f"▶▶▶ 主脑 · 请求 [{source}]", "\n".join(parts), "=")
    except Exception:
        pass


def log_response(source: str, content: Any = None, tool_calls: Any = None,
                 reasoning: Any = None, finish_reason: Any = None) -> None:
    """记录一次 LLM 响应(收到的完整回答 / 推理 / 工具调用)。"""
    if not enabled():
        return
    try:
        tc_repr = None
        if tool_calls:
            tc_repr = []
            for tc in tool_calls:
                fn = getattr(tc, "function", None) or (tc.get("function") if isinstance(tc, dict) else None)
                name = getattr(fn, "name", None) or (fn.get("name") if isinstance(fn, dict) else None)
                args = getattr(fn, "arguments", None) or (fn.get("arguments") if isinstance(fn, dict) else None)
                tc_repr.append({"name": name, "arguments": args})
        # 去重:同一条助手消息在流式 interim 中会被反复构造
        sig = hash((str(content), str(tc_repr), str(reasoning)))
        if sig in _RECENT_HASHES:
            return
        _RECENT_HASHES.append(sig)
        parts = []
        if finish_reason is not None:
            parts.append(f"finish_reason: {finish_reason}")
        if reasoning:
            parts.append(f"--- 推理(reasoning) ---\n{reasoning}")
        parts.append(f"--- 回答(content) ---\n{content if content not in (None, '') else '(空)'}")
        if tc_repr:
            parts.append(f"--- 模型【决定】调用的工具(这是模型的意图输出,尚未执行;真正执行见下方 🔧 工具执行)---\n{_dumps(tc_repr)}")
        if isinstance(source, str) and source.startswith("aux:"):
            _emit(f"┄┄ 辅助调用 {source} · 响应(非主对话/干扰项)", "\n".join(parts), "┈")
        else:
            _emit(f"◀◀◀ 主脑 · 响应 [{source}]", "\n".join(parts), "=")
    except Exception:
        pass


def log_response_obj(source: str, response: Any) -> None:
    """从 OpenAI 风格响应对象(.choices[0].message)抽取并记录(辅助脑用)。"""
    if not enabled():
        return
    try:
        msg = response.choices[0].message
        reasoning = getattr(msg, "reasoning", None) or getattr(msg, "reasoning_content", None)
        log_response(source, content=getattr(msg, "content", None),
                     tool_calls=getattr(msg, "tool_calls", None), reasoning=reasoning,
                     finish_reason=getattr(response.choices[0], "finish_reason", None))
    except Exception:
        pass


def _json_mapping(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _browser_result_metadata(value: Any) -> dict[str, Any]:
    parsed = _json_mapping(value)
    if not parsed:
        return {
            "failed": False,
            "skipped": False,
            "code": None,
            "effect": None,
            "warning_codes": [],
        }

    def walk(item: dict[str, Any]) -> dict[str, Any]:
        details = item.get("__error_details__") or item.get("error_details") or item.get("details")
        code = item.get("__error_code__") or item.get("error_code") or item.get("errorCode") or item.get("code")
        effect = item.get("effect")
        skipped = item.get("executed") is False or str(item.get("status") or "").lower() == "skipped"
        status = str(item.get("status") or "").lower()
        failed = not skipped and bool(
            item.get("__error__")
            or item.get("error")
            or item.get("failed") is True
            or item.get("ok") is False
            or status
            in {
                "failed",
                "error",
                "partial",
                "failed_before_effect",
                "failed_after_effect",
                "unknown_after_effect",
            }
        )
        retryable = item.get("retryable")
        if isinstance(details, dict) and not isinstance(retryable, bool):
            retryable = details.get("retryable")
        aggregate = {
            "failed": failed,
            "skipped": skipped,
            "code": str(code) if code else None,
            "effect": str(effect) if effect else None,
            "retryable": retryable if isinstance(retryable, bool) else None,
            "warning_codes": [],
        }
        warnings = item.get("warnings")
        if isinstance(warnings, list):
            aggregate["warning_codes"] = [
                str(warning.get("code") or "BROWSER_TOOL_DEGRADED")
                for warning in warnings
                if isinstance(warning, dict)
            ]
        for key in ("result", "error", "screenshot", "pdf"):
            nested = item.get(key)
            if not isinstance(nested, dict):
                continue
            child = walk(nested)
            aggregate["failed"] = aggregate["failed"] or child["failed"]
            aggregate["skipped"] = aggregate["skipped"] or child["skipped"]
            aggregate["code"] = aggregate["code"] or child["code"]
            aggregate["effect"] = aggregate["effect"] or child["effect"]
            aggregate["warning_codes"].extend(child["warning_codes"])
            if aggregate["retryable"] is None:
                aggregate["retryable"] = child["retryable"]
        return aggregate

    return walk(parsed)


def _record_browser_tool_metric(name: Any, args: Any, result: Any, duration_ms: Any) -> None:
    tool_name = str(name or "")
    state = getattr(_TURN_STATE, "metrics", None)
    if not isinstance(state, dict):
        return
    if tool_name == "skill_view":
        state["skill_view_calls"] += 1
        args_map = _json_mapping(args) or {}
        skill_name = str(args_map.get("name") or "").strip()
        if skill_name and skill_name not in state["loaded_skills"]:
            state["loaded_skills"].append(skill_name)
        state["skill_result_chars"] += len(
            result if isinstance(result, str) else _dumps(result)
        )
        return
    if not tool_name.startswith("browser_"):
        return

    state["browser_tool_calls"] += 1
    state["calls_by_tool"][tool_name] = state["calls_by_tool"].get(tool_name, 0) + 1
    metadata = _browser_result_metadata(result)
    if metadata["skipped"]:
        state["skipped_browser_tool_calls"] += 1
    else:
        state["executed_browser_tool_calls"] += 1
    if metadata["failed"]:
        state["failed_browser_tool_calls"] += 1
        code = metadata["code"] or "BROWSER_TOOL_FAILED"
        state["errors_by_code"][code] = state["errors_by_code"].get(code, 0) + 1
        failure_key = f"{tool_name}:{code}"
        seen = state["failure_counts"].get(failure_key, 0) + 1
        state["failure_counts"][failure_key] = seen
        if seen > 1:
            state["retry_count"] += 1
    if metadata["warning_codes"]:
        state["degraded_browser_tool_calls"] += 1
        for code in metadata["warning_codes"]:
            state["warnings_by_code"][code] = state["warnings_by_code"].get(code, 0) + 1
    if metadata["effect"]:
        effect = metadata["effect"]
        state["effects"][effect] = state["effects"].get(effect, 0) + 1

    args_map = _json_mapping(args) or {}
    result_map = _json_mapping(result) or {}
    if tool_name == "browser_run":
        status = str(result_map.get("status") or "").strip().lower()
        if status == "needs_replan" or result_map.get("replan_required") is True:
            state["replan_count"] += 1
        trace = result_map.get("trace")
        if isinstance(trace, list):
            methods: list[str] = []
            for item in trace:
                if not isinstance(item, dict):
                    continue
                method = str(item.get("method") or "").strip()
                if not method:
                    continue
                methods.append(method)
                state["program_methods"][method] = (
                    state["program_methods"].get(method, 0) + 1
                )
                state["program_steps"] += 1
                if method in {"type", "select"}:
                    state["program_input_actions"] += 1
                    state["fill_form_fields"] += 1
                elif method in {"fillForm", "formSubmit"}:
                    item_result = item.get("result")
                    field_count = 0
                    if isinstance(item_result, dict):
                        filled = item_result.get("filled")
                        if isinstance(filled, list):
                            field_count = len(filled)
                        elif isinstance(filled, int) and not isinstance(filled, bool):
                            field_count = max(0, filled)
                        if not field_count:
                            completed_count = item_result.get("completedCount")
                            if (
                                isinstance(completed_count, int)
                                and not isinstance(completed_count, bool)
                            ):
                                field_count = max(0, completed_count)
                    state["program_input_actions"] += max(1, field_count)
                    state["fill_form_fields"] += max(1, field_count)
                if method == "formSubmit":
                    state["program_submit_actions"] += 1
                    state["submit_count"] += 1
                if method == "click":
                    state["program_click_actions"] += 1
            state["program_observe_steps"] += methods.count("observe")
            state["program_settle_steps"] += methods.count("settle")
            if methods and methods[-1] == "observe":
                state["program_final_observe_steps"] += 1
    if tool_name == "browser_fill_form":
        fields = args_map.get("fields")
        if isinstance(fields, list):
            state["fill_form_fields"] += len(fields)
    if tool_name == "browser_click":
        expected = args_map.get("expected") if isinstance(args_map.get("expected"), dict) else {}
        semantic = " ".join(
            str(value or "")
            for value in (
                args_map.get("expected_text"),
                args_map.get("expected_name"),
                expected.get("text"),
                expected.get("name"),
            )
        ).lower()
        if any(word in semantic for word in ("submit", "sign in", "log in", "register", "continue", "提交", "登录", "注册", "继续")):
            state["submit_count"] += 1

    try:
        duration = max(0, int(float(duration_ms or 0)))
    except (TypeError, ValueError):
        duration = 0
    if duration > state["slowest_tool_ms"]:
        state["slowest_tool_ms"] = duration
        state["slowest_tool"] = tool_name


def log_turn_start(user_message: Any, metadata: dict[str, Any] | None = None) -> None:
    """标记【一轮对话开始】(一条用户消息进来)。用最重的 █ 分隔条,一眼看到轮边界。"""
    if not enabled():
        return
    try:
        _TURN_STATE.metrics = {
            "started_at": time.monotonic(),
            "metadata": dict(metadata or {}),
            "browser_tool_calls": 0,
            "executed_browser_tool_calls": 0,
            "skipped_browser_tool_calls": 0,
            "failed_browser_tool_calls": 0,
            "degraded_browser_tool_calls": 0,
            "retry_count": 0,
            "calls_by_tool": {},
            "errors_by_code": {},
            "warnings_by_code": {},
            "effects": {},
            "replan_count": 0,
            "failure_counts": {},
            "slowest_tool": None,
            "slowest_tool_ms": 0,
            "fill_form_fields": 0,
            "submit_count": 0,
            "program_steps": 0,
            "program_methods": {},
            "program_input_actions": 0,
            "program_submit_actions": 0,
            "program_click_actions": 0,
            "program_observe_steps": 0,
            "program_settle_steps": 0,
            "program_final_observe_steps": 0,
            "skill_view_calls": 0,
            "loaded_skills": [],
            "skill_result_chars": 0,
        }
        _emit("██████████  对话轮 开始  ██████████", f"👤 用户: {str(user_message)[:600]}", "█")
    except Exception:
        pass


def log_turn_end(final: Any = None, summary: dict[str, Any] | None = None) -> None:
    """标记【一轮对话结束】(本轮 agent 循环跑完、给出最终回复)。"""
    if not enabled():
        return
    try:
        state = getattr(_TURN_STATE, "metrics", None)
        if isinstance(state, dict) and state.get("browser_tool_calls", 0) > 0:
            metrics = dict(state.get("metadata") or {})
            metrics.update(summary or {})
            metrics.update({
                key: value
                for key, value in state.items()
                if key not in {"started_at", "metadata", "failure_counts"}
            })
            if "duration_ms" not in metrics:
                metrics["duration_ms"] = int((time.monotonic() - state["started_at"]) * 1000)
            _emit("📊 浏览器任务效率", _dumps(metrics), "·")
        body = f"✅ 最终回复: {str(final)[:600]}" if final not in (None, "") else "✅ 本轮结束"
        _emit("██████████  对话轮 结束  ██████████", body, "█")
    except Exception:
        pass
    finally:
        _TURN_STATE.metrics = None


def log_tool(name: Any, args: Any = None, result: Any = None, duration_ms: Any = None) -> None:
    """标记【一次工具真正执行完毕】——区别于上面响应里『模型决定调用的工具』(那只是意图)。
    这条出现 = 工具确实跑了,结果就是下面这段(DOM 等会按真实换行铺开)。"""
    if not enabled():
        return
    try:
        _record_browser_tool_metric(name, args, result, duration_ms)
        body = []
        body.append(f"参数: {args if isinstance(args, str) else _dumps(args)}")
        body.append("结果:")
        body.append(_render_content(result) if isinstance(result, str) else _readable(result))
        _emit(f"🔧 工具执行完毕 · {name}", "\n".join(body), "─")
    except Exception:
        pass
