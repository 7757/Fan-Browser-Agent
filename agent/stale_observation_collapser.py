"""折叠对话历史中【过时的浏览器页面观测】——只保留最新一次完整观测,更早的每一次
折叠成固定存根。

背景/根因(见排障记录):浏览器页面每轮都会重新观测最新状态,但历史里每一次 browser_observe
的完整 DOM + "Open tabs" 列表 + 截图都逐字累积、永久留在上下文。当用户关标签/导航后,这些
过时观测(含已失效的元素索引、已关闭的标签列表)会与正确的最新状态冲突,模型往往锚定在
更"具体、可操作"的旧观测上 —— 复用死索引、以为还在旧页面。裁掉它们,让模型无从锚定。

设计要点(与 AGENTS.md 的 prompt 缓存铁律相容):
- **只作用于每次 API 调用重建的 api_messages 副本**,绝不改 canonical history(持久化/UI 用它;
  改历史只能在压缩阶段做)。这与现有 ``_prune_stale_browser_screenshots`` 同一模式,只是从
  "丢截图"扩展到"折叠整条观测(截图+DOM+tabs)"。
- **确定性 + 单调**:存根字节固定不变;只有当存在严格更新的观测时才折叠某条,一旦折叠字节
  恒定 → 缓存前缀稳定,只有"刚被取代的那一条"字节变化(在 tail 附近、缓存本就冷)。
- **按封套识别**:观测由 ``_observe_text`` 统一包上 ``<page_observation> … </page_observation>``
  封套(tools/electron_browser_tool.py),所以任何内嵌观测的工具(browser_observe / browser_navigate /
  browser_click 自愈 / browser_find_visual …)产出的观测都能被认出,无需维护 tool_name 白名单。
"""
from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# 页面标识面包屑:_observe_text 在封套首行写 [page: 标题 · url]。折叠时提取并保留它,让模型不丢
# "这条原本观测的是哪个页面"的操作历史。方括号定界,对 JSON 转义/多模态 content 都能稳定提取。
_PAGE_HEADER_RE = re.compile(r"\[page:[^\]\n]*\]")
_SUPERSEDED_NOTE = (
    "This step is retained only as a historical action summary. Its page DOM, selector "
    "map, element indices [N], and tab list are not part of the current state. Current "
    "actionable elements come only from the newest complete observation or the latest "
    "observation bound inside <browser_state>."
)

# 观测封套标记 —— 唯一定义源。tools/electron_browser_tool.py 从这里 import,保证两端永不漂移。
# 用 XML 角括号标签,与 <browser_state>/<page_stats> 的现有风格一致。
PAGE_OBSERVATION_BEGIN = "<page_observation>"
PAGE_OBSERVATION_END = "</page_observation>"
_IMAGE_PART_TYPES = frozenset({"image", "image_url", "input_image"})


def release_superseded_observation_images(messages: list, incoming_content: Any) -> int:
    """Release image payloads from observations superseded by ``incoming_content``.

    The newest observation image must remain available to the model. Once a newer
    observation has been produced, however, older screenshots are both visually
    stale and already represented by their DOM text. Keeping their multi-megabyte
    data URLs in canonical session memory serves no recovery or UI purpose.

    Only browser observation *tool* messages are touched. User attachments and
    non-browser image tools remain intact. Touched messages are shallow-copied so
    callers holding a reference to the old message object are not mutated.
    """
    if PAGE_OBSERVATION_BEGIN not in StaleBrowserObservationCollapser._content_text(incoming_content):
        return 0
    if not isinstance(messages, list):
        return 0

    released = 0
    for index, message in enumerate(messages):
        if not StaleBrowserObservationCollapser._is_observation(message):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue

        removed_here = 0
        compact_content = []
        for part in content:
            if isinstance(part, dict) and part.get("type") in _IMAGE_PART_TYPES:
                removed_here += 1
                continue
            compact_content.append(part)
        if not removed_here:
            continue
        compact_content.append({"type": "text", "text": "[stale browser screenshot released]"})
        messages[index] = {**message, "content": compact_content}
        released += removed_here

    if released:
        logger.info(
            "[grounding] released %d superseded browser screenshot payload(s)",
            released,
        )
    return released

def _superseded_stub(content_text: str, action_name: str | None = None) -> str:
    """为一条过时观测构造折叠存根:保留其页面标识面包屑([page: …],若有),再接作废说明。
    存根由该观测【自身内容】派生 → 同一条观测每轮得到相同字节(确定性,缓存安全)。
    注意:开标签用 ``<page_observation superseded="true">``(带属性、带空格),【不等于】
    ``PAGE_OBSERVATION_BEGIN``("<page_observation>"),故存根自身不会被 _is_observation 再次
    识别 → 折叠幂等。"""
    m = _PAGE_HEADER_RE.search(content_text or "")
    head = (m.group(0) + " —— ") if m else ""
    safe_action = str(action_name or "browser_action").strip()
    if not re.fullmatch(r"browser_[a-z0-9_]+", safe_action):
        safe_action = "browser_action"
    return (
        f'<page_observation superseded="true">Historical action: {safe_action}; '
        f'{head}{_SUPERSEDED_NOTE}</page_observation>'
    )


# 无面包屑时的通用存根(向后兼容/兜底)。
SUPERSEDED_STUB = _superseded_stub("")


class StaleBrowserObservationCollapser:
    """保留最新一次浏览器页面观测的完整内容,把更早的每一次折叠成 ``SUPERSEDED_STUB``。

    纯函数式、无状态:``collapse`` 接收一次 API 调用的 ``api_messages`` 副本,返回处理后的
    列表(无可折叠项时原样返回同一对象;有则只复制列表和被替换的消息字典)。
    """

    @staticmethod
    def _content_text(content: Any) -> str:
        """取出 tool 消息 content 里可供搜索封套的文本:字符串直接返回;多模态 content 列表
        则拼接其 text 段(截图 image_url 段忽略)。"""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                str(p.get("text", ""))
                for p in content
                if isinstance(p, dict) and p.get("type") in {"text", "input_text"}
            )
        return ""

    @classmethod
    def _is_observation(cls, msg: Any) -> bool:
        """一条 tool 消息是否携带【完整】页面观测(含开标记的封套)。已折叠的存根用带属性的
        开标签,不含精确的 ``<page_observation>`` 子串,故不会被误判为可再折叠的观测。"""
        if not isinstance(msg, dict) or msg.get("role") != "tool":
            return False
        return PAGE_OBSERVATION_BEGIN in cls._content_text(msg.get("content"))

    def collapse(self, api_messages: list) -> list:
        """保留最后一条观测完整;更早的每一条整条 content 替换为存根(同时丢掉其截图,
        因为 content 变成纯字符串)。就地不改入参:命中时使用结构共享的浅复制。"""
        if not isinstance(api_messages, list):
            return api_messages
        obs_idxs = [i for i, m in enumerate(api_messages) if self._is_observation(m)]
        if len(obs_idxs) < 2:
            return api_messages
        # Copy only the list and stale message dictionaries. A deepcopy used to
        # duplicate every base64 screenshot in the request before immediately
        # discarding the stale ones, creating a large transient memory spike on
        # every model turn.
        transformed = list(api_messages)
        stale = obs_idxs[:-1]  # 除最后一条外全折叠
        for i in stale:
            original = api_messages[i]
            text = self._content_text(original.get("content"))
            transformed[i] = {
                **original,
                "content": _superseded_stub(text, original.get("name")),
            }
        logger.info(
            "[grounding] projected %d stale page observation(s) to Browser Use-style action history; preserved tool-call pairing",
            len(stale),
        )
        return transformed
