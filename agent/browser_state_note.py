"""Shared builder for the per-turn embedded-browser ground-truth note.

A compact, read-only snapshot of the Electron-native browser runtime (tabs,
active page, blocking native dialog, crash/download/intervention signals) is
stored request-locally inside a single ``<browser_state> … </browser_state>``
XML envelope. ``conversation_loop`` attaches it to the real user message on the
first model call or to the latest tool result during a tool loop; it is never
persisted as a synthetic user turn. The data comes from the read-only
``liveState`` RPC (no CDP attach, no paint) — chat-only turns stay zero-impact
on the page.

Two consumers share this module:
  * ``tui_gateway/server.py`` — once per turn, with the gateway ``session`` dict
    acting as the cursor store.
  * ``agent/conversation_loop.py`` — once per LLM iteration, with a per-agent
    cursor dict, so every model call sees the freshest liveState.

Per-session cursors ``browser_seen_generation`` / ``browser_seen_intervention_ts``
let us tell the model *what changed* since the last injection rather than just
dumping a static snapshot.
"""

from __future__ import annotations

import re
from typing import Any, Callable, MutableMapping

# Envelope markers — XML 角括号标签(对齐 的 <browser_state>/<page_stats> 结构化写法,
# 比方括号更主流;[index]/[Start of page] 那种元素/页面标记仍用方括号,与 一致)。
# 两端必须成对且与 stripper 查找的完全一致,否则上一轮的块剥不掉、prompt 无限增长。
BROWSER_STATE_BEGIN = "<browser_state>"
BROWSER_STATE_END = "</browser_state>"
BROWSER_GROUNDING_UNAVAILABLE = "BROWSER_GROUNDING_UNAVAILABLE"
_CONTROL_ENVELOPE_TAG_RE = re.compile(
    r"<(?=\s*/?\s*(?:browser_state|system-reminder)\b)",
    re.IGNORECASE,
)

# 措辞:陈述事实、给上下文,不用命令/否定式("覆盖并作废""绝不要沿用你早前的说法")。
# override/"disregard your earlier"类措辞容易触发模型的用户保护训练、反而降低遵循度;
# 正向、present-tense 的事实陈述更可靠。权威性主要靠通道(<system-reminder> 操营通道)+ 新近性(末位)
# + 具体性(死数字 + 带序号的列表)来建立,而非靠加重语气。
_INTRO = (
    "Fan browser runtime state (not a new user message or task). The page may change "
    "between model calls because of tools, the user, or the website. The following is "
    "the current ground-truth snapshot; if it differs from an earlier state, use this one:"
)
_OUTRO = (
    "Use this state only to continue the original user task for this turn. If tool "
    "results already verify that the goal is complete, answer directly without unrelated "
    "browser actions. Call browser_observe first when page content is needed."
)
_CURRENT_OBSERVATION_OUTRO = (
    "Use this state only to continue the original user task for this turn. The current "
    "request already includes a page observation consistent with the runtime state, so "
    "do not repeat browser_observe. If tool results already verify that the goal is "
    "complete, answer directly without unrelated browser actions."
)


def render_browser_grounding_unavailable_note() -> str:
    """Return a reference-free fail-closed note for the current request.

    This note deliberately contains no tab id, URL, DOM text, selector index,
    or last-known page details. It can therefore supersede an older observation
    without accidentally presenting any historical reference as current.
    """

    return "\n".join(
        (
            BROWSER_STATE_BEGIN,
            "Fan browser runtime state (not a new user message or task).",
            f"State: {BROWSER_GROUNDING_UNAVAILABLE}",
            "A current browser page observation is temporarily unavailable; this "
            "request contains no page element references that are safe to operate.",
            "Before the next browser action, obtain a fresh page observation and "
            "continue the original task from that state.",
            BROWSER_STATE_END,
        )
    )


