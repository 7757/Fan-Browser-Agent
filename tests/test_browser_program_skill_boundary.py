from __future__ import annotations

from pathlib import Path

from agent import prompt_builder
from agent.skill_utils import extract_skill_conditions, parse_frontmatter


ROOT = Path(__file__).resolve().parents[1]
BROWSER_SKILLS = (
    "browser-anti-bot-etiquette",
    "browser-dropdown-selection",
    "browser-element-inspection",
    "browser-file-upload",
    "browser-form-filling",
    "browser-iframe-shadow-dom",
    "browser-pdf-handling",
    "browser-programming",
    "browser-scroll-recovery",
)


def test_program_mode_does_not_offer_browser_contract_skills() -> None:
    for name in BROWSER_SKILLS:
        content = (
            ROOT / "skills" / "browser" / name / "SKILL.md"
        ).read_text(encoding="utf-8")
        frontmatter, _body = parse_frontmatter(content)
        conditions = extract_skill_conditions(frontmatter)

        assert "browser_program" in conditions["fallback_for_toolsets"], name
        assert not prompt_builder._skill_should_show(
            conditions,
            {"browser_snapshot", "browser_run", "browser_handoff"},
            {"browser_program"},
        ), name


def test_program_mode_skill_index_keeps_non_browser_skills(
    monkeypatch,
) -> None:
    skills_dir = ROOT / "skills"
    monkeypatch.setattr(prompt_builder, "get_skills_dir", lambda: skills_dir)
    monkeypatch.setattr(
        prompt_builder,
        "get_all_skills_dirs",
        lambda: [skills_dir],
    )
    monkeypatch.setattr(
        prompt_builder,
        "get_disabled_skill_names",
        lambda _platform=None: set(),
    )
    monkeypatch.setattr(prompt_builder, "_load_skills_snapshot", lambda _root: None)
    monkeypatch.setattr(
        prompt_builder,
        "_write_skills_snapshot",
        lambda *_args, **_kwargs: None,
    )
    prompt_builder.clear_skills_system_prompt_cache()

    prompt = prompt_builder.build_skills_system_prompt(
        available_tools={
            "browser_snapshot",
            "browser_run",
            "browser_handoff",
            "skill_view",
        },
        available_toolsets={"browser_program", "skills"},
    )

    for name in BROWSER_SKILLS:
        assert f"- {name}:" not in prompt
    assert "- plan:" in prompt


def test_legacy_browser_skills_remain_available_without_program_mode() -> None:
    legacy_skills = set(BROWSER_SKILLS) - {
        "browser-dropdown-selection",
        "browser-programming",
    }
    for name in legacy_skills:
        content = (
            ROOT / "skills" / "browser" / name / "SKILL.md"
        ).read_text(encoding="utf-8")
        frontmatter, _body = parse_frontmatter(content)

        assert prompt_builder._skill_should_show(
            extract_skill_conditions(frontmatter),
            {"browser_observe", "browser_click"},
            {"electron_browser"},
        ), name


def test_skills_policy_prefers_native_contract_and_keeps_self_learning(
    monkeypatch,
    tmp_path: Path,
) -> None:
    skills_dir = tmp_path / "skills"
    skill_dir = skills_dir / "general" / "example"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: example\n"
        "description: Example task-specific workflow.\n"
        "---\n"
        "# Example\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(prompt_builder, "get_skills_dir", lambda: skills_dir)
    monkeypatch.setattr(
        prompt_builder,
        "get_all_skills_dirs",
        lambda: [skills_dir],
    )
    monkeypatch.setattr(
        prompt_builder,
        "get_disabled_skill_names",
        lambda _platform=None: set(),
    )
    monkeypatch.setattr(prompt_builder, "_load_skills_snapshot", lambda _root: None)
    monkeypatch.setattr(
        prompt_builder,
        "_write_skills_snapshot",
        lambda *_args, **_kwargs: None,
    )
    prompt_builder.clear_skills_system_prompt_cache()

    prompt = prompt_builder.build_skills_system_prompt(
        available_tools={"browser_snapshot", "browser_run", "skill_view"},
        available_toolsets={"browser_program", "skills"},
    )

    assert "explicitly names a skill" in prompt
    assert "clearly and materially relevant" in prompt
    assert "active native tool contract" in prompt
    assert "even partially relevant" not in prompt
    assert "always better to have context" not in prompt
    assert "After difficult/iterative tasks, offer to save as a skill." in prompt
    assert "skill_manage(action='patch')" in prompt


