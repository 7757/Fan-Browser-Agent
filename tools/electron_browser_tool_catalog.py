"""Electron browser tool schemas and registry wiring."""


def register_electron_browser_tools(registry, handlers, check_fn, check_visual_fn):
    registry.register(
        name="browser_observe",
        toolset="electron_browser",
        schema={
            "name": "browser_observe",
            "description": "Electron-native browser runtime: get indexed interactive elements from the visible workbench.",
            "parameters": {
                "type": "object",
                "properties": {
                    "includeSnapshot": {
                        "type": "boolean",
                        "description": "Include CDP DOMSnapshot-backed elements when available.",
                    },
                    "includeAccessibility": {
                        "type": "boolean",
                        "description": "Include CDP Accessibility tree enrichment when available.",
                    },
                    "includeTargets": {
                        "type": "boolean",
                        "description": "Include attached CDP page/iframe target observations when available.",
                    },
                    "include_pending_network_requests": {
                        "type": "boolean",
                        "description": "Include currently pending network requests in state. Defaults to true.",
                    },
                    "includePendingNetworkRequests": {"type": "boolean"},
                    "pending_network_limit": {"type": "integer"},
                    "pendingNetworkLimit": {"type": "integer"},
                    "include_recent_events": {
                        "type": "boolean",
                        "description": "Include recent runtime events in state, matching Browser Use's include_recent_events option.",
                    },
                    "includeRecentEvents": {"type": "boolean"},
                    "recent_event_limit": {"type": "integer"},
                    "recentEventLimit": {"type": "integer"},
                    "dom_format": {
                        "type": "string",
                        "enum": ["electron", "browser_use"],
                        "default": "browser_use",
                        "description": "DOM text format. The default browser_use format matches Browser-Use serialize_tree and is cleaner while retaining id and role. Use electron for the legacy enhanced rich format.",
                    },
                    "domFormat": {
                        "type": "string",
                        "enum": ["electron", "browser_use"],
                        "description": "CamelCase alias for dom_format.",
                    },
                    "include_screenshot": {
                        "type": "boolean",
                        "description": "Also return a current page screenshot as multimodal content alongside the DOM observation.",
                    },
                    "includeScreenshot": {
                        "type": "boolean",
                        "description": "CamelCase alias for include_screenshot.",
                    },
                    "highlight_screenshot": {
                        "type": "boolean",
                        "description": "When include_screenshot is true, temporarily overlay indexed element boxes before capture.",
                    },
                    "highlightScreenshot": {
                        "type": "boolean",
                        "description": "CamelCase alias for highlight_screenshot.",
                    },
                    "highlight_limit": {
                        "type": "integer",
                        "description": "Maximum indexed elements to overlay in a highlighted screenshot.",
                    },
                    "highlightLimit": {"type": "integer"},
                    "highlight_color": {
                        "type": "string",
                        "description": "CSS color used for highlighted screenshot element boxes.",
                    },
                    "highlightColor": {"type": "string"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_observe"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_search_page",
        toolset="electron_browser",
        schema={
            "name": "browser_search_page",
            "description": "Electron-native browser runtime: search visible page text for a literal string or regex, with surrounding context. Zero LLM cost.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "query": {"type": "string"},
                    "regex": {"type": "boolean"},
                    "case_sensitive": {"type": "boolean"},
                    "caseSensitive": {"type": "boolean"},
                    "context_chars": {"type": "integer"},
                    "contextChars": {"type": "integer"},
                    "css_scope": {"type": "string", "description": "Optional CSS selector to limit the search scope."},
                    "cssScope": {"type": "string"},
                    "max_results": {"type": "integer"},
                    "maxResults": {"type": "integer"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_search_page"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_find_elements",
        toolset="electron_browser",
        schema={
            "name": "browser_find_elements",
            "description": "Electron-native browser runtime: query DOM elements by CSS selector and return tag, text, attributes, child counts, and an actionable index only when the match maps to the current selector snapshot. `match_ordinal` is read-only and must never be clicked. Zero LLM cost.",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "attributes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional attributes to return, e.g. href, src, class.",
                    },
                    "max_results": {"type": "integer"},
                    "maxResults": {"type": "integer"},
                    "include_text": {"type": "boolean"},
                    "includeText": {"type": "boolean"},
                },
                "required": ["selector"],
            },
        },
        handler=handlers["_browser_find_elements"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_find_visual",
        toolset="electron_browser",
        schema={
            "name": "browser_find_visual",
            "description": (
                "Visually locate and click a pure icon control when its [index] cannot "
                "be identified from the element list alone, such as an unlabeled Send "
                "or Submit arrow, Search, Attach, Microphone, Menu, Close, Like, or "
                "Settings button. Supply a natural-language target description. The "
                "vision model locates it on a full-page screenshot with numbered boxes "
                "and clicks it immediately within the same snapshot, returning "
                "{found,index,clicked,dom}. Do not call browser_click separately on the "
                "returned index: dynamic-page indices are regenerated on each capture "
                "and may be stale. Only this tool sees and clicks within the same "
                "snapshot. Pass click=false to locate without clicking."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "Natural-language description of the icon control, such as 'Send message button', 'Search button', or 'Close popup icon'.",
                    },
                    "click": {
                        "type": "boolean",
                        "description": "Whether to click immediately after locating it; defaults to true. Pass false to return only {found,index}.",
                    },
                },
                "required": ["description"],
            },
        },
        handler=handlers["_browser_find_visual"],
        check_fn=check_visual_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_page_content",
        toolset="electron_browser",
        schema={
            "name": "browser_page_content",
            "description": "Electron-native browser runtime: extract current page content as markdown, html, or text with optional link/image preservation and chunking. Zero LLM cost.",
            "parameters": {
                "type": "object",
                "properties": {
                    "format": {"type": "string", "enum": ["markdown", "html", "text"]},
                    "extract_links": {"type": "boolean"},
                    "extractLinks": {"type": "boolean"},
                    "extract_images": {"type": "boolean"},
                    "extractImages": {"type": "boolean"},
                    "start_from_char": {"type": "integer"},
                    "startFromChar": {"type": "integer"},
                    "max_chars": {"type": "integer"},
                    "maxChars": {"type": "integer"},
                    "overlap_lines": {"type": "integer", "description": "Number of previous chunk lines to prepend for continuation context."},
                    "overlapLines": {"type": "integer"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_page_content"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_search",
        toolset="electron_browser",
        schema={
            "name": "browser_search",
            "description": "Electron-native browser runtime: search the web by navigating to a search engine results page. Defaults to the configured engine (Baidu on fresh installs).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "engine": {
                        "type": "string",
                        "enum": ["bing", "baidu", "google", "duckduckgo"],
                        "description": "Search engine. Defaults to the configured engine (Baidu on fresh installs).",
                    },
                },
                "required": ["query"],
            },
        },
        handler=handlers["_browser_search"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_navigate",
        toolset="electron_browser",
        schema={
            "name": "browser_navigate",
            "description": (
                "Electron-native browser runtime: navigate the visible workbench to a URL "
                "(including localhost, private LAN, and local file:// pages) and return its "
                "DOM once the requested page is usable by default. Cloud metadata and "
                "protected local credential files remain blocked."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "wait_until": {
                        "type": "string",
                        "enum": ["settle", "load", "none"],
                        "default": "load",
                        "description": (
                            "how long to wait before returning: load (default; requested "
                            "document committed, ready, and briefly stable without requiring "
                            "network idle), settle (load plus bounded DOM/network idle), none "
                            "(return immediately)"
                        ),
                    },
                    "wait_timeout_ms": {
                        "type": "integer",
                        "description": (
                            "hard wait budget in ms (default 30000) for the page to become "
                            "usable; on timeout returns NAVIGATION_TIMEOUT"
                        ),
                    },
                },
                "required": ["url"],
            },
        },
        handler=handlers["_browser_navigate"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_click",
        toolset="electron_browser",
        schema={
            "name": "browser_click",
            "description": (
                "Electron-native browser runtime: click an indexed element from the "
                "latest observation. For a normal stable form, exactly one indexed "
                "submit/confirm click may immediately follow text entry in the same "
                "assistant response when that control was already present and enabled "
                "in the same latest observation and does not depend on the input to "
                "appear or change. Wait for a new observation before clicking after "
                "dynamic, cascading, combobox, autocomplete, or dropdown input, or "
                "when the target appears, becomes enabled, or changes after input."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "coordinate_x": {"type": "number", "description": "X coordinate normalized to 0-1000 (left=0, right=1000) of the screenshot. Use only when no reliable index is available."},
                    "coordinate_y": {"type": "number", "description": "Y coordinate normalized to 0-1000 (top=0, bottom=1000) of the screenshot. Use only when no reliable index is available."},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "force": {"type": "boolean", "description": "For coordinate clicks, default true mirrors Browser Use. Set false to validate the target element before clicking."},
                    "session_id": {"type": "string", "description": "Optional CDP session id for attached target coordinate clicks."},
                    "allow_occluded": {"type": "boolean", "description": "Allow clicking when another element appears on top."},
                    "expected": {
                        "type": "object",
                        "description": "Optional semantic precondition checked immediately before clicking.",
                        "properties": {
                            "role": {"type": "string"},
                            "name": {"type": "string"},
                            "text": {"type": "string"},
                            "tag": {"type": "string"},
                        },
                    },
                    "expected_role": {"type": "string"},
                    "expected_name": {"type": "string"},
                    "expected_text": {"type": "string"},
                    "expected_tag": {"type": "string"},
                    "visual_evidence_token": {
                        "type": "string",
                        "description": "Evidence token returned by a screenshot of the current page; required for coordinate clicks.",
                    },
                },
                "required": [],
            },
        },
        handler=handlers["_browser_click"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_type",
        toolset="electron_browser",
        schema={
            "name": "browser_type",
            "description": (
                "Enter text into exactly one indexed field when the current page step "
                "needs only that field, or when later fields depend on the new state "
                "created by this input. Never emit multiple calls to this single-field "
                "operation in the same assistant response. On a normal stable form, "
                "immediately follow this operation with exactly one indexed submit/confirm "
                "click in the same assistant response when that control is already present "
                "and enabled in the same latest observation and does not depend on the "
                "input to appear or change; do not insert an observation between them. "
                "For dynamic, cascading, combobox, autocomplete, or dropdown input, or "
                "when the target appears, becomes enabled, or changes after input, wait "
                "for the returned observation before clicking. For an opaque fan-value:// "
                "reference, pass it as value_ref; never decode or copy it into text."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "text": {"type": "string", "description": "Literal text to type."},
                    "value_ref": {
                        "type": "string",
                        "description": "Opaque fan-value:// reference supplied by an interactive response.",
                    },
                    "clear": {"type": "boolean", "description": "Clear the target before typing. Defaults to true."},
                    "typing_mode": {
                        "type": "string",
                        "enum": ["human", "fast", "direct"],
                        "description": "Typing mode. Defaults to human key events; fast uses CDP insertText; direct assigns value for special browser controls.",
                    },
                    "delay_ms": {
                        "type": "number",
                        "description": "Delay between human-mode keystrokes in milliseconds. Defaults to 18.",
                    },
                    "fast": {"type": "boolean", "description": "Compatibility alias for typing_mode=fast."},
                    "autocomplete_wait": {
                        "type": "boolean",
                        "description": "Wait briefly after typing into autocomplete/combobox fields. Defaults true.",
                    },
                    "autocompleteWait": {"type": "boolean"},
                    "autocomplete_wait_ms": {
                        "type": "number",
                        "description": "Autocomplete wait duration in milliseconds. Defaults to 400, capped by the runtime.",
                    },
                    "autocompleteWaitMs": {"type": "number"},
                },
                "required": ["index"],
            },
        },
        handler=handlers["_browser_type"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_fill_form",
        toolset="electron_browser",
        schema={
            "name": "browser_fill_form",
            "description": (
                "Atomically fill all independently editable indexed text fields known "
                "for one page step from the same latest observation; the fields do not "
                "need to share an HTML form. Use this transaction whenever two or more "
                "fields are known, pass every field together, and do not split them into "
                "separate single-field calls. On a normal stable form, immediately follow "
                "this operation with exactly one indexed submit/confirm click in the same "
                "assistant response when that control is already present and enabled in "
                "the same latest observation and does not depend on any input to appear or "
                "change; do not insert an observation between them. For dynamic, cascading, "
                "combobox, autocomplete, or dropdown input, or when the target appears, "
                "becomes enabled, or changes after input, wait for the returned final "
                "observation before clicking."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "fields": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 50,
                        "description": (
                            "All independently editable text fields known from the same "
                            "latest observation. When two or more are known, include every "
                            "one in this array."
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "index": {"type": "integer"},
                                "text": {"type": "string"},
                                "value_ref": {"type": "string"},
                                "clear": {"type": "boolean"},
                                "typing_mode": {"type": "string", "enum": ["human", "fast", "direct"]},
                                "delay_ms": {"type": "number"},
                                "autocomplete_wait": {"type": "boolean"},
                                "autocomplete_wait_ms": {"type": "number"},
                                "expected_label": {"type": "string"},
                                "expected": {
                                    "type": "object",
                                    "properties": {
                                        "role": {"type": "string"},
                                        "name": {"type": "string"},
                                        "text": {"type": "string"},
                                        "tag": {"type": "string"},
                                        "label": {"type": "string"},
                                    },
                                },
                            },
                            "required": ["index"],
                        },
                    },
                },
                "required": ["fields"],
            },
        },
        handler=handlers["_browser_fill_form"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_scroll",
        toolset="electron_browser",
        schema={
            "name": "browser_scroll",
            "description": "Electron-native browser runtime: scroll the visible page or an indexed scrollable element.",
            "parameters": {
                "type": "object",
                "properties": {
                    "down": {"type": "boolean"},
                    "pages": {"type": "number"},
                    "index": {"type": "integer", "description": "Optional indexed scrollable element to scroll."},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_scroll"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_scroll_to_text",
        toolset="electron_browser",
        schema={
            "name": "browser_scroll_to_text",
            "description": "Electron-native browser runtime: scroll the page until visible text is found.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "query": {"type": "string"},
                    "exact": {"type": "boolean"},
                    "case_sensitive": {"type": "boolean"},
                    "caseSensitive": {"type": "boolean"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_scroll_to_text"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_back",
        toolset="electron_browser",
        schema={"name": "browser_back", "description": "Electron-native browser runtime: go back.", "parameters": {"type": "object", "properties": {}, "required": []}},
        handler=handlers["_browser_back"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_forward",
        toolset="electron_browser",
        schema={"name": "browser_forward", "description": "Electron-native browser runtime: go forward.", "parameters": {"type": "object", "properties": {}, "required": []}},
        handler=handlers["_browser_forward"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_reload",
        toolset="electron_browser",
        schema={
            "name": "browser_reload",
            "description": "Electron-native browser runtime: reload the current page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ignore_cache": {"type": "boolean"},
                    "ignoreCache": {"type": "boolean"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_reload"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_send_keys",
        toolset="electron_browser",
        schema={
            "name": "browser_send_keys",
            "description": "Electron-native browser runtime: send text, special keys such as Enter/Tab/Escape, or modifier combos such as Control+a.",
            "parameters": {"type": "object", "properties": {"keys": {"type": "string"}}, "required": ["keys"]},
        },
        handler=handlers["_browser_send_keys"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_select",
        toolset="electron_browser",
        schema={
            "name": "browser_select",
            "description": (
                "Electron-native browser runtime: select an option by its exact visible text "
                "or by a value_ref returned from collect. Do not paraphrase or guess option labels; "
                "call browser_dropdown_options first when the exact label is not visible."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "text": {"type": "string"},
                    "value_ref": {
                        "type": "string",
                        "description": "Opaque fan-value:// reference returned by collect.",
                    },
                },
                "required": ["index"],
            },
        },
        handler=handlers["_browser_select"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_dropdown_options",
        toolset="electron_browser",
        schema={
            "name": "browser_dropdown_options",
            "description": "Electron-native browser runtime: list exact visible options for a native, ARIA, or custom dropdown at an indexed element. Use this before browser_select whenever the observation shows incomplete labels or opaque values. This is read-only and preserves the current DOM indices.",
            "parameters": {"type": "object", "properties": {"index": {"type": "integer"}}, "required": ["index"]},
        },
        handler=handlers["_browser_dropdown_options"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_wait",
        toolset="electron_browser",
        schema={
            "name": "browser_wait",
            "description": "Electron-native browser runtime: wait and observe again.",
            "parameters": {"type": "object", "properties": {"seconds": {"type": "number"}}, "required": []},
        },
        handler=handlers["_browser_wait"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_settle",
        toolset="electron_browser",
        schema={
            "name": "browser_settle",
            "description": "Electron-native browser runtime: wait until document readiness and network idle look stable, then observe again.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timeoutMs": {"type": "integer"},
                    "timeout_ms": {"type": "integer"},
                    "networkIdleMs": {"type": "integer"},
                    "network_idle_ms": {"type": "integer"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_settle"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_cdp",
        toolset="electron_browser",
        schema={
            "name": "browser_cdp",
            "description": "Electron-native browser runtime raw CDP escape hatch.",
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {"type": "string"},
                    "params": {"type": "object"},
                    "session_id": {"type": "string"},
                },
                "required": ["method"],
            },
        },
        handler=handlers["_browser_cdp"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_events",
        toolset="electron_browser",
        schema={
            "name": "browser_events",
            "description": "Electron-native browser runtime: inspect recent runtime events for debugging and Agent event exposure.",
            "parameters": {"type": "object", "properties": {"limit": {"type": "integer"}}, "required": []},
        },
        handler=handlers["_browser_events"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_targets",
        toolset="electron_browser",
        schema={
            "name": "browser_targets",
            "description": "Electron-native browser runtime: inspect tracked CDP targets and attached sessions.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handler=handlers["_browser_targets"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_target_info",
        toolset="electron_browser",
        schema={
            "name": "browser_target_info",
            "description": "Electron-native browser runtime: read Browser Use-style target info for the current page or a tracked app-owned target.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target_id": {"type": "string"},
                    "targetId": {"type": "string"},
                    "tab_id": {"type": "string"},
                    "tabId": {"type": "string"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_target_info"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_new_tab",
        toolset="electron_browser",
        schema={
            "name": "browser_new_tab",
            "description": "Electron-native browser runtime: open a NEW browser tab under this session and switch to it (like opening a tab in a real browser). Optionally load a URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to open in the new tab. Defaults to a blank tab."},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_new_tab"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_switch_tab",
        toolset="electron_browser",
        schema={
            "name": "browser_switch_tab",
            "description": "Electron-native browser runtime: switch the active browser tab to the one with the given tab_id (the index shown in the 'Open tabs' list). Subsequent actions operate on the switched tab.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tab_id": {"type": "string", "description": "The tab id (e.g. t3) shown in the tab list."},
                    "index": {"type": "integer"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_switch_tab"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_close_tab",
        toolset="electron_browser",
        schema={
            "name": "browser_close_tab",
            "description": "Electron-native browser runtime: close the browser tab with the given tab_id (the index shown in the 'Open tabs' list).",
            "parameters": {
                "type": "object",
                "properties": {
                    "tab_id": {"type": "string", "description": "The tab id (e.g. t3) shown in the tab list."},
                    "index": {"type": "integer"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_close_tab"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_dialog",
        toolset="electron_browser",
        schema={
            "name": "browser_dialog",
            "description": "Electron-native browser runtime: answer a JavaScript alert/confirm/prompt dialog.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["accept", "dismiss"]},
                    "prompt_text": {"type": "string"},
                },
                "required": ["action"],
            },
        },
        handler=handlers["_browser_dialog"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_upload",
        toolset="electron_browser",
        schema={
            "name": "browser_upload",
            "description": (
                "Electron-native browser runtime: upload a local file using an "
                "indexed file input. Prefer value_ref/value_refs for paths returned "
                "by collect so local paths stay out of model context and logs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "path": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}},
                    "value_ref": {"type": "string"},
                    "value_refs": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["index"],
            },
        },
        handler=handlers["_browser_upload"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_screenshot",
        toolset="electron_browser",
        schema={
            "name": "browser_screenshot",
            "description": "Electron-native browser runtime: capture a screenshot of the visible page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "format": {"type": "string", "enum": ["png", "jpeg", "webp"]},
                    "captureBeyondViewport": {"type": "boolean"},
                    "capture_beyond_viewport": {"type": "boolean"},
                    "fullPage": {"type": "boolean"},
                    "full_page": {"type": "boolean"},
                    "quality": {"type": "integer"},
                    "index": {"type": "integer", "description": "Optional element index to screenshot."},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "width": {"type": "number"},
                    "height": {"type": "number"},
                    "scale": {"type": "number"},
                    "clip": {"type": "object", "description": "Optional CDP screenshot clip."},
                    "include_highlights": {
                        "type": "boolean",
                        "description": "Preserve existing temporary highlight overlays while capturing the screenshot.",
                    },
                    "includeHighlights": {"type": "boolean"},
                    "path": {"type": "string", "description": "Optional local path to save the screenshot bytes."},
                    "file_name": {"type": "string", "description": "Optional output filename saved in the Electron downloads directory."},
                    "fileName": {"type": "string"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_screenshot"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_save_pdf",
        toolset="electron_browser",
        schema={
            "name": "browser_save_pdf",
            "description": "Electron-native browser runtime: save the current page as a PDF via CDP Page.printToPDF.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_name": {"type": "string", "description": "Output PDF filename. Defaults to the page title."},
                    "fileName": {"type": "string"},
                    "print_background": {"type": "boolean"},
                    "printBackground": {"type": "boolean"},
                    "landscape": {"type": "boolean"},
                    "scale": {"type": "number", "description": "Rendering scale from 0.1 to 2.0."},
                    "paper_format": {"type": "string", "enum": ["Letter", "Legal", "A4", "A3", "Tabloid", "letter", "legal", "a4", "a3", "tabloid"]},
                    "paperFormat": {"type": "string"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_save_pdf"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_har",
        toolset="electron_browser",
        schema={
            "name": "browser_har",
            "description": "Electron-native browser runtime: inspect the current HAR snapshot captured from CDP Network events.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content_mode": {
                        "type": "string",
                        "enum": ["embed", "omit", "attach"],
                        "description": "Content mode for the returned snapshot. attach is only materialized when saving with browser_save_har.",
                    },
                    "contentMode": {"type": "string", "enum": ["embed", "omit", "attach"]},
                    "mode": {"type": "string", "enum": ["full", "minimal"]},
                    "record_har_mode": {"type": "string", "enum": ["full", "minimal"]},
                    "recordHarMode": {"type": "string", "enum": ["full", "minimal"]},
                    "clear": {"type": "boolean", "description": "Clear captured HAR entries after reading the snapshot."},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_har"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_save_har",
        toolset="electron_browser",
        schema={
            "name": "browser_save_har",
            "description": "Electron-native browser runtime: save the current HAR snapshot to a local file. attach mode writes Browser Use-style sidecar files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Local .har output path."},
                    "content_mode": {"type": "string", "enum": ["embed", "omit", "attach"]},
                    "contentMode": {"type": "string", "enum": ["embed", "omit", "attach"]},
                    "mode": {"type": "string", "enum": ["full", "minimal"]},
                    "record_har_mode": {"type": "string", "enum": ["full", "minimal"]},
                    "recordHarMode": {"type": "string", "enum": ["full", "minimal"]},
                },
                "required": ["path"],
            },
        },
        handler=handlers["_browser_save_har"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_storage_state",
        toolset="electron_browser",
        schema={
            "name": "browser_storage_state",
            "description": "Electron-native browser runtime: capture Browser Use-style cookies plus localStorage/sessionStorage state for the current workbench.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "object",
                        "description": "Optional Electron cookie filter, for example {\"domain\":\"example.com\"}.",
                        "additionalProperties": True,
                    },
                },
                "required": [],
            },
        },
        handler=handlers["_browser_storage_state"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_save_storage_state",
        toolset="electron_browser",
        schema={
            "name": "browser_save_storage_state",
            "description": "Electron-native browser runtime: save Browser Use-style browser storage state to a JSON file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Local JSON output path."},
                    "filter": {"type": "object", "description": "Optional Electron cookie filter.", "additionalProperties": True},
                },
                "required": ["path"],
            },
        },
        handler=handlers["_browser_save_storage_state"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_load_storage_state",
        toolset="electron_browser",
        schema={
            "name": "browser_load_storage_state",
            "description": "Electron-native browser runtime: load Browser Use-style browser storage state from a JSON file or object.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Local JSON state path."},
                    "state": {"type": "object", "description": "Storage state object.", "additionalProperties": True},
                    "storageState": {"type": "object", "additionalProperties": True},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_load_storage_state"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_grant_permissions",
        toolset="electron_browser",
        schema={
            "name": "browser_grant_permissions",
            "description": "Electron-native browser runtime: grant browser permission names for the current workbench policy.",
            "parameters": {
                "type": "object",
                "properties": {
                    "permissions": {
                        "oneOf": [
                            {"type": "array", "items": {"type": "string"}},
                            {"type": "string"},
                        ],
                        "description": "Permission names such as clipboardReadWrite, geolocation, notifications, camera, or microphone.",
                    },
                },
                "required": ["permissions"],
            },
        },
        handler=handlers["_browser_grant_permissions"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_start_screencast",
        toolset="electron_browser",
        schema={
            "name": "browser_start_screencast",
            "description": "Electron-native browser runtime: start CDP Page.startScreencast frame capture.",
            "parameters": {
                "type": "object",
                "properties": {
                    "format": {"type": "string", "enum": ["png", "jpeg"]},
                    "quality": {"type": "integer"},
                    "max_width": {"type": "integer"},
                    "maxWidth": {"type": "integer"},
                    "max_height": {"type": "integer"},
                    "maxHeight": {"type": "integer"},
                    "every_nth_frame": {"type": "integer"},
                    "everyNthFrame": {"type": "integer"},
                    "max_frames": {"type": "integer"},
                    "maxFrames": {"type": "integer"},
                    "capture_frames": {"type": "boolean"},
                    "captureFrames": {"type": "boolean"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_start_screencast"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_stop_screencast",
        toolset="electron_browser",
        schema={
            "name": "browser_stop_screencast",
            "description": "Electron-native browser runtime: stop CDP screencast and optionally return captured frames.",
            "parameters": {
                "type": "object",
                "properties": {
                    "include_frames": {"type": "boolean"},
                    "includeFrames": {"type": "boolean"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_stop_screencast"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_set_viewport",
        toolset="electron_browser",
        schema={
            "name": "browser_set_viewport",
            "description": "Electron-native browser runtime: set the page viewport size using CDP Emulation.setDeviceMetricsOverride.",
            "parameters": {
                "type": "object",
                "properties": {
                    "width": {"type": "integer"},
                    "height": {"type": "integer"},
                    "deviceScaleFactor": {"type": "number"},
                    "device_scale_factor": {"type": "number"},
                    "mobile": {"type": "boolean"},
                },
                "required": ["width", "height"],
            },
        },
        handler=handlers["_browser_set_viewport"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_network_config",
        toolset="electron_browser",
        schema={
            "name": "browser_network_config",
            "description": "Electron-native browser runtime: inspect or set Browser Use-style network context options such as extra HTTP headers and user agent.",
            "parameters": {
                "type": "object",
                "properties": {
                    "user_agent": {"type": "string", "description": "Custom user agent to apply to the current workbench."},
                    "userAgent": {"type": "string"},
                    "headers": {
                        "type": "object",
                        "description": "Extra HTTP headers to send on future requests.",
                        "additionalProperties": {"type": "string"},
                    },
                    "extra_http_headers": {
                        "type": "object",
                        "description": "Alias for headers.",
                        "additionalProperties": {"type": "string"},
                    },
                    "extraHTTPHeaders": {
                        "type": "object",
                        "description": "CamelCase alias for headers.",
                        "additionalProperties": {"type": "string"},
                    },
                    "clear": {"type": "boolean", "description": "Reset user agent and extra HTTP headers to defaults."},
                    "clear_headers": {"type": "boolean", "description": "Clear only extra HTTP headers."},
                    "clearHeaders": {"type": "boolean"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_network_config"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_url_policy",
        toolset="electron_browser",
        schema={
            "name": "browser_url_policy",
            "description": "Electron-native browser runtime: inspect or set Browser Use-style URL security policy for allowed/prohibited domains and IP-address blocking.",
            "parameters": {
                "type": "object",
                "properties": {
                    "allowed_domains": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Allowed URL/domain patterns such as *.example.com or https://example.com.",
                    },
                    "allowedDomains": {"type": "array", "items": {"type": "string"}},
                    "prohibited_domains": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Prohibited URL/domain patterns. Ignored when allowed domains are configured.",
                    },
                    "prohibitedDomains": {"type": "array", "items": {"type": "string"}},
                    "block_ip_addresses": {"type": "boolean"},
                    "blockIPAddresses": {"type": "boolean"},
                    "clear": {"type": "boolean", "description": "Clear all URL policy restrictions."},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_url_policy"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_evaluate",
        toolset="electron_browser",
        schema={
            "name": "browser_evaluate",
            "description": "Electron-native browser runtime: execute a Browser Use-style page.evaluate arrow function in the current page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Arrow function expression starting with '(', for example: (url) => location.href === url",
                    },
                    "args": {"type": "array", "description": "JSON-serializable arguments passed to the function."},
                },
                "required": ["expression"],
            },
        },
        handler=handlers["_browser_evaluate"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_evaluate_js",
        toolset="electron_browser",
        schema={
            "name": "browser_evaluate_js",
            "description": "Electron-native browser runtime: execute Browser Use-style arbitrary browser JavaScript/IIFE in the current page. Browser APIs only; no Node.js APIs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "JavaScript expression or IIFE to run in the page context."},
                    "expression": {"type": "string"},
                    "javascript": {"type": "string"},
                    "max_chars": {"type": "integer"},
                    "maxChars": {"type": "integer"},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_evaluate_js"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_mouse",
        toolset="electron_browser",
        schema={
            "name": "browser_mouse",
            "description": "Electron-native browser runtime actor: atomic mouse move/click/wheel/drag. Scroll/wheel may omit x/y and will use the viewport center.",
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {"type": "string", "enum": ["move", "click", "wheel", "scroll", "drag"]},
                    "x": {"type": "number", "description": "X coordinate normalized to 0-1000 (left=0, right=1000) of the screenshot. Required except for scroll/wheel."},
                    "y": {"type": "number", "description": "Y coordinate normalized to 0-1000 (top=0, bottom=1000) of the screenshot. Required except for scroll/wheel."},
                    "toX": {"type": "number"},
                    "toY": {"type": "number"},
                    "button": {"type": "string", "enum": ["left", "middle", "right"]},
                    "clickCount": {"type": "integer"},
                    "deltaX": {"type": "number"},
                    "deltaY": {"type": "number"},
                    "steps": {"type": "integer"},
                    "sessionId": {"type": "string"},
                    "visual_evidence_token": {
                        "type": "string",
                        "description": "Current screenshot evidence token; required for click/drag coordinates.",
                    },
                },
                "required": [],
            },
        },
        handler=handlers["_browser_mouse"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_hover",
        toolset="electron_browser",
        schema={
            "name": "browser_hover",
            "description": "Electron-native browser runtime actor: hover an indexed element.",
            "parameters": {"type": "object", "properties": {"index": {"type": "integer"}}, "required": ["index"]},
        },
        handler=handlers["_browser_hover"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_focus",
        toolset="electron_browser",
        schema={
            "name": "browser_focus",
            "description": "Electron-native browser runtime actor: focus an indexed element.",
            "parameters": {"type": "object", "properties": {"index": {"type": "integer"}}, "required": ["index"]},
        },
        handler=handlers["_browser_focus"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_drag",
        toolset="electron_browser",
        schema={
            "name": "browser_drag",
            "description": "Electron-native browser runtime actor: drag an indexed element to another index or coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "sourceIndex": {"type": "integer"},
                    "source_index": {"type": "integer"},
                    "targetIndex": {"type": "integer"},
                    "target_index": {"type": "integer"},
                    "toX": {"type": "number"},
                    "toY": {"type": "number"},
                    "button": {"type": "string", "enum": ["left", "middle", "right"]},
                    "steps": {"type": "integer"},
                    "visual_evidence_token": {
                        "type": "string",
                        "description": "Current screenshot evidence token; required when toX/toY coordinates are used.",
                    },
                },
                "required": [],
            },
        },
        handler=handlers["_browser_drag"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_element",
        toolset="electron_browser",
        schema={
            "name": "browser_element",
            "description": "Electron-native browser runtime actor: inspect an indexed element, read an attribute, or evaluate an arrow function on it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "operation": {"type": "string", "enum": ["info", "attribute", "evaluate"]},
                    "name": {"type": "string", "description": "Attribute name when operation=attribute."},
                    "expression": {"type": "string", "description": "Arrow function bound to the element as this, e.g. '() => this.textContent' when operation=evaluate."},
                    "args": {"type": "array", "description": "JSON-serializable arguments for operation=evaluate."},
                },
                "required": ["index"],
            },
        },
        handler=handlers["_browser_element"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
    registry.register(
        name="browser_highlight",
        toolset="electron_browser",
        schema={
            "name": "browser_highlight",
            "description": "Electron-native browser runtime: visually highlight indexed elements in the page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer", "description": "Optional element index to highlight. Omit to highlight recent elements."},
                    "limit": {"type": "integer", "description": "Maximum elements to highlight when index is omitted."},
                    "clear": {"type": "boolean", "description": "Clear existing highlights."},
                    "color": {"type": "string", "description": "CSS color for the highlight border."},
                },
                "required": [],
            },
        },
        handler=handlers["_browser_highlight"],
        check_fn=check_fn,
        requires_env=["ELECTRON_BROWSER_RUNTIME_URL", "ELECTRON_BROWSER_RUNTIME_TOKEN"],
    )
