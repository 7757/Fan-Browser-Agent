from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_browser_prompt_requires_one_transaction_for_known_multi_field_steps() -> None:
    prompt = (ROOT / "browser_agent.md").read_text(encoding="utf-8")
    rule = next(line for line in prompt.splitlines() if line.startswith("2. 浏览器工具"))

    assert "2 个及以上" in rule
    assert "不要求属于同一个 HTML form" in rule
    assert "同一助手回复必须只发一次 `browser_fill_form`" in rule
    assert "禁止并列或串列多个 `browser_type`" in rule
    assert "依赖前一个输入产生的新页面状态" in rule


def test_browser_prompt_allows_one_adjacent_click_for_a_stable_form() -> None:
    prompt = (ROOT / "browser_agent.md").read_text(encoding="utf-8")
    rule = next(line for line in prompt.splitlines() if line.startswith("2. 浏览器工具"))

    assert "普通稳定表单" in rule
    assert "同一份最新观察里都已经存在且可用" in rule
    assert "不会依赖本次输入才出现、启用或改变" in rule
    assert "同一助手回复里先发一次 `browser_type` 或 `browser_fill_form`" in rule
    assert "随后紧跟一次基于原索引的 `browser_click`" in rule
    assert "不要插入观察、等待或其它工具" in rule
    assert "运行时会在点击前核验目标" in rule


def test_browser_prompt_allows_live_validated_same_snapshot_actions() -> None:
    prompt = (ROOT / "browser_agent.md").read_text(encoding="utf-8")
    rule = next(line for line in prompt.splitlines() if line.startswith("2. 浏览器工具"))

    assert "多个下拉选择/点击目标" in rule
    assert "可以在同一助手回复中按顺序发出这些原索引动作" in rule
    assert "每一步执行前重新核验决策状态、元素身份、连接状态与禁用状态" in rule
    assert "任一步发生导航、标签切换、元素失效或失败就停止剩余动作" in rule
    assert "最后一步才返回完整新观察" in rule


def test_browser_prompt_requires_a_new_observation_for_dynamic_forms() -> None:
    prompt = (ROOT / "browser_agent.md").read_text(encoding="utf-8")
    rule = next(line for line in prompt.splitlines() if line.startswith("2. 浏览器工具"))

    assert "联级字段" in rule
    assert "`combobox`" in rule
    assert "自动补全" in rule
    assert "建议下拉" in rule
    assert "按钮会在输入后才出现、启用或改变" in rule
    assert "本轮只输入" in rule
    assert "必须根据输入工具返回的新观察再决定下一步" in rule
    assert "下一轮再从新索引提交" not in rule


def test_browser_prompt_reads_exact_native_select_options_before_selection() -> None:
    prompt = (ROOT / "browser_agent.md").read_text(encoding="utf-8")
    rule = next(line for line in prompt.splitlines() if line.startswith("13. "))

    assert "不要概括或猜测选项名称" in rule
    assert "browser_dropdown_options" in rule
    assert "DROPDOWN_OPTION_NOT_FOUND" in rule
    assert "再次调用 `browser_select`" in rule


def test_browser_prompt_preflights_availability_before_collecting_personal_data() -> None:
    prompt = (ROOT / "browser_agent.md").read_text(encoding="utf-8")
    rule = next(line for line in prompt.splitlines() if line.startswith("19. "))

    assert "先做可办理性预检" in rule
    assert "放号时间" in rule
    assert "日历日期全部带 `disabled`" in rule
    assert "停止点击和收集" in rule
    assert "枚举当前步骤页面上全部必填字段及其选项/格式约束" in rule
    assert "一次完整放入同一个 `collect`" in rule
    assert "不得只问眼前一个字段" in rule
    assert "date_range" in rule
    assert "禁止用普通问题或文本框让用户手输" in rule