def strip_browser_state_note(text: str) -> str:
    """Remove a previously injected ``<browser_state> … </browser_state>`` block.

    If the closing marker is absent the text is returned untouched (apart from
    trimming): a bare ``<browser_state>`` mention could legitimately appear in the
    static prompt body, and truncating from there once wiped the operating
    rules that followed it.
    """
    start = text.find(BROWSER_STATE_BEGIN)
    if start < 0:
        return text.strip()
    end = text.find(BROWSER_STATE_END, start)
    if end < 0:
        return text.strip()
    return (text[:start] + text[end + len(BROWSER_STATE_END):]).strip()


def escape_control_envelope_tags(text: str) -> str:
    """Keep page-controlled text from forging a harness control envelope.

    Escaping the opening angle bracket preserves ordinary snapshot markup while
    making browser-state and outer system-reminder tags inert. The match is
    case-insensitive and accepts whitespace variants so a page cannot bypass it
    with an equivalent-looking closing tag.
    """
    return _CONTROL_ENVELOPE_TAG_RE.sub("&lt;", text)


def _tab_id(tab: Any) -> str:
    if not isinstance(tab, dict):
        return ""
    return escape_control_envelope_tags(
        str(tab.get("stableId") or tab.get("tabId") or "").strip()
    )


def _fmt_tab(tab: dict) -> str:
    stable = _tab_id(tab)
    title = escape_control_envelope_tags(
        " ".join(str(tab.get("title") or "").split())[:48]
    )
    url = escape_control_envelope_tags(str(tab.get("url") or "")[:120])
    marker = "(current)" if tab.get("current") else ""
    loading = "(loading)" if tab.get("loading") else ""
    label = f"#{stable}" if stable else "#?"
    return f"{label}{marker}{loading} {title or '(untitled)'} {url}".strip()


def _active_tab(state: dict, tabs: list) -> dict | None:
    for tab in tabs:
        if isinstance(tab, dict) and tab.get("current"):
            return tab
    active_idx = state.get("active")
    if isinstance(active_idx, int) and 0 <= active_idx < len(tabs):
        candidate = tabs[active_idx]
        if isinstance(candidate, dict):
            return candidate
    return None


