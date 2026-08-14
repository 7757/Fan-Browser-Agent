"""Visual perception pipeline for the Electron browser tools.

The facade owns RPC, tool registration, task/session context, and safety policy.
This module owns image annotation, pruning, diagnostics, and the visual-find
pipeline. Runtime dependencies are injected so there is only one source of
state and the facade's existing monkeypatch seams remain intact.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class VisualFindDependencies:
    call: Callable[..., Any]
    crop_png_region: Callable[..., Any]
    debug_dump: Callable[..., Any]
    dump_composition: Callable[..., Any]
    enrich_error: Callable[..., Any]
    find_visual_dir: Callable[[], str]
    heal_or_error: Callable[..., Any]
    observation_viewport: Callable[..., Any]
    paint_index_boxes: Callable[..., Any]
    prune_for_paint: Callable[..., Any]
    result_with_fresh_observation: Callable[..., Any]
    retry: Callable[[dict[str, Any], int, dict[str, Any]], Any]
    tool_error: Callable[..., Any]
    tool_result: Callable[..., Any]


# ── Cross-platform diagnostic paths / fonts ──────────────────────────
# The browser-agent perception diagnostics were originally written on Windows
# with hardcoded ``%LOCALAPPDATA%\fan`` paths and ``C:\Windows\Fonts`` — on
# macOS/Linux ``os.path.expandvars('%LOCALAPPDATA%')`` returns the literal
# string, so dumps landed in a bogus relative dir and the box-label font fell
# back to Pillow's tiny bitmap default (illegible numbers). These helpers make
# the whole find-visual/dom-llm diagnostic surface profile-aware and portable.
# AGENTS.md rule: never hardcode ~/.fan — use get_fan_home().
def _fan_home_dir() -> str:
    """FAN_HOME base dir (profile-aware, cross-platform)."""
    try:
        from fan_constants import get_fan_home
        return str(get_fan_home())
    except Exception:
        import os as _os
        if _os.name == "nt":
            return _os.path.join(_os.path.expandvars(r"%LOCALAPPDATA%"), "fan")
        return _os.path.expanduser("~/.fan")


def _find_visual_dir() -> str:
    """``<FAN_HOME>/find-visual`` — SoM diagnostics (composition-*.json,
    fv-*.png, find-visual-log.jsonl)."""
    import os as _os
    return _os.path.join(_fan_home_dir(), "find-visual")


def _load_box_font(size: int):
    """Cross-platform bold TTF for the numbered-box labels (digits only). Tries
    Windows → macOS → Linux system fonts, then Pillow's bundled default."""
    from PIL import ImageFont
    for path in (
        r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size)  # Pillow ≥10.1 accepts a size
    except Exception:
        return ImageFont.load_default()

# 编号框配色:严格对齐 python_highlights.ELEMENT_COLORS(按元素类型上色)
_BOX_COLORS = {
    "button": "#FF6B6B",   # 红 — 按钮
    "input": "#4ECDC4",    # 青 — 输入
    "select": "#45B7D1",   # 蓝 — 下拉
    "a": "#96CEB4",        # 绿 — 链接
    "textarea": "#FF8C42", # 橙 — 多行文本
    "default": "#DDA0DD",  # 浅紫 — 其它可交互
}
# role → tag 兜底(我们的 DOM 有时只有 role 没有具体标签)
_ROLE_TO_TAG = {
    "button": "button", "link": "a", "textbox": "input",
    "searchbox": "input", "combobox": "select", "listbox": "select",
}


def _box_color_for(tag, etype, role):
    """按元素类型取框色:对齐 get_element_color(input[type=button/submit] 归按钮色;
    其余按 tag;tag 缺失/通用时用 role 兜底)。"""
    t = (tag or "").lower()
    if t == "input" and str(etype or "").lower() in ("button", "submit"):
        return _BOX_COLORS["button"]
    if t in _BOX_COLORS:
        return _BOX_COLORS[t]
    mapped = _ROLE_TO_TAG.get(str(role or "").lower())
    return _BOX_COLORS[mapped] if mapped else _BOX_COLORS["default"]


