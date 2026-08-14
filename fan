#!/usr/bin/env python3
"""
Fan Agent CLI launcher.

This wrapper should behave like the installed `fan` command, including
subcommands such as `gateway`, `cron`, and `doctor`.
"""

if __name__ == "__main__":
    from fan_cli.main import main
    main()