def render_live_state_note(
    state: Any,
    cursor: MutableMapping[str, Any],
    observe_fn: Callable[[], str | None] | None = None,
    *,
    force_observe: bool = False,
    observation_current: bool = False,
) -> str | None:
    """Render the liveState payload into the envelope, advancing ``cursor``.

    ``cursor`` is a per-session mutable mapping; the generation / intervention
    high-water marks are read and rewritten in place so the *next* render can
    detect deltas. Returns ``None`` when there is nothing worth injecting.

    ``observe_fn`` 是【可选】的零参钩子,返回新页面 DOM 文本(或 None)。页面变化或
    ``force_observe=True`` 时调用一次,把最新 DOM 以 ``[最新观察]`` 子段追加进块内。
    强制模式用于用户输入/审批等待恢复后的正确性边界；普通聊天轮仍不会触发重观察。
    ``observation_current=True`` 表示当前模型请求已经携带与 liveState
    决策令牌绑定的完整 DOM,此时状态提示不得诱导模型重复观察。
    """
    if not isinstance(state, dict):
        return None

    tabs = state.get("tabs")
    if not isinstance(tabs, list):
        tabs = []
    tab_lines = [_fmt_tab(t) for t in tabs if isinstance(t, dict)]

    high_priority: list[str] = []
    notes: list[str] = []
    observation_refresh_required = False

    pending = state.get("pendingDialog")
    if isinstance(pending, dict):
        dtype = escape_control_envelope_tags(
            str(pending.get("type") or "").strip()
        )
        message = escape_control_envelope_tags(
            " ".join(str(pending.get("message") or "").split())[:200]
        )
        high_priority.append(
            f"⚠ An unhandled native dialog [{dtype}] {message} is blocking the page; "
            "handle it first"
        )

    active = _active_tab(state, tabs)
    if isinstance(active, dict) and active.get("crashed"):
        high_priority.append(
            "⚠ The current tab's renderer process has crashed; call browser_reload first"
        )

    download = state.get("recentDownload")
    if isinstance(download, dict):
        filename = escape_control_envelope_tags(
            str(download.get("filename") or "").strip()
        )
        path = escape_control_envelope_tags(
            str(download.get("path") or "").strip()
        )
        if filename or path:
            notes.append(f"Downloaded file: {filename} → {path}")

    # Delta detection vs. the high-water marks recorded on the previous render.
    # On the first render the marks are unset, so we baseline silently rather
    # than crying "changed" about state the model has never seen.
    intervention = state.get("lastUserInterventionTs")
    if isinstance(intervention, (int, float)):
        prev = cursor.get("browser_seen_intervention_ts")
        if prev is not None and intervention > prev:
            if observation_current and force_observe:
                notes.append(
                    "The user manually interacted with the page during this turn. The "
                    "latest page observation has been refreshed; continue from the "
                    "current state"
                )
            else:
                notes.append(
                    "The user manually interacted with the page during this turn, so "
                    "your earlier observation may be stale; call browser_observe again first"
                )
                observation_refresh_required = True
        cursor["browser_seen_intervention_ts"] = intervention

    # 页面"已变化"判定:activeGeneration 是【活动标签自己的】计数(各标签从 0 各自递增),所以
    # 不能用单一会话级高水位做 > 比较(从高代次标签切到低代次标签会漏报)。改为:
    #   ① 活动标签 id 变了(切到了别的标签)→ 变化;
    #   ② 活动标签的代次 != 它自己上次记录的值(用 != 而非 >,兼容 runtime 重启/重绑导致的回退)→ 变化。
    # 首次(无 prev)只 baseline 不报警。
    active_id = _tab_id(active)
    generation = state.get("activeGeneration")
    seen_by_tab = cursor.get("browser_seen_gen_by_tab")
    if not isinstance(seen_by_tab, dict):
        seen_by_tab = {}
        cursor["browser_seen_gen_by_tab"] = seen_by_tab
    changed = False
    prev_active = cursor.get("browser_active_tab")
    if prev_active is not None and active_id and active_id != prev_active:
        changed = True
    if isinstance(generation, (int, float)) and active_id:
        prev_gen = seen_by_tab.get(active_id)
        if prev_gen is not None and generation != prev_gen:
            changed = True
        seen_by_tab[active_id] = generation
    if active_id:
        cursor["browser_active_tab"] = active_id

    # ③ 标签集合变化(新开/关闭任一标签)。tabListGeneration 是【会话级】单调计数,
    # 补上 ①② 的盲区:关闭一个非活动的后台标签时,活动标签 id 和它自己的代次都不变,
    # 关闭又不 emit USER_INTERVENED,原本三个检测全漏 —— 会话级计数保证"标签少了一个"
    # 也能到达模型。用 != 而非 >:会话销毁重建后计数从 0 重来,> 比较会卡在旧高水位、
    # 吞掉之后所有真实变化直到重新爬过;!= 对每个不同值都报,一次 render 即自愈。
    # 首次(无 prev)只 baseline。
    # 与 ①② 分开置位:标签集合变化不代表【活动页】变了——它的完整事实(共 N 个、逐行
    # 列表)已由上方 tab_lines 承载,既不需要提示模型去 browser_observe,更不该驱动下方的
    # observe_fn 去拉一次未变化的活动页 DOM(白付最长 8s 的 CDP attach,产物随即被
    # per-iteration 刷新覆盖丢弃 —— 对抗审查 wf_973d4ebd 抓出的白付路径)。
    tab_list_changed = False
    tab_list_gen = state.get("tabListGeneration")
    if isinstance(tab_list_gen, (int, float)):
        prev_list_gen = cursor.get("browser_seen_tab_list_gen")
        if prev_list_gen is not None and tab_list_gen != prev_list_gen:
            tab_list_changed = True
        cursor["browser_seen_tab_list_gen"] = tab_list_gen

    if changed:
        if observation_current:
            notes.append(
                "The page changed since your previous observation. The current context "
                "includes a fresh page observation; continue the original task from it"
            )
        else:
            notes.append(
                "The page changed since your previous observation; call browser_observe "
                "before acting"
            )
            observation_refresh_required = True
    elif tab_list_changed:
        notes.append(
            "The tab list changed since your previous observation because a tab opened "
            "or closed; use the tab list above"
        )
    if force_observe:
        notes.append(
            "The wait for user interaction has ended. The page observation below was "
            "freshly captured after resuming"
        )

    if not tab_lines and not high_priority and not notes:
        return None

    # 页面变化或人工等待恢复后才拉新 DOM。force_observe 会先写入 notes，故不会被
    # 上面的早退分支吞掉；普通 per-iteration 路径不传钩子，仍保持零额外开销。
    live_dom = ""
    if (changed or force_observe) and observe_fn is not None:
        try:
            raw = observe_fn()
        except Exception:
            # 观察失败(超时/runtime 异常)不拖垮注入,回退到无 DOM 的轻量 note。
            raw = None
        if raw:
            # 必须转义:DOM 里若出现字面量 </browser_state> 会让下一轮 strip 提前
            # 收尾、残留累积撑大 prompt,与 title/url 同源风险。
            live_dom = escape_control_envelope_tags(str(raw)).strip()

    # XML 标签独占一行,内容缩在标签内(干净的结构化块)。
    body: list[str] = [BROWSER_STATE_BEGIN, _INTRO.strip()]
    body.extend(high_priority)
    # 具体性:死数字 + 带序号的整行列表,让"共 N 个"能被逐行数数验证(断言 + 可数列表相互印证,
    # 压过历史里模糊/过时的数量陈述)。
    if tab_lines:
        body.append(
            f"There are {len(tab_lines)} tabs. They are listed one per line below, and "
            "the leading number is their ordinal position:"
        )
        body.extend(f"{i}) {line}" for i, line in enumerate(tab_lines, 1))
    body.extend(notes)
    if live_dom:
        # 方案 A:notes(含"页面已变化先 browser_observe"提示)之后、_OUTRO 之前,
        # 让最新 DOM 紧跟在那条提示后面作为对它的兑现,语义最顺。
        body.append("[Latest observation]")
        body.append(live_dom)
    body.append(
        _CURRENT_OBSERVATION_OUTRO
        if observation_current and not observation_refresh_required
        else _OUTRO
    )
    body.append(BROWSER_STATE_END)
    return "\n".join(body)


