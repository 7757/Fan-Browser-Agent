"""
Top-level argparse construction for the fan CLI.

Only the top-level parser lives here. Every subparser (model, sessions, …)
is built inline in ``main.py`` because its dispatch is tightly coupled to
module-level ``cmd_*`` functions.
"""

import argparse


_EPILOGUE = """
Fan runs as a desktop application. Use the Fan desktop app for interactive
chat; the commands below manage configuration and the local backend.

Examples:
    fan logs                   View agent.log (last 50 lines)
    fan logs -f                Follow agent.log in real time
    fan dashboard              Start the desktop backend (web UI dashboard)
    fan dashboard --stop       Stop running dashboard processes
    fan cron list              List scheduled tasks
    fan kanban list            List collaboration-board tasks

For more help on a command:
    fan <command> --help
"""


def build_top_level_parser():
    """Build the top-level parser and the subparsers action.

    Returns ``(parser, subparsers)``. The caller continues registering
    subparsers via ``subparsers.add_parser(...)``.
    """
    parser = argparse.ArgumentParser(
        prog="fan",
        description="Fan Agent - AI assistant with tool-calling capabilities",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_EPILOGUE,
    )

    parser.add_argument(
        "--version", "-V", action="store_true", help="Show version and exit"
    )
    # --model / --provider are accepted at the top level for management
    # subcommands that honour them; they fall through harmlessly as None
    # when nothing consumes them.
    parser.add_argument(
        "-m",
        "--model",
        default=None,
        help=(
            "Model override for this invocation (e.g. qwen-plus). "
            "Also settable via the FAN_INFERENCE_MODEL env var."
        ),
    )
    parser.add_argument(
        "--provider",
        default=None,
        help=(
            "Provider override for this invocation (e.g. alibaba or custom). "
            "The persistent provider lives in config.yaml "
            "under model.provider — use `fan setup` or edit the file to change it."
        ),
    )
    parser.add_argument(
        "-t",
        "--toolsets",
        default=None,
        help="Comma-separated toolsets to enable for this invocation.",
    )
    parser.add_argument(
        "--resume",
        "-r",
        metavar="SESSION",
        default=None,
        help="Resume a previous session by ID or title",
    )
    parser.add_argument(
        "--continue",
        "-c",
        dest="continue_last",
        nargs="?",
        const=True,
        default=None,
        metavar="SESSION_NAME",
        help="Resume a session by name, or the most recent if no name given",
    )
    parser.add_argument(
        "--worktree",
        "-w",
        action="store_true",
        default=False,
        help="Run in an isolated git worktree (for parallel agents)",
    )
    parser.add_argument(
        "--accept-hooks",
        action="store_true",
        default=False,
        help=(
            "Auto-approve any unseen shell hooks declared in config.yaml "
            "without a TTY prompt.  Equivalent to FAN_ACCEPT_HOOKS=1 or "
            "hooks_auto_accept: true in config.yaml.  Use on CI / headless "
            "runs that can't prompt."
        ),
    )
    parser.add_argument(
        "--skills",
        "-s",
        action="append",
        default=None,
        help="Preload one or more skills for the session (repeat flag or comma-separate)",
    )
    parser.add_argument(
        "--yolo",
        action="store_true",
        default=False,
        help="Bypass all dangerous command approval prompts (use at your own risk)",
    )
    parser.add_argument(
        "--pass-session-id",
        action="store_true",
        default=False,
        help="Include the session ID in the agent's system prompt",
    )
    parser.add_argument(
        "--ignore-user-config",
        action="store_true",
        default=False,
        help="Ignore ~/.fan/config.yaml and fall back to built-in defaults (credentials in .env are still loaded)",
    )
    parser.add_argument(
        "--ignore-rules",
        action="store_true",
        default=False,
        help="Skip auto-injection of AGENTS.md, SOUL.md, .cursorrules, memory, and preloaded skills",
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    return parser, subparsers