def _meaningful_text(el):
    """元素的「有效可见文字」——对齐 EnhancedDOMTreeNode.get_meaningful_text_for_llm:
    优先 value/aria-label/title/placeholder/alt,回落到节点文字(text 已折叠 innerText/aria-label)。
    用来判断该元素在图上是否还需要单独贴编号号牌(有可见文字的元素,模型靠文字就能对回 DOM 序号)。"""
    if not isinstance(el, dict):
        return ""
    a = el.get("attributes") or {}
    if isinstance(a, dict):
        for key in ("value", "aria-label", "title", "placeholder", "alt"):
            v = a.get(key)
            if v:
                return str(v).strip()
    return str(el.get("text") or "").strip()


def _should_label(el):
    """是否给该元素贴编号号牌——对齐 filter_highlight_ids:仅当无有效可见文字(<3 字)
    才贴号(图标/空输入框这类「没字可认」的才需要数字);有字元素只描框,避免满屏号牌互相遮挡。"""
    return len(_meaningful_text(el)) < 3


def observation_viewport(result, kw, *, call):
    """Return ``scrollX, scrollY, innerWidth, innerHeight`` for an observation.

    ``observe`` already captures these values atomically with the indexed DOM.
    Reusing them both removes an RPC and ensures screenshot labels use the same
    coordinate frame as the element snapshot. The JS fallback is retained for
    older desktop runtimes that did not return viewport metadata.
    """
    viewport = result.get("viewport") if isinstance(result, dict) else None
    if isinstance(viewport, dict):
        try:
            width = float(viewport.get("width", 0) or 0)
            if width > 0:
                return (
                    float(viewport.get("scrollX", 0) or 0),
                    float(viewport.get("scrollY", 0) or 0),
                    width,
                    float(viewport.get("height", 0) or 0),
                )
        except (TypeError, ValueError):
            pass

    try:
        import json as _json

        response = call(
            "evaluateJavaScript",
            {"code": "JSON.stringify({sx:scrollX,sy:scrollY,iw:innerWidth,ih:innerHeight})"},
            **kw,
        )
        raw = response.get("value") if isinstance(response, dict) else None
        values = _json.loads(raw) if raw else {}
        return (
            float(values.get("sx", 0) or 0),
            float(values.get("sy", 0) or 0),
            float(values.get("iw", 0) or 0),
            float(values.get("ih", 0) or 0),
        )
    except Exception:
        return 0.0, 0.0, 0.0, 0.0