def build_note_from_client(
    client: Any,
    workbench_id: str,
    cursor: MutableMapping[str, Any],
    observe_fn: Callable[[], str | None] | None = None,
    *,
    force_observe: bool = False,
    observation_current: bool = False,
) -> str | None:
    """Call the read-only ``liveState`` RPC and render it. Errors swallow to None.

    ``observe_fn`` 原样透传给 ``render_live_state_note`` —— 仅 changed=True 时才会被
    调用。本函数自身只负责取 liveState 数据,不读写 cursor、不感知具体观察 RPC。
    """
    if client is None or not workbench_id:
        return None
    try:
        if not getattr(client, "available", False):
            return None
        state = client.call("liveState", workbench_id=workbench_id)
    except Exception:
        return None
    return render_live_state_note(
        state,
        cursor,
        observe_fn=observe_fn,
        force_observe=force_observe,
        observation_current=observation_current,
    )


def merge_into_ephemeral(agent: Any, note: str | None) -> None:
    """Store the request-local ``<browser_state>`` block for the model call.

    Historical versions put this dynamic block in ``ephemeral_system_prompt``,
    which buried it near the top and invalidated the stable prompt prefix.
    ``conversation_loop`` now attaches the stored note to an existing request
    message without creating a new role. Any legacy copy is removed from the
    ephemeral prompt while unrelated overlays remain untouched.
    """
    agent.ephemeral_system_prompt = strip_browser_state_note(
        str(getattr(agent, "ephemeral_system_prompt", "") or "")
    ) or None
    agent._browser_state_note = note or None