def test_program_prompt_documents_the_real_targeted_scroll_signature() -> None:
    prompt = (ROOT / "browser_program_agent.md").read_text(encoding="utf-8")

    assert "fan.scroll(target?, {down?, up?, pages?, timeoutMs?})" in prompt
    assert "fan.scroll(fan.ref(16), {down: true, pages: 1.5})" in prompt
    assert "fan.scroll({up: true, pages: 1})" in prompt
    assert "互相冲突的 `up` 和 `down`" in prompt
    assert "options 的 `target` 或 `index` 字段" in prompt
    assert (
        "fan.waitForElement(query, {timeoutMs?, pollMs?, description?})"
        in prompt
    )
    assert (
        "fan.waitForState(target, {attached?, enabled?}, "
        "{timeoutMs?, pollMs?, description?})"
        in prompt
    )
    assert "事务末尾不要追加等待" in prompt


def test_program_prompt_explains_element_arrays_and_direct_wait_targets() -> None:
    prompt = (ROOT / "browser_program_agent.md").read_text(encoding="utf-8")

    assert "每次 `browser_run` 都启动全新的隔离 JavaScript 作用域" in prompt
    assert "保留到下一条调用" in prompt
    assert "不是自动注入的全局变量" in prompt
    assert "const snapshot = await fan.observe()" in prompt
    assert "直接使用 `fan.ref(N)`，不必为此额外观察" in prompt
    assert "`snapshot.elements` 是普通数组" in prompt
    assert "`[N]` 等于元素对象的 `element.index`，不是数组下标" in prompt
    assert "绝不能写 `snapshot.elements[N]`" in prompt
    assert "`role`、`name`/`text` 和明确的 `attributes`" in prompt
    assert '`attributes["aria-label"]`、`value`、`text` 和顶层 `disabled`' in prompt
    assert "`option`、`gridcell`、`cell` 或 `td`" in prompt
    assert "`element.disabled !== true`" in prompt
    assert "const input = await fan.waitForState" in prompt
    assert "fan.waitForState(fan.ref(N), {attached: false})" in prompt
    assert "不要用角色查询重新寻找这个已知编号" in prompt
    assert "const input = await fan.waitForElement" in prompt
    assert "await fan.type(input, \"Ready\", {clear: true})" in prompt
    assert "它不接受函数回调" in prompt
    assert "零匹配会在时限内继续观察" in prompt
    assert "多匹配或超时安全返回 `needs_replan`" in prompt
    assert "标签变化由 `fan.click` 内部等待" in prompt
    assert "点击后直接 `await fan.tabs()`" in prompt
    assert "`openedTab`" in prompt
    assert "fan.waitFor(" not in prompt
    assert "fan.waitForSnapshot" not in prompt
    assert "事务收尾不用观察" in prompt


def test_program_prompt_exposes_autocomplete_semantics_without_loading_a_skill() -> None:
    prompt = (ROOT / "browser_program_agent.md").read_text(encoding="utf-8")

    assert "autocomplete.detected=true" in prompt
    assert "autocomplete_kind=..." in prompt
    assert "fan.formSubmit` 只用于" in prompt
    assert "不得假定 `role=option`" in prompt
    assert "`fan.type` 会为候选更新留出短暂等待窗口" in prompt
    assert "它不会替你选择候选" in prompt
    assert "也不保证候选必然出现" in prompt
    assert "内部等待候选呈现" not in prompt
    assert "const candidatesPage = await fan.observe()" in prompt
    assert "candidatesPage.elements.filter" in prompt
    assert 'actual.includes("microsoft corporation")' in prompt
    assert 'actual.includes("msft")' in prompt
    assert 'actual.includes("0000789019")' in prompt
    assert "不得根据输入词猜一个完整候选文本" in prompt
    assert "只有候选的精确、稳定字段" in prompt
    assert 'fan.waitForElement({id: "company-MSFT"})' in prompt
    assert "await fan.click(suggestion)" in prompt
    assert "const selectedPage = await fan.observe()" in prompt
    assert "selectedPage.url !== sourceTab.url" in prompt
    assert "await fan.click(submit)" in prompt


def test_program_docs_pin_settle_and_cross_tab_text_contracts() -> None:
    prompt = (ROOT / "browser_program_agent.md").read_text(encoding="utf-8")
    api = (
        ROOT
        / "skills"
        / "browser"
        / "browser-programming"
        / "references"
        / "api.md"
    ).read_text(encoding="utf-8")

    for document in (prompt, api):
        assert "fan.settle({timeoutMs?, networkIdleMs?})" in document
        assert "fan.settle(options?)" not in document
        assert "timeout_ms" in document
        assert "network_idle_ms" in document
        assert "`snapshot.text`" in document
        assert 'String(snapshot.text || "")' in document
        assert "const sourceTab = fan.requireUnique" in document
        assert "await fan.newTab(" in document
        assert "await fan.switchTab(sourceTab.stableId)" in document
        assert "snapshot = await fan.observe()" in document

    assert "不要跨标签复用旧编号" in prompt
    assert "never reuse the old number across tabs" in api