def _paint_index_boxes(img_bytes, elements, sx, sy, iw, filter_labels=True, output_format="PNG"):
    """把带【编号】的方框画到【截图图片】上(对齐 python_highlights 的
    create_highlighted_screenshot + draw_enhanced_bounding_box_with_text):
    - 框:每个可交互元素都描,虚线 dash4/gap8/2px,按元素类型上色;
    - 号牌(方案 B):小号牌默认贴在框【左上角、上边沿正上方】(紧挨=归属一望即知);仅当与
      已放置号牌相撞时,才挪到附近空位并拉一条【引线 + 端点圆点】指回该框——杜绝满屏数字对不上框。
      白底 + 类型色描边 + 黑字。filter_labels=True(observe 整页用)给有可见文字的元素省号;
      filter_labels=False(find_visual 用)则全贴号。
    元素 rect 是 CSS 文档坐标 → 减滚动、按 scale=图宽/innerWidth(=该截图有效 DPR,自动跟随缩放,
    比 window.devicePixelRatio 更贴合实图)映射到截图像素。Pillow 不可用返回 None,调用方回落注入式。"""
    try:
        import io as _io
        from PIL import Image, ImageDraw, ImageFont
    except Exception:
        return None
    try:
        # CDP viewport screenshots are opaque. RGB uses 25% less decoded pixel
        # memory than RGBA and works for both PNG and JPEG output.
        im = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
    except Exception:
        return None
    W, H = im.size
    scale = (W / iw) if iw else 1.0
    draw = ImageDraw.Draw(im)
    # 号牌字号/内边距:做小(方案 B——小号牌贴框角),按图宽自适应
    fsize = max(11, min(15, int(W * 0.009)))
    padding = max(2, min(4, int(W * 0.003)))
    font = _load_box_font(fsize)

    dash, gap, lw = 4, 8, 2  # 虚线:dash4/gap8/2px

    def _dashed(ax, ay, bx, by, color):
        if ax == bx:  # 竖
            y = ay
            while y < by:
                draw.line([(ax, y), (ax, min(y + dash, by))], fill=color, width=lw)
                y += dash + gap
        else:         # 横
            x = ax
            while x < bx:
                draw.line([(x, ay), (min(x + dash, bx), ay)], fill=color, width=lw)
                x += dash + gap

    def _collides(rect, others):
        return any(not (rect[2] <= o[0] or rect[0] >= o[2] or rect[3] <= o[1] or rect[1] >= o[3]) for o in others)

    def _order_key(e):
        rr = (e.get("rect") or {}) if isinstance(e, dict) else {}
        return (float(rr.get("top", rr.get("y", 0)) or 0), float(rr.get("left", rr.get("x", 0)) or 0))

    placed = []  # 已放置号牌矩形,供方案 B 防撞 + 决定是否拉引线
    for el in sorted((elements or []), key=_order_key):
        if not isinstance(el, dict):
            continue
        r = el.get("rect") or {}
        left = r.get("left", r.get("x"))
        top = r.get("top", r.get("y"))
        w = r.get("width")
        h = r.get("height")
        if left is None or top is None or not w or not h:
            continue
        x1 = (float(left) - sx) * scale
        y1 = (float(top) - sy) * scale
        x2 = (float(left) + float(w) - sx) * scale
        y2 = (float(top) + float(h) - sy) * scale
        if x2 < 0 or y2 < 0 or x1 > W or y1 > H:  # 滚动出视口不画
            continue
        a = el.get("attributes") or {}
        color = _box_color_for(el.get("tag"), a.get("type"), a.get("role") or el.get("role"))
        # 虚线方框(上/右/下/左)—— 每个可交互元素都描框
        _dashed(x1, y1, x2, y1, color)
        _dashed(x2, y1, x2, y2, color)
        _dashed(x1, y2, x2, y2, color)
        _dashed(x1, y1, x1, y2, color)
        # 编号号牌:对齐 filter_highlight_ids —— 仅给「无可见文字」的元素贴号
        # (有字元素让模型靠可见文字对回 DOM 序号),否则满屏号牌互叠就是拥挤元凶。
        if filter_labels and not _should_label(el):
            continue
        idx = str(el.get("index"))
        try:
            tb = draw.textbbox((0, 0), idx, font=font)
            tw, th, toff = tb[2] - tb[0], tb[3] - tb[1], tb[1]
        except Exception:
            tw, th, toff = 7 * len(idx), fsize, 0
        cw, ch = tw + padding * 2, th + padding * 2
        # 方案 B 摆位:默认贴左上角、上边沿正上方(紧挨框 = 归属一望即知,无需引线)
        bx1, by1 = x1, y1 - ch
        if bx1 + cw > W: bx1 = W - cw
        if bx1 < 0: bx1 = 0
        if by1 < 0: by1 = y1                          # 顶部没空间 → 压在框内顶部
        leader = False
        if _collides((bx1, by1, bx1 + cw, by1 + ch), placed):
            # 与已放号牌相撞 → 挪到附近空位,并拉引线指回本框
            leader = True
            for dx, dy in ((0, -(ch + 1)), (0, -2 * (ch + 1)), (cw + 2, 0), (-(cw + 2), 0),
                           (0, -3 * (ch + 1)), (cw + 2, -(ch + 1)), (-(cw + 2), -(ch + 1)), (0, ch + 1)):
                nx = min(max(0.0, x1 + dx), float(W - cw))
                ny = min(max(0.0, (y1 - ch) + dy), float(H - ch))
                if not _collides((nx, ny, nx + cw, ny + ch), placed):
                    bx1, by1 = nx, ny
                    break
        bx2, by2 = bx1 + cw, by1 + ch
        placed.append((bx1, by1, bx2, by2))
        if leader:  # 引线:号牌底边中点 → 框左上角 + 端点小圆点
            draw.line([(bx1 + cw / 2, by2), (x1 + 3, y1 + 3)], fill=color, width=1)
            draw.ellipse([x1 + 1, y1 + 1, x1 + 5, y1 + 5], fill=color)
        # 小号牌:白底 + 类型色描边 + 黑字(描边色 = 该框色,强化"号属于哪个框")
        draw.rectangle([bx1, by1, bx2, by2], fill="white", outline=color, width=1)
        draw.text((bx1 + (cw - tw) / 2, by1 + (ch - th) / 2 - toff), idx, fill="black", font=font)
    out = _io.BytesIO()
    normalized_format = str(output_format or "PNG").upper()
    if normalized_format in {"JPG", "JPEG"}:
        im.save(out, format="JPEG", quality=90, subsampling=0, optimize=False)
    else:
        im.save(out, format="PNG")
    return out.getvalue()


