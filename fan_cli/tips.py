"""Random tips shown at CLI session start to help users discover features."""

import random


# ---------------------------------------------------------------------------
# Tip corpus — one-liners covering slash commands, CLI flags, config,
# keybindings, tools, local services, skills, and workflow tricks.
# ---------------------------------------------------------------------------

TIPS = [
    # --- Slash Commands ---
    "/background <prompt> (alias /bg or /btw) runs a task in a separate session while your current one stays free.",
    "/branch forks the current session so you can explore a different direction without losing progress.",
    "/compress manually compresses conversation context when things get long.",
    "/rollback lists filesystem checkpoints — restore files the agent modified to any prior state.",
    "/rollback diff 2 previews what changed since checkpoint 2 without restoring anything.",
    "/rollback 2 src/file.py restores a single file from a specific checkpoint.",
    "/title \"my project\" names your session — resume it later with /resume or fan -c.",
    "/resume picks up where you left off in a previously named session.",
    "/queue <prompt> queues a message for the next turn without interrupting the current one.",
    "/undo removes the last user/assistant exchange from the conversation.",
    "/retry resends your last message — useful when the agent's response wasn't quite right.",
    "/verbose cycles tool progress display: off → new → all → verbose.",
    "/reasoning high increases the model's thinking depth. /reasoning show displays the reasoning.",
    "/fast toggles priority processing for faster API responses (provider-dependent).",
    "/yolo skips all dangerous command approval prompts for the rest of the session.",
    "/model lets you switch models mid-session — try /model qwen3-max.",
    "/model --global changes your default model permanently.",
    "/personality pirate sets a fun personality — 14 built-in options from kawaii to shakespeare.",
    "/skin changes the CLI theme — try ares, mono, slate, poseidon, or charizard.",
    "/statusbar toggles a persistent bar showing model, tokens, context fill %, cost, and duration.",
    "/tools disable browser temporarily removes browser tools for the current session.",
    "/browser connect attaches browser tools to your running Chromium-family browser via CDP.",
    "/plugins lists installed plugins and their status.",
    "/cron manages scheduled tasks — set up recurring prompts with local run history.",
    "/reload-mcp hot-reloads MCP server configuration without restarting.",
    "/usage shows token usage, cost breakdown, and session duration.",
    "/insights shows usage analytics for the last 30 days.",
    "/paste checks your clipboard for an image and attaches it to your next message.",
    "/config shows your current configuration and Fan home at a glance.",
    "/config shows your current configuration at a glance.",
    "/stop kills all running background processes spawned by the agent.",

    # --- @ Context References ---
    "@file:path/to/file.py injects file contents directly into your message.",
    "@file:main.py:10-50 injects only lines 10-50 of a file.",
    "@folder:src/ injects a directory tree listing.",
    "@diff injects your unstaged git changes into the message.",
    "@staged injects your staged git changes (git diff --staged).",
    "@git:5 injects the last 5 commits with full patches.",
    "@url:https://example.com fetches and injects a web page's content.",
    "Typing @ triggers filesystem path completion — navigate to any file interactively.",
    "Combine multiple references: \"Review @file:main.py and @file:test.py for consistency.\"",

    # --- Keybindings ---
    "Alt+Enter inserts a newline for multi-line input. (Windows Terminal intercepts Alt+Enter — use Ctrl+Enter instead.)",
    "Ctrl+C interrupts the agent. Double-press within 2 seconds to force exit.",
    "Ctrl+Z suspends Fan to the background — run fg in your shell to resume.",
    "Tab accepts auto-suggestion ghost text or autocompletes slash commands.",
    "Type a new message while the agent is working to interrupt and redirect it.",
    "Alt+V pastes an image from your clipboard into the conversation.",
    "Pasting 5+ lines auto-saves to a file and inserts a compact reference instead.",

    # --- CLI Flags ---
    "fan -c resumes your most recent CLI session. fan -c \"project name\" resumes by title.",
    "fan -w creates an isolated git worktree — perfect for parallel agent workflows.",
    "fan -w -q \"Fix issue #42\" combines worktree isolation with a one-shot query.",
    "fan chat -t web,terminal enables only specific toolsets for a focused session.",
    "fan chat -s github-pr-workflow preloads a skill at launch.",
    "fan chat -q \"query\" runs a single non-interactive query and exits.",
    "fan chat --max-turns 200 overrides the default 90-iteration limit per turn.",
    "fan chat --checkpoints enables filesystem snapshots before every destructive file change.",
    "fan --yolo bypasses all dangerous command approval prompts for the entire session.",

    # --- CLI Subcommands ---
    "fan doctor --fix diagnoses and auto-repairs config and dependency issues.",
    "fan dump outputs a compact setup summary — great for bug reports.",
    "fan config set KEY VALUE auto-routes secrets to .env and everything else to config.yaml.",
    "fan config edit opens config.yaml in your default editor.",
    "fan config check scans for missing or stale configuration options.",
    "fan sessions browse opens an interactive session picker with search.",
    "fan sessions stats shows session counts by source and database size.",
    "fan sessions prune --older-than 30 cleans up old sessions.",
    "fan skills check scans URL-installed skills for upstream updates.",
    "fan skills snapshot export setup.json exports your skill configuration for backup or sharing.",
    "fan mcp add github --command npx adds MCP servers from the command line.",
    "fan mcp serve runs Fan itself as an MCP server for other agents.",
    "Add multiple API keys to a provider's credential pool for automatic rotation.",
    "fan completion bash >> ~/.bashrc enables tab completion for all commands.",
    "fan logs -f follows agent.log in real time. --level WARNING --since 1h filters output.",
    "Settings > About checks for Fan desktop updates and installs new bundled skills with the app.",
    "fan memory setup lets you configure an external memory provider (Honcho, Mem0, etc.).",
    "Save money: fan tools disables unused tools, fan skills config trims skills down.",
    "/reasoning low or /reasoning minimal cuts thinking depth below the default (medium) — faster, cheaper responses.",
    "fan models routes vision, compression, and aux tasks to cheaper models — cuts background token cost 85%+ without downgrading your main chat model.",

    # --- Configuration ---
    "Set display.bell_on_complete: true in config.yaml to hear a bell when long tasks finish.",
    "Set display.streaming: true to see tokens appear in real time as the model generates.",
    "Set display.show_reasoning: true to watch the model's chain-of-thought reasoning.",
    "Set display.compact: true to reduce whitespace in output for denser information.",
    "Set display.busy_input_mode: queue to queue messages instead of interrupting the agent, or steer to inject them mid-run via /steer.",
    "Set display.resume_display: minimal to skip the full conversation recap on session resume.",
    "Set compression.threshold: 0.50 to control when auto-compression fires (default: 50% of context).",
    "Set agent.max_turns: 200 to let the agent take more tool-calling steps per turn.",
    "Set file_read_max_chars: 200000 to increase the max content per read_file call.",
    "Set approvals.mode: smart to let an LLM auto-approve safe commands and auto-deny dangerous ones.",
    "Set fallback_model in config.yaml to automatically fail over to a backup provider.",
    "Set privacy.redact_pii: true to hash user IDs and phone numbers before sending to the LLM.",
    "Set worktree: true in config.yaml to always create a git worktree (same as fan -w).",
    "Set security.website_blocklist.enabled: true to block specific domains from web tools.",
    "Set cron.wrap_response: false to save raw agent output without the cron header/footer.",
    "FAN_TIMEZONE overrides the server timezone with any IANA timezone string.",
    "Environment variable substitution works in config.yaml: use ${VAR_NAME} syntax.",
    "Quick commands in config.yaml run shell commands instantly with zero token usage.",
    "Custom personalities can be defined in config.yaml under agent.personalities.",
    "provider_routing controls OpenRouter provider sorting, whitelisting, and blacklisting.",

    # --- Tools & Capabilities ---
    "execute_code runs Python scripts that call Fan tools programmatically — results stay out of context.",
    "delegate_task spawns up to 3 concurrent sub-agents by default (delegation.max_concurrent_children) with isolated contexts for parallel work.",
    "search_files is ripgrep-backed and faster than grep — use it instead of terminal grep.",
    "patch uses 9 fuzzy matching strategies so minor whitespace differences won't break edits.",
    "patch supports V4A format for bulk multi-file edits in a single call.",
    "read_file suggests similar filenames when a file isn't found.",
    "read_file auto-deduplicates — re-reading an unchanged file returns a lightweight stub.",
    "browser_observe can return indexed DOM and a current screenshot in one observation.",
    "browser_evaluate and browser_evaluate_js run JavaScript in the current page context.",
    "text_to_speech converts text to audio for local playback.",
    "The todo tool helps the agent track complex multi-step tasks during a session.",
    "session_search performs full-text search across ALL past conversations.",
    "The agent automatically saves preferences, corrections, and environment facts to memory.",
    "mixture_of_agents routes hard problems through 4 frontier LLMs collaboratively.",
    "Terminal commands support background mode with notify_on_complete for long-running tasks.",
    "Terminal background processes support watch_patterns to alert on specific output lines.",
    "The terminal tool supports 6 backends: local, Docker, SSH, Modal, Daytona, and Singularity.",

    # --- Sessions ---
    "Sessions auto-generate descriptive titles after the first exchange — no manual naming needed.",
    "Session titles support lineage: \"my project\" → \"my project #2\" → \"my project #3\".",
    "When exiting, Fan prints a resume command with session ID and stats.",
    "fan sessions export backup.jsonl exports all sessions for backup or analysis.",
    "fan -r SESSION_ID resumes any specific past session by its ID.",

    # --- Memory ---
    "Memory is a frozen snapshot — changes appear in the system prompt only at next session start.",
    "Memory entries are automatically scanned for prompt injection and exfiltration patterns.",
    "The agent has two memory stores: personal notes (~2200 chars) and user profile (~1375 chars).",
    "Corrections you give the agent (\"no, do it this way\") are often auto-saved to memory.",

    # --- Skills ---
    "Over 80 bundled skills covering github, creative, mlops, productivity, research, and more.",
    "Every installed skill automatically becomes a slash command — type / to see them all.",
    "Skills can restrict to specific OS platforms — some only load on macOS or Linux.",
    "skills.external_dirs in config.yaml lets you load skills from custom directories.",
    "The agent can create its own skills as procedural memory using skill_manage.",
    "The plan skill saves markdown plans under .fan/plans/ in the active workspace.",

    # --- Cron & Scheduling ---
    "Cron jobs can attach skills: fan cron add --skill blogwatcher \"Check for new posts\".",
    "If a cron response starts with [SILENT], no report content is recorded — useful for monitoring-only jobs.",
    "Cron supports relative delays (30m), intervals (every 2h), cron expressions, and ISO timestamps.",
    "Cron jobs run in completely fresh agent sessions — prompts must be self-contained.",

    # --- Voice ---
    "Voice mode works with zero API keys if faster-whisper is installed (free local speech-to-text).",
    "Five TTS providers available: Edge TTS (free), ElevenLabs, OpenAI, NeuTTS (free local), MiniMax.",
    "/voice on enables voice mode in the CLI. Ctrl+B toggles push-to-talk recording.",
    "Streaming TTS plays sentences as they generate — you don't wait for the full response.",
    "Local voice input can be transcribed before it is sent to the agent.",

    # --- Local API ---
    "The API server exposes an OpenAI-compatible endpoint compatible with Open WebUI and LibreChat.",

    # --- Security ---
    "Dangerous command approval has 4 tiers: once, session, always (permanent allowlist), deny.",
    "Smart approval mode uses an LLM to auto-approve safe commands and flag dangerous ones.",
    "SSRF protection blocks private networks, loopback, link-local, and cloud metadata addresses.",
    "Tirith pre-exec scanning detects homograph URL spoofing and pipe-to-interpreter patterns.",
    "MCP subprocesses receive a filtered environment — only safe system vars pass through.",
    "Context files (.fan.md, AGENTS.md) are security-scanned for prompt injection before loading.",
    "command_allowlist in config.yaml permanently approves specific shell command patterns.",

    # --- Context & Compression ---
    "Context auto-compresses when it reaches the threshold — memories are flushed and history summarized.",
    "The status bar turns yellow, then orange, then red as context fills up.",
    "SOUL.md is the agent's primary identity file — customize it to shape behavior.",
    "Fan loads project context from .fan.md, AGENTS.md, CLAUDE.md, or .cursorrules (first match).",
    "Subdirectory AGENTS.md files are discovered progressively as the agent navigates into folders.",
    "Context files are capped at 20,000 characters with smart head/tail truncation.",

    # --- Browser ---
    "browser_navigate returns the final page observation automatically — do not observe again unless the page changes later.",
    "browser_find_visual locates icon-only controls and can click the target from the same visual snapshot.",

    # --- MCP ---
    "fan mcp opens an interactive picker of Nous-approved MCPs you can install in one keystroke.",
    "fan mcp catalog lists Nous-approved MCP servers shipped with the repo.",
    "fan mcp install <name> installs a catalog entry, prompts for credentials, and lets you pick which of its tools to enable.",
    "MCP servers are configured in config.yaml — both stdio and HTTP transports supported.",
    "Per-server tool filtering: tools.include whitelists and tools.exclude blacklists specific tools.",
    "MCP servers auto-generate toolsets at runtime — fan tools can toggle them per session.",
    "MCP OAuth support: auth: oauth enables browser-based authorization with PKCE.",

    # --- Checkpoints & Rollback ---
    "Checkpoints have zero overhead when no files are modified — enabled by default.",
    "A pre-rollback snapshot is saved automatically so you can undo the undo.",
    "/rollback also undoes the conversation turn, so the agent doesn't remember rolled-back changes.",
    "Checkpoints use shadow repos in ~/.fan/checkpoints/ — your project's .git is never touched.",

    # --- Batch & Data ---
    "batch_runner.py processes hundreds of prompts in parallel for training data generation.",
    "fan chat -Q enables quiet mode for programmatic use — suppresses banner and spinner.",
    "Trajectory saving (--save-trajectories) captures full tool-use traces for model training.",

    # --- Plugins ---
    "Three plugin types: general (tools/hooks), memory providers, and context engines.",
    "fan plugins install owner/repo installs plugins directly from GitHub.",
    "8 external memory providers available: Honcho, OpenViking, Mem0, Hindsight, and more.",
    "Plugin hooks include pre/post_tool_call, pre/post_llm_call, and transform_terminal_output for output canonicalization.",

    # --- Miscellaneous ---
    "The agent auto-generates session titles in a background thread — zero latency impact.",
    "Smart model routing can auto-route simple queries to a cheaper model.",
    "Slash commands support prefix matching: /h resolves to /help, /mod to /model.",
    "Dragging a file path into the terminal auto-attaches images or sends as context.",
    ".worktreeinclude in your repo root lists gitignored files to copy into worktrees.",
    "fan acp runs Fan as an ACP server for VS Code, Zed, and JetBrains integration.",
    "Custom providers: save named endpoints in config.yaml under custom_providers.",
    "FAN_EPHEMERAL_SYSTEM_PROMPT injects a system prompt that's never persisted to history.",
    "credential_pool_strategies supports fill_first, round_robin, least_used, and random rotation.",
    "The API server supports both Chat Completions and Responses API with server-side state.",
    "tool_preview_length: 0 in config shows full file paths in the spinner's activity feed.",
    "fan status --deep runs deeper diagnostic checks across all components.",

    # --- Hidden Gems & Power-User Tricks ---
    "Cron jobs can attach a Python script (--script) whose stdout is injected into the prompt as context.",
    "Cron scripts live in ~/.fan/scripts/ and run before the agent — perfect for data collection pipelines.",
    "prefill_messages_file in config.yaml injects few-shot examples into every API call, never saved to history.",
    "SOUL.md completely replaces the agent's default identity — rewrite it to make Fan your own.",
    "SOUL.md is auto-seeded with a default personality on first run. Edit it to customize.",
    "/compress <focus topic> allocates 60-70% of the summary budget to your topic and aggressively trims the rest.",
    "On second+ compression, the compressor updates the previous summary instead of starting from scratch.",
    "Before a session reset, Fan auto-flushes important facts to memory in the background.",
    "network.force_ipv4: true in config.yaml fixes hangs on servers with broken IPv6 — monkey-patches socket.",
    "The terminal tool annotates common exit codes: grep returning 1 = 'No matches found (not an error)'.",
    "Failed foreground terminal commands auto-retry up to 3 times with exponential backoff (2s, 4s, 8s).",
    "Bare sudo commands are auto-rewritten to pipe SUDO_PASSWORD from .env — no interactive prompt needed.",
    "execute_code has built-in helpers: json_parse() for tolerant parsing, shell_quote(), and retry() with backoff.",
    "execute_code's sandbox tools use RPC — their results never enter context.",
    "Reading the same file region 3+ times triggers a warning. At 4+, it's hard-blocked to prevent loops.",
    "write_file and patch detect if a file was externally modified since the last read and warn about staleness.",
    "V4A patch format supports Add File, Delete File, and Move File directives — not just Update.",
    "MCP servers can request LLM completions back via sampling — the agent becomes a tool for the server.",
    "MCP servers send notifications/tools/list_changed to trigger automatic tool re-registration without restart.",
    "delegate_task with acp_command: 'claude' spawns Claude Code as a child agent from an active session.",
    "Delegation has a heartbeat thread so child activity remains visible to the parent.",
    "When a provider returns HTTP 402 (payment required), the auxiliary client auto-falls back to the next one.",
    "agent.tool_use_enforcement steers models that describe actions instead of calling tools — auto for GPT/Codex.",
    "agent.api_max_retries (default 3) controls how many times the agent retries a failed API call before surfacing the error — lower it for fast fallback.",
    "Stale git worktrees are auto-cleaned: 24-72h old with no unpushed commits get pruned on startup.",
    "Fan uses FAN_HOME/home/ as its subprocess HOME so git, ssh, npm, and gh state stay separate from your OS account.",
    "FAN_HOME_MODE env var (octal, e.g. 0701) sets custom directory permissions for web server traversal.",
    "Container mode: place .container-mode in FAN_HOME and the host CLI auto-execs into the container.",
    "Ctrl+C has 5 priority tiers: cancel recording → cancel prompts → cancel picker → interrupt agent → exit.",
    "Every interrupt during an agent run is logged to ~/.fan/interrupt_debug.log with timestamps.",
    "Electron browser tools connect through ELECTRON_BROWSER_RUNTIME_URL and ELECTRON_BROWSER_RUNTIME_TOKEN, injected by the desktop app.",
    "The CLI auto-switches to compact mode in terminals narrower than 80 columns.",
    "Quick commands support two types: exec (run shell command directly) and alias (redirect to another command).",
    "Per-task delegation model: delegation.model and delegation.provider in config route subagents to cheaper models.",
    "delegation.reasoning_effort independently controls thinking depth for subagents.",
    "human_delay.mode in config simulates human typing speed — configurable min_ms/max_ms range.",
    "Config version migrations run automatically on load — new config keys appear without manual intervention.",
    "GPT and Codex models get special system prompt guidance for tool discipline and mandatory tool use.",
    "Gemini models get tailored directives for absolute paths, parallel tool calls, and non-interactive commands.",
    "context.engine in config.yaml can be set to a plugin name for alternative context management strategies.",
    "Browser pages over 8000 tokens are auto-summarized by the auxiliary LLM before returning to the agent.",
    "The compressor does a cheap pre-pass: tool outputs over 200 chars are replaced with placeholders before the LLM runs.",
    "When compression fails, further attempts are paused for 10 minutes to avoid API hammering.",
    "Long dangerous commands (>70 chars) get a 'view' option in the approval prompt to see the full text first.",
    "Audio level visualization shows ▁▂▃▄▅▆▇ bars during voice recording based on microphone RMS levels.",
    "The voice record key is configurable via voice.record_key in config.yaml — not just Ctrl+B.",
    ".cursorrules and .cursor/rules/*.mdc files are auto-detected and loaded as project context.",
    "Context files support 10+ prompt injection patterns — invisible Unicode, 'ignore instructions', exfil attempts.",
    "GPT-5 and Codex use 'developer' role instead of 'system' in the message format.",
    "Per-task auxiliary overrides: auxiliary.vision.provider, auxiliary.compression.model, etc. in config.yaml.",
    "The auxiliary client treats 'main' as a provider alias — resolves to your actual primary provider + model.",
    "fan claw migrate --dry-run previews OpenClaw migration without writing anything.",
    "File paths pasted with quotes or escaped spaces are handled automatically — no manual cleanup needed.",
    "Slash commands never trigger the large-paste collapse — /command with big arguments works correctly.",
    "In interrupt mode, slash commands typed during agent execution bypass interrupt logic and run immediately.",
    "FAN_DEV=1 bypasses container mode detection for local development.",
    "Each MCP server gets its own toolset (mcp-servername) that can be toggled independently via fan tools.",
    "MCP ${ENV_VAR} placeholders in config are resolved at server spawn — including vars from ~/.fan/.env.",
    "Downloaded skills are quarantined locally until their security review completes.",

    # --- Advanced Slash Commands ---
    '/steer <prompt> injects a note after the next tool call — nudge direction mid-task without interrupting.',
    '/goal <text> sets a standing Ralph-loop objective — Fan auto-continues turn after turn until a judge says done.',
    '/copy [N] copies the last assistant response to your clipboard, or the Nth-from-last with a number.',
    '/redraw forces a full UI repaint, fixing terminal drift after tmux resize or mouse selection artifacts.',
    '/agents (alias /tasks) shows active agents and running background tasks across the current session.',
    '/busy queue|steer|interrupt controls what pressing Enter does while Fan is working.',
    '/approve session|always runs a pending dangerous command with your chosen trust scope; /deny rejects it.',
    '/kanban boards switch <slug> changes the active multi-project Kanban board from inside chat.',
    '/reload reloads ~/.fan/.env into the running session — pick up new API keys without restarting.',

    # --- Cron (no-agent & scripts) ---
    'cronjob with no_agent=True runs a script on schedule and saves its stdout locally — zero tokens, zero LLM.',
    'An empty cron script stdout means a silent tick with no report content, perfect for threshold watchdogs.',
    "FAN_CRON_MAX_PARALLEL (default 4) caps how many cron jobs run per tick so bursts don't saturate your keys.",

    # --- Curator ---
    'fan curator run --dry-run previews what the curator would archive or consolidate without mutating anything.',
    "fan curator pin <skill> hard-fences a skill against both auto-archival and the agent's skill_manage tool.",

    # --- Credential Pools & Routing ---
    'Resetting a provider credential pool clears its cooldowns and exhaustion flags.',
    'credential_pool_strategies.<provider>: round_robin cycles keys evenly instead of the fill_first default.',
    'provider_routing.data_collection: deny excludes data-storing providers on OpenRouter.',
    'provider_routing.require_parameters: true only routes to providers that support every param in your request.',

    # --- Env Vars & Config Gates ---
    'FAN_BACKGROUND_NOTIFICATIONS=result only pings when background tasks finish (vs all/error/off).',
    'FAN_WRITE_SAFE_ROOT restricts write_file and patch to a directory prefix; writes outside require approval.',
    'FAN_IGNORE_RULES skips auto-injection of AGENTS.md, SOUL.md, .cursorrules, memory, and preloaded skills.',
    'FAN_ACCEPT_HOOKS auto-approves unseen shell hooks declared in config.yaml without a TTY prompt.',
    'auxiliary.goal_judge.model routes the /goal judge to a cheap fast model to keep loop cost near zero.',
    'Checkpoints skip directories with more than 50,000 files to avoid slow git operations on massive monorepos.',

    # --- TTS ---
    'tts.provider: piper runs 44-language local TTS on CPU — voices auto-download to ~/.fan/cache/piper-voices/.',
    'tts.providers.<name>.type: command wires any CLI TTS engine with {input_path} and {output_path} placeholders.',

    # --- API Server & Proxy ---
    'API_SERVER_ENABLED=true runs a local OpenAI-compatible endpoint for Open WebUI and LibreChat.',

    # --- Batch ---
    "batch_runner.py --resume content-matches completed prompts by text so dataset reorders don't re-run finished work.",

    # --- Less-Known Slash Commands ---
    '/new starts a fresh session in place (alias /reset) — fresh session ID, clean history, CLI stays open.',
    '/clear wipes the terminal screen AND starts a new session — one shortcut for a visual reset.',
    '/history prints the current conversation in-line without leaving the CLI — useful for a quick re-read.',
    '/save writes the current conversation to disk without ending the session.',
    '/status shows session info at a glance: ID, title, model, token usage, and elapsed time.',
    '/image <path> attaches a local image file for your next prompt without pasting or drag-and-drop.',
    '/commands paginates the full slash-command + installed-skill list — useful in terminals without tab completion.',
    '/toolsets lists every available toolset so you know what -t/--toolsets accepts.',
    '/gquota shows Google Gemini Code Assist quota usage with progress bars when that provider is active.',
    '/voice tts toggles TTS-only mode — agent replies out loud but you still type your prompts.',
    '/reload-skills re-scans ~/.fan/skills/ so drop-in skills appear without restarting the session.',
    '/indicator kaomoji|emoji|unicode|ascii picks the TUI busy-indicator style shown during agent runs.',
    '/debug creates a local support bundle with redacted system information and logs.',

    # --- CLI Subcommands & Flags ---
    'fan -z "<prompt>" is the purest one-shot: final answer on stdout, nothing else — ideal for piping in scripts.',
    'fan chat --pass-session-id injects the session ID into the system prompt so the agent can self-reference it.',
    'fan chat --image path/to/pic.png attaches a local image to a single -q query without a separate upload step.',
    'fan chat --ignore-user-config skips the active user config — reproducible bug reports and CI runs.',
    "fan chat --source tool tags programmatic chats so they don't clutter fan sessions list.",
    'fan dump --show-keys includes redacted API key fingerprints for deeper support debugging.',
    'fan sessions rename <ID> "new title" renames any past session; fan sessions delete <ID> removes one.',
    'fan fallback manages the fallback_model chain interactively — no hand-editing config.yaml.',
    'fan setup walks first-time users through provider keys and local tool configuration.',
    'fan status --deep runs the full health sweep across every component; plain fan status is the quick view.',

    # --- Agent Behavior Env Vars ---
    'FAN_AGENT_TIMEOUT=0 disables the inactivity timeout for a running agent — use for long research runs.',
    'FAN_ENABLE_PROJECT_PLUGINS=1 auto-loads repo-local plugins from ./.fan/plugins/ — trust-gated by design.',
    "FAN_DISABLE_FILE_STATE_GUARD=1 turns off the 'file changed since you read it' guard on patch and write_file.",
    'FAN_ALLOW_PRIVATE_URLS=true lets web tools hit localhost and private networks — off by default.',
    'FAN_BUNDLED_SKILLS points at a custom bundled-skill tree — used by Homebrew and Nix packaging.',
    'FAN_DUMP_REQUEST_STDOUT=1 also prints request diagnostics to stdout (files are still written); FAN_DUMP_REQUESTS=1 enables full payloads.',
    'FAN_OAUTH_TRACE=1 logs redacted third-party OAuth exchanges for debugging provider integrations.',
    'FAN_STREAM_RETRIES (default 3) controls mid-stream reconnect attempts on transient network errors.',

    # --- Runtime Behavior Env Vars ---
    'FAN_RESTART_DRAIN_TIMEOUT (default 900s) caps how long /restart waits for in-flight runs before forcing.',
    'FAN_CHECKPOINT_TIMEOUT (default 30s) caps filesystem checkpoint creation — raise it on huge monorepos.',

    # --- Auxiliary Tasks & Image Generation ---
    'AUXILIARY_VISION_BASE_URL + AUXILIARY_VISION_API_KEY point vision analysis at any OpenAI-compatible endpoint.',

    # --- Security ---
    'security.tirith_fail_open: false makes Fan block commands when the tirith scanner itself errors out.',
    'TIRITH_FAIL_OPEN env var overrides the tirith_fail_open config — a quick toggle without editing config.yaml.',

    # --- Sessions & Source Tags ---
    '--source tool chats are excluded from fan sessions list by default — set --source explicitly to see them.',
    'Session IDs are timestamp-prefixed (20250305_091523_abcd) so sorting works naturally in ls and jq.',

    # --- Misc ---
    'API_SERVER_MODEL_NAME customizes the model name on /v1/models for OpenAI-compatible clients.',
    'Dashboard plugins are served from /dashboard-plugins/<name>/ — drop files into ~/.fan/dashboard-plugins/.',
]


def get_random_tip() -> str:
    """Return a random tip string.

    Args:
        exclude_recent: not used currently; reserved for future
            deduplication across sessions.
    """
    return random.choice(TIPS)