def test_program_prompt_uses_numbered_inner_iframe_editors_without_blind_keys() -> None:
    prompt = (ROOT / "browser_program_agent.md").read_text(encoding="utf-8")

    assert "iframe 内带编号的" in prompt
    assert "`contenteditable`/`textbox`" in prompt
    assert "不要把外层 `<iframe>` 编号当作输入框" in prompt
    assert "不得靠盲发按键假装完成" in prompt
    assert "文字输入优先使用带编号目标的 `fan.type`" in prompt
    assert "不要把一句话拆成" in prompt


def test_program_prompt_documents_unrestricted_local_upload_paths() -> None:
    prompt = (ROOT / "browser_program_agent.md").read_text(encoding="utf-8")

    assert "`files` 必须是现有非空普通文件的路径数组" in prompt
    assert "可来自任意本地目录" in prompt
    assert "传入已解析的绝对路径" in prompt
    assert "`~/` 可展开" in prompt
    assert "不承诺其他相对路径" in prompt
    assert "不要为了上传而把文件复制到 Downloads" in prompt


def test_program_docs_define_the_screenshot_to_vision_handoff() -> None:
    prompt = (ROOT / "browser_program_agent.md").read_text(encoding="utf-8")
    api = (
        ROOT
        / "skills"
        / "browser"
        / "browser-programming"
        / "references"
        / "api.md"
    ).read_text(encoding="utf-8")

    for document in (prompt, api):
        assert 'fan.saveScreenshot({fileName: "captcha.png"})' in document
        assert "shot.path" in document
        assert "shot.fileName" in document
        assert "shot.format" in document
        assert "visual" in document.lower() or "视觉" in document
        assert "image_url" in document
        assert "bare filename" in document or "安全裸文件名" in document
        assert "绝对路径" in document or "absolute path" in document

    assert "下一轮必须把返回的 `screenshotPath` 原样传给" in prompt
    assert "不要猜 Downloads" in prompt
    assert "pass the returned `screenshotPath` unchanged" in api


def test_program_skill_reference_matches_element_and_wait_contract() -> None:
    skill = (
        ROOT / "skills" / "browser" / "browser-programming" / "SKILL.md"
    ).read_text(encoding="utf-8")
    api = (
        ROOT
        / "skills"
        / "browser"
        / "browser-programming"
        / "references"
        / "api.md"
    ).read_text(encoding="utf-8")

    for document in (skill, api):
        assert "fresh isolated JavaScript scope" in document
        assert "no earlier local `snapshot`" in document or (
            "a local named `snapshot` from an earlier call do not" in document
        )
        assert "const snapshot = await fan.observe()" in document
        assert "`snapshot.elements` is an ordinary array" in document
        assert "`element.index`" in document
        assert "not an array offset" in document
        assert "`snapshot.elements[N]`" in document
        assert "role: \"textbox\"" in document
        assert "const input = await fan.waitForState" in document
        assert "same number" in document or "broad role query" in document
        assert "const input = await fan.waitForElement" in document or (
            "const option = await fan.waitForElement" in document
        )
        assert "fan.waitFor(" not in document
        assert "fan.waitForSnapshot" not in document
        assert "declarative exact" in document
        assert "no function callback" in document or "not a callback" in document
        assert "multiple matches" in document
        assert "`needs_replan`" in document
        assert "then call `fan.tabs()` directly" in document
        assert "already-bound element" in document
        assert "`contenteditable`/`textbox`" in document
        assert "numbered" in document and "inner" in document
        assert "outer" in document and "iframe" in document
        assert "blind" in document


def test_program_skill_reference_matches_upload_path_contract() -> None:
    skill = (
        ROOT / "skills" / "browser" / "browser-programming" / "SKILL.md"
    ).read_text(encoding="utf-8")
    api = (
        ROOT
        / "skills"
        / "browser"
        / "browser-programming"
        / "references"
        / "api.md"
    ).read_text(encoding="utf-8")

    for document in (skill, api):
        for root in ("Downloads", "Documents", "Desktop"):
            assert root in document
        assert "absolute path" in document.lower()
        assert "`~/`" in document
        assert "expanded" in document
        assert "temporary upload" in document.lower()
        assert "`/tmp`" in document