def _crop_png_region(img_bytes, l_px, t_px, r_px, b_px):
    """把 PNG 裁到给定像素矩形(越界自动夹紧)。区域过小返回 None(放弃裁切)。"""
    try:
        import io as _io
        from PIL import Image
        im = Image.open(_io.BytesIO(img_bytes))
        W, H = im.size
        l, t = max(0, int(l_px)), max(0, int(t_px))
        r, b = min(W, int(r_px)), min(H, int(b_px))
        if r - l < 60 or b - t < 30:
            return None
        out = _io.BytesIO()
        im.crop((l, t, r, b)).save(out, format="PNG")
        return out.getvalue()
    except Exception:
        return None


def _fv_debug_dump(img_bytes, desc, ans, extra=None):
    """探针(永久、轻量):把 find_visual 实际喂给 qwen 的【带框图】+ qwen 回答 + 选号落盘,
    供桌面真机诊断"框对不对齐 / qwen 选的是不是发送键"。失败静默,绝不影响主流程。
    落点:<FAN_HOME>/find-visual/(fv-<时分秒>.png + find-visual-log.jsonl)。"""
    try:
        import json as _j3
        import os as _os3
        import time as _t3
        base = _find_visual_dir()
        _os3.makedirs(base, exist_ok=True)
        stamp = _t3.strftime("%H%M%S")
        img_name = f"fv-{stamp}.png"
        with open(_os3.path.join(base, img_name), "wb") as f:
            f.write(img_bytes)
        rec = {"ts": _t3.strftime("%Y-%m-%dT%H:%M:%S"), "desc": desc, "vision_said": (ans or "")[:200], "img": img_name}
        if extra:
            rec.update(extra)
        with open(_os3.path.join(base, "find-visual-log.jsonl"), "a", encoding="utf-8") as f:
            f.write(_j3.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


# find_visual 画框前剪枝的"超大容器"阈值:元素面积 > 视口面积 × 此比例 → 视为页面/区块外壳丢弃。
# 起始保守值,按 composition-*.json 的真实分布校准(R4)。
_FV_OVERSIZE_VIEWPORT_FRAC = 0.5

# R1 补充:短边小于此值(CSS px)的框不是人眼可辨的独立目标(如 4×4 的圆点)。这是
# _prune_for_paint 自身使命("人眼可辨的独立可操作目标")的几何判据,与元素标签无关。
# (SVG 图元污染已在源头修复:dom-service ownerSVGElement 门,不在此重复防御。)
_FV_MIN_SIDE_PX = 8.0


def _fv_semantic_weight(e) -> int:
    """去重时的语义强度:同位置多层壳(span 包 img 包 svg)只留一个时,优先留语义最强的
    (真机 bug:R3 把有 id 的 <img ci-submit-button-ai> 丢了、留下裸 <span>,地图上真按钮无名)。"""
    tag = str(e.get("tag") or "").lower()
    a = e.get("attributes") if isinstance(e.get("attributes"), dict) else {}
    w = 0
    if tag in ("button", "a", "input", "select", "textarea", "img"):
        w += 2
    if a.get("id"):
        w += 2
    if e.get("role") or a.get("role") or a.get("aria-label"):
        w += 1
    if str(e.get("text") or "").strip():
        w += 1
    return w


def _prune_for_paint(elements, vw=0, vh=0):
    """find_visual 画框前【标准化剪枝】:把候选从"全部可交互图层"(cursor:pointer/JS监听把每一层都
    算上,一帧能到 145 个)压成人眼可辨的"独立可操作目标"集。规则(按序、每条有明确几何判据):
      R1 几何门:无有效 rect / 面积≈0 的不参与(画不出框)。
      R4 丢超大容器:面积 > 视口 × _FV_OVERSIZE_VIEWPORT_FRAC(聊天区/大区块外壳)→ 绝非小图标目标。
      R2 去嵌套留叶子:若某框基本包住【另一个更小的可交互元素】(交集≥85% 该小框、且小框面积<它的 90%),
         它是容器 → 丢它留里面的叶子(对齐 DOM 端 shouldExcludeByPropagatingBounds)。
      R3 去重:按面积升序,内层/较小者先留;后来者与已留框交集≥90% 其较小框 → 视为重复丢弃。
    绝不按"太多了留前 N 个"盲目截断(会丢真目标)。vw/vh=视口宽高(CSS px),缺省则跳过 R4。
    无 rect 的元素不参与(画不出框)。"""
    items = []
    for e in elements or []:
        if not isinstance(e, dict):
            continue
        r = e.get("rect") if isinstance(e.get("rect"), dict) else None
        if not r:
            continue
        try:
            l = float(r.get("left", r.get("x", 0))); t = float(r.get("top", r.get("y", 0)))
            w = float(r.get("width", 0)); h = float(r.get("height", 0))
        except (TypeError, ValueError):
            continue
        if w <= 0 or h <= 0:
            continue
        # R1 几何门补充:短边 < _FV_MIN_SIDE_PX 的框不是人眼可辨的独立目标,画上去只添乱。
        if min(w, h) < _FV_MIN_SIDE_PX:
            continue
        items.append({"e": e, "x1": l, "y1": t, "x2": l + w, "y2": t + h, "area": w * h})

    # R4 丢超大容器:面积占视口比例过大者(整页/区块外壳)。find_visual 的目标恒为小图标 → 丢了安全。
    if vw and vh:
        _cap = float(vw) * float(vh) * _FV_OVERSIZE_VIEWPORT_FRAC
        items = [a for a in items if a["area"] <= _cap]

    kept = []
    for i, a in enumerate(items):
        is_container = False
        for j, b in enumerate(items):
            if i == j or b["area"] >= a["area"] * 0.9:  # 只用【更小】的 B 判定 A 是不是容器
                continue
            ix = max(0.0, min(a["x2"], b["x2"]) - max(a["x1"], b["x1"]))
            iy = max(0.0, min(a["y2"], b["y2"]) - max(a["y1"], b["y1"]))
            if b["area"] > 0 and (ix * iy) / b["area"] >= 0.85:
                is_container = True  # A 基本包住更小的 B → A 是包裹层,丢 A 留 B
                break
        if not is_container:
            kept.append(a)

    # R3 去重:面积升序 → 内层/较小者先留;后来者与已留框交集≥90% 其较小框 → 视为重复。
    # 重复对里【留语义最强者】(_fv_semantic_weight),而非盲按遍历序——否则有 id 的
    # <img ci-submit-button-ai> 会被丢掉、留下裸 <span> 壳,真按钮在地图上无名(真机 bug)。
    deduped = []
    for a in sorted(kept, key=lambda x: x["area"]):
        dup_at = -1
        for i, k in enumerate(deduped):
            ix = max(0.0, min(a["x2"], k["x2"]) - max(a["x1"], k["x1"]))
            iy = max(0.0, min(a["y2"], k["y2"]) - max(a["y1"], k["y1"]))
            inter = ix * iy
            if inter and inter / min(a["area"], k["area"]) >= 0.9:
                dup_at = i
                break
        if dup_at < 0:
            deduped.append(a)
        elif _fv_semantic_weight(a["e"]) > _fv_semantic_weight(deduped[dup_at]["e"]):
            deduped[dup_at] = a  # 后来者语义更强 → 顶替占位的弱语义壳
    return [a["e"] for a in deduped]


def _fv_dump_composition(elements, kept_indices, vw, vh):
    """诊断转储(校准用):把这一帧【全部】元素的明细 + 是否被剪枝保留 落盘,供按真实数据校准 R3/R4
    阈值。落点:<FAN_HOME>/find-visual/composition-<时分秒>.json。失败静默。"""
    try:
        import json as _jc
        import os as _oc
        import time as _tc
        base = _find_visual_dir()
        _oc.makedirs(base, exist_ok=True)
        vp_area = (float(vw) * float(vh)) if (vw and vh) else 0.0
        rows = []
        for e in (elements or []):
            if not isinstance(e, dict):
                continue
            r = e.get("rect") if isinstance(e.get("rect"), dict) else {}
            try:
                w = float(r.get("width", 0) or 0); h = float(r.get("height", 0) or 0)
            except (TypeError, ValueError):
                w = h = 0.0
            a = e.get("attributes") if isinstance(e.get("attributes"), dict) else {}
            rows.append({
                "index": e.get("index"), "tag": e.get("tag"), "role": e.get("role"),
                "type": a.get("type"), "w": round(w, 1), "h": round(h, 1), "area": round(w * h, 1),
                "vp_frac": round((w * h / vp_area), 4) if vp_area else None,
                "has_text": bool(str(e.get("text") or "").strip()),
                "kept": e.get("index") in kept_indices,
            })
        out = {"ts": _tc.strftime("%Y-%m-%dT%H:%M:%S"), "viewport": [vw, vh],
               "total": len(rows), "kept": sum(1 for x in rows if x["kept"]),
               "oversize_frac": _FV_OVERSIZE_VIEWPORT_FRAC, "rows": rows}
        with open(_oc.path.join(base, f"composition-{_tc.strftime('%H%M%S')}.json"), "w", encoding="utf-8") as f:
            _jc.dump(out, f, ensure_ascii=False, indent=1)
    except Exception:
        pass



def find_visual(args, _fv_attempt=0, *, deps, **kw):
    """Locate and optionally click an unlabeled icon in one frozen snapshot."""
    args = args or {}
    desc = str(args.get("description") or args.get("query") or args.get("target") or "").strip()
    if not desc:
        return deps.tool_error("description required, for example browser_find_visual(description='Send button')")
    want_click = args.get("click", args.get("then_click", True))
    import asyncio
    import base64
    import json as _json
    import os
    import re
    import tempfile
    # 1. 冻结一份观测拿到元素+rect → 拍【纯】截图(includeHighlights=False,不注入 DOM,杜绝页面闪框)→
    #    Python 在截图图片上画编号框。。
    #    click 解析的 selectorMap 与这次 observe 同一份(中途不再 observe),序号不重洗。
    obs = deps.call("observe", {}, **kw)
    elements = obs.get("elements") if isinstance(obs, dict) else None
    # 注意:裁切锚点用【完整】elements 找输入框(它常是发送键的容器,会被剪枝剪掉,不能用剪枝集找)。
    # 画框前剪枝放到拿到视口尺寸之后做(R4 丢超大容器需要 iw/ih),见下方 paint_elements。
    shot = deps.call("screenshot", {"format": "png", "includeHighlights": False, "captureBeyondViewport": False}, **kw)
    if isinstance(shot, dict) and shot.get("__error__"):
        details = shot.get("__error_details__")
        return deps.tool_error(
            deps.enrich_error(shot["__error__"], details),
            code=shot.get("__error_code__"),
            retryable=details.get("retryable") if isinstance(details, dict) else None,
            details=details,
        )
    data = shot.get("data") if isinstance(shot, dict) else None
    if not data:
        return deps.tool_error("visual find: screenshot failed")
    img_bytes = base64.b64decode(data)
    sx, sy, iw, ih = deps.observation_viewport(obs, kw)
    # 画框前【标准化剪枝】(R1 几何门 / R4 丢超大容器 / R2 去嵌套留叶子 / R3 去重),把 100+ 嵌套
    # 候选压成人眼可辨的"独立可操作目标"集;不剪则噪声淹没真目标。find_visual 全贴号(filter_labels=False)。
    paint_elements = deps.prune_for_paint(elements, iw, ih)
    deps.dump_composition(elements, {e.get("index") for e in paint_elements if isinstance(e, dict)}, iw, ih)
    painted = deps.paint_index_boxes(img_bytes, paint_elements, sx, sy, iw, filter_labels=False)
    if painted is not None:
        img_bytes = painted
    else:
        # Pillow 不可用 → 回落到注入式带框截图(会闪一下,但保证功能)
        deps.call("highlight", {}, **kw)
        shot2 = deps.call("screenshot", {"format": "png", "includeHighlights": True, "captureBeyondViewport": False}, **kw)
        deps.call("highlight", {"clear": True}, **kw)
        d2 = shot2.get("data") if isinstance(shot2, dict) else None
        if d2:
            img_bytes = base64.b64decode(d2)
    # 1b. 聚焦裁切:文本脑刚把字打进主输入框,发送/动作键就在它周边。从本次 observe 的 elements 里找
    #     【最大的可编辑框】(contenteditable/textarea/input-text)当锚点,把带框图裁到它周边喂给 qwen,
    #     去掉促销弹窗/侧栏/远处卡片等干扰(qwen 无任务上下文、易抓最显眼的 CTA——实测它把"立即体验"
    #     促销按钮当成了发送键)。不依赖 activeElement(observe/截图可能弄丢焦点)。无可编辑框则用整图。
    cropped = False
    try:
        if iw:
            best = None
            for e in (elements or []):
                if not isinstance(e, dict):
                    continue
                a = e.get("attributes") or {}
                tag = str(e.get("tag") or "")
                editable = (tag == "textarea"
                            or (a.get("contenteditable") not in (None, "false", False))
                            or (tag == "input" and str(a.get("type", "text")).lower() in ("", "text", "search")))
                r = e.get("rect") if isinstance(e.get("rect"), dict) else None
                if editable and r and float(r.get("width", 0)) > 120 and float(r.get("height", 0)) > 0:
                    area = float(r["width"]) * float(r.get("height", 1))
                    if best is None or area > best[0]:
                        best = (area, r)
            if best:
                from PIL import Image as _Img9
                import io as _io9
                _W = _Img9.open(_io9.BytesIO(img_bytes)).size[0]
                scale = _W / iw
                r = best[1]
                fl = float(r.get("left", r.get("x", 0)))
                ft = float(r.get("top", r.get("y", 0)))
                fw = float(r.get("width", 0))
                fh = float(r.get("height", 0))
                cb = deps.crop_png_region(
                    img_bytes,
                    (fl - sx - 60) * scale, (ft - sy - 80) * scale,
                    (fl + fw - sx + 130) * scale, (ft + fh - sy + 140) * scale,
                )
                if cb:
                    img_bytes = cb
                    cropped = True
    except Exception:
        pass
    # 2. 写临时 PNG 交给视觉模型(vision_analyze_tool 只收 URL/文件路径)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    ans = ""
    vision_ok = False
    try:
        tmp.write(img_bytes)
        tmp.close()
        anchor = " (cropped around the input field where text was just entered)" if cropped else ""
        prompt = (
            f"This is a screenshot of the current webpage{anchor}. Every interactive "
            "element has a numbered box; that number is the element's [index].\n"
            f"Locate this target in the image: {desc}\n"
            "Hint: action icons such as Send or Submit are commonly arrows or paper "
            "planes at the right, bottom-right, or inside the main input. Ignore ads, "
            "promotional popups, banners, and unrelated prominent CTA buttons such as "
            "Try Now.\nReply only with the number inside the target's box, for example "
            "680, and no other text or explanation. If the image truly has no such "
            "element, reply only with NONE."
        )
        from tools.vision_tools import vision_analyze_tool
        raw = asyncio.run(vision_analyze_tool(image_url=tmp.name, user_prompt=prompt))
        if isinstance(raw, str):
            try:
                _parsed = _json.loads(raw)
                ans = (_parsed.get("analysis") or "").strip()
                vision_ok = _parsed.get("success") is not False
                if _parsed.get("success") is False:  # qwen 业务失败(配额/超时/不支持)
                    vision_ok = False
            except Exception:
                ans = raw.strip()
                vision_ok = bool(ans)
    except Exception as ex:  # noqa: BLE001
        return deps.tool_error(
            f"visual find failed: {ex}",
            code="VISION_ANALYSIS_FAILED",
            retryable=False,
            details={"reason": "vision-request-failed"},
        )
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    deps.debug_dump(img_bytes, desc, ans, {"elements": len(elements or []), "painted": len(paint_elements or []), "cropped": cropped})  # 探针:存带框图+qwen回答(含剪枝前后数量)
    # 3. 解析 index
    # 修#3:qwen 调用本身失败时,vision_analyze_tool 返回的是 {success:false, analysis:"...Error: 402"}——
    #      绝不能把错误文案里的数字(HTTP 码等)当 index 去点。先看 success。
    if not vision_ok:
        return deps.tool_error(
            "The visual provider is unavailable for this browser turn.",
            code="VISION_PROVIDER_UNAVAILABLE",
            retryable=False,
            details={"reason": "vision-provider-request-failed"},
        )
    if not ans or ans.strip().lower().startswith("none"):
        return deps.tool_result({"found": False, "query": desc, "vision_said": ans[:160]})
    # 合法 index 全集 = 本次【画到图上的(剪枝后)叶子】元素——视觉模型只看得到这些,
    # 越界/幻觉(回了个没画出来的号)一律拦。
    valid = {int(e.get("index")) for e in (paint_elements or [])
             if isinstance(e, dict) and isinstance(e.get("index"), int)}
    # 修#4:qwen 不只回数字时别盲取第一个数字。纯数字走快路;否则抽全部数字 ∩ 合法集,唯一命中才取。
    s = ans.strip()
    index = None
    if s.isdigit():
        index = int(s)
    else:
        cands = [int(n) for n in re.findall(r"\d+", ans)]
        hits = [n for n in cands if n in valid] if valid else cands
        if len(set(hits)) == 1:
            index = hits[0]
    if index is None:
        return deps.tool_result({"found": False, "query": desc, "vision_said": ans[:160],
                            "reason": "Could not reliably identify a unique box number from the vision response."})
    # 修#5/#13:号必须真实存在于本次快照,否则=越界/幻觉。直接 not_found,绝不交给 click 触发隐式
    #          re-observe 重洗序号(那会毁掉"看与点同一快照"的承诺,可能静默点到无关元素)。
    if valid and index not in valid:
        return deps.tool_result({"found": False, "query": desc, "index_seen": index, "vision_said": ans[:160],
                            "reason": f"The vision model returned {index}, which is not an interactive element in this snapshot and is therefore out of range or hallucinated."})
    if not want_click:
        return deps.tool_result({"found": True, "index": index, "query": desc, "vision_said": ans[:160]})
    # 4. 同一份快照里当场点(中间没有再 observe,序号未重洗 → 与画框时一致)
    click_res = deps.call("click", {"index": index}, **kw)
    try:  # 探针:点击结果/报错也落盘(诊断"点击事件报错")
        import json as _j5
        import os as _os5
        import time as _t5
        _b5 = deps.find_visual_dir()
        with open(_os5.path.join(_b5, "find-visual-log.jsonl"), "a", encoding="utf-8") as _f5:
            _f5.write(_j5.dumps({"ts": _t5.strftime("%H:%M:%S"), "clicked_index": index,
                                 "click_result": str(click_res)[:500]}, ensure_ascii=False) + "\n")
    except Exception:
        pass
    if isinstance(click_res, dict) and click_res.get("__error__"):
        err = str(click_res.get("__error__"))
        if _fv_attempt == 0 and ("stale" in err or "could not be resolved" in err or "not available" in err):
            # 竞态自愈(架构 Layer 2 报错自愈):"观察→视觉思考"的 1-2 秒间隙里,忙碌的 React 页
            # 可能重渲染、元素换代,点击解析失败。用【同一条主路径】完整重跑一次(新观测→新画框→
            # 新选号→新点击),就像人"再看一眼、再点一次"。有界(仅一次),绝不降级到别的路径;
            # 第二次仍失败则如实报错。
            return deps.retry(args, 1, kw)
    healed = deps.heal_or_error(click_res, kw)
    if healed is not None:
        return healed
    return deps.result_with_fresh_observation({
        "found": True, "index": index, "query": desc, "vision_said": ans[:160],
        "clicked": index, "result": click_res,
    }, kw)



