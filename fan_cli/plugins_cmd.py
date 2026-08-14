"""``fan plugins`` CLI subcommand — install, update, remove, and list plugins.

Plugins are installed from Git repositories into ``~/.fan/plugins/``.
Supports full URLs and ``owner/repo`` shorthand (resolves to GitHub).

After install, if the plugin ships an ``after-install.md`` file it is
rendered with Rich Markdown.  Otherwise a default confirmation is shown.
"""

from __future__ import annotations

import functools
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

from fan_constants import get_fan_home
from fan_cli.config import cfg_get
from fan_cli.secret_prompt import masked_secret_prompt

logger = logging.getLogger(__name__)


@functools.lru_cache(maxsize=1)
def _resolve_git_executable() -> Optional[str]:
    """Resolve a git binary for subprocess use when ``PATH`` may be minimal.

    Matches other Fan subprocess resolution: :func:`shutil.which` first,
    then common Git for Windows install paths and POSIX defaults.
    """
    found = shutil.which("git")
    if found:
        return found
    if os.name == "nt":
        prog = os.environ.get("ProgramFiles", r"C:\Program Files")
        prog_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = os.environ.get("LOCALAPPDATA", "")
        candidates = [
            os.path.join(prog, "Git", "cmd", "git.exe"),
            os.path.join(prog, "Git", "bin", "git.exe"),
            os.path.join(prog_x86, "Git", "cmd", "git.exe"),
            os.path.join(prog_x86, "Git", "bin", "git.exe"),
        ]
        if local:
            candidates.extend(
                (
                    os.path.join(local, "Programs", "Git", "cmd", "git.exe"),
                    os.path.join(local, "Programs", "Git", "bin", "git.exe"),
                )
            )
    else:
        candidates = ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


class PluginOperationError(Exception):
    """Recoverable plugin install/update failure (CLI exits; HTTP maps to 4xx)."""


# Minimum manifest version this installer understands.
# Plugins may declare ``manifest_version: 1`` in plugin.yaml;
# future breaking changes to the manifest schema bump this.
_SUPPORTED_MANIFEST_VERSION = 1


def _plugins_dir() -> Path:
    """Return the user plugins directory, creating it if needed."""
    plugins = get_fan_home() / "plugins"
    plugins.mkdir(parents=True, exist_ok=True)
    return plugins


def _sanitize_plugin_name(
    name: str,
    plugins_dir: Path,
    *,
    allow_subdir: bool = False,
) -> Path:
    """Validate a plugin name and return the safe target path inside *plugins_dir*.

    Raises ``ValueError`` if the name contains path-traversal sequences or would
    resolve outside the plugins directory.

    ``allow_subdir=True`` permits a single forward slash inside *name* so
    category-namespaced plugin keys like ``image_gen/openai`` (the registry keys
    emitted by ``_discover_all_plugins``)
    can be looked up. ``..`` and backslash are still rejected, leading and
    trailing slashes are stripped, and the resolved target must still live
    inside *plugins_dir*. Install paths leave this at the default ``False``
    because a freshly-cloned plugin always lands top-level under
    ``~/.fan/plugins/<name>/``.
    """
    if not name:
        raise ValueError("Plugin name must not be empty.")

    if allow_subdir:
        name = name.strip("/")
        if not name:
            raise ValueError("Plugin name must not be empty.")

    if name in {".", ".."}:
        raise ValueError(
            f"Invalid plugin name '{name}': must not reference the plugins directory itself."
        )

    # Reject obvious traversal characters
    bad_chars = ("\\", "..") if allow_subdir else ("/", "\\", "..")
    for bad in bad_chars:
        if bad in name:
            raise ValueError(f"Invalid plugin name '{name}': must not contain '{bad}'.")

    target = (plugins_dir / name).resolve()
    plugins_resolved = plugins_dir.resolve()

    if target == plugins_resolved:
        raise ValueError(
            f"Invalid plugin name '{name}': resolves to the plugins directory itself."
        )

    try:
        target.relative_to(plugins_resolved)
    except ValueError:
        raise ValueError(
            f"Invalid plugin name '{name}': resolves outside the plugins directory."
        )

    return target


_GITHUB_BROWSER_SEGMENTS = {
    "actions",
    "blob",
    "commit",
    "commits",
    "issues",
    "pull",
    "pulls",
    "releases",
    "tree",
    "wiki",
}


def _resolve_git_url(identifier: str) -> tuple[str, Optional[str]]:
    """Turn an identifier into a cloneable Git URL and optional subdirectory.

    Returns ``(git_url, subdir)`` where ``subdir`` is the path within the
    cloned repository that contains the plugin (``None`` when the plugin lives
    at the repo root).

    Accepted formats:
    - Full URL: https://github.com/owner/repo.git
    - Full URL: git@github.com:owner/repo.git
    - Full URL: ssh://git@github.com/owner/repo.git
    - Browser URL: https://github.com/owner/repo/tree/main/path
      →  (https://github.com/owner/repo.git, None)
    - Shorthand: owner/repo  →  (https://github.com/owner/repo.git, None)
    - Shorthand w/ subdir: owner/repo/path/to/plugin
      →  (https://github.com/owner/repo.git, "path/to/plugin")
    - Full URL w/ subdir (``.git`` boundary):
      https://github.com/owner/repo.git/path/to/plugin
      →  (https://github.com/owner/repo.git, "path/to/plugin")
    - Any URL w/ explicit subdir fragment (works for every scheme, incl.
      ``file://`` and ssh): <url>#path/to/plugin
      →  (<url>, "path/to/plugin")

    NOTE: ``http://`` and ``file://`` schemes are accepted but will trigger a
    security warning at install time. A subpath inside a browser
    ``/tree/<branch>/`` URL is intentionally NOT treated as a subdir (the branch
    is dropped and the clone is shallow/default-branch); use the
    ``owner/repo/path`` shorthand or an explicit ``#path`` fragment instead.
    """
    # Already a URL
    if identifier.startswith(("https://", "http://", "git@", "ssh://", "file://")):
        # Normalize browser-pasted GitHub repo views (``/tree/...``,
        # ``/blob/...`` etc.) back to a cloneable ``.git`` URL so a URL copied
        # straight out of the address bar installs cleanly. Checked BEFORE the
        # ``#`` handling so a ``#anchor`` on such a view is not mistaken for a
        # subdir fragment.
        if identifier.startswith("https://github.com/"):
            path = identifier[len("https://github.com/") :]
            path = path.split("?", 1)[0].split("#", 1)[0].strip("/")
            parts = path.split("/")
            if len(parts) >= 3 and all(parts[:2]) and parts[2] in _GITHUB_BROWSER_SEGMENTS:
                repo = parts[1]
                if repo.endswith(".git"):
                    repo = repo[: -len(".git")]
                return f"https://github.com/{parts[0]}/{repo}.git", None
        # Explicit ``#subdir`` fragment — unambiguous for any scheme.
        if "#" in identifier:
            git_url, _, frag = identifier.partition("#")
            return git_url, (frag.strip("/") or None)
        # Natural ``.git/`` boundary (GitHub-style URLs).
        marker = ".git/"
        idx = identifier.find(marker)
        if idx != -1:
            git_url = identifier[: idx + len(".git")]
            subdir = identifier[idx + len(marker) :].strip("/")
            return git_url, (subdir or None)
        return identifier, None

    # owner/repo[/subdir...] shorthand
    parts = [p for p in identifier.strip("/").split("/") if p]
    if len(parts) >= 2:
        owner, repo = parts[0], parts[1]
        subdir = "/".join(parts[2:]).strip("/")
        git_url = f"https://github.com/{owner}/{repo}.git"
        return git_url, (subdir or None)

    raise ValueError(
        f"Invalid plugin identifier: '{identifier}'. "
        "Use a Git URL or 'owner/repo' shorthand (optionally with a subdirectory: "
        "'owner/repo/path/to/plugin')."
    )


def _resolve_subdir_within(clone_root: Path, subdir: str) -> Path:
    """Resolve ``subdir`` inside ``clone_root``, rejecting path traversal.

    Guards against ``..`` segments, absolute paths, and symlinks that would
    escape the cloned repository. Returns the resolved directory path.
    Raises ``PluginOperationError`` if the path escapes the clone, doesn't
    exist, or is not a directory.
    """
    clone_root = clone_root.resolve()
    candidate = (clone_root / subdir).resolve()

    # The resolved candidate must stay within the clone root.
    if candidate != clone_root and clone_root not in candidate.parents:
        raise PluginOperationError(
            f"Plugin subdirectory '{subdir}' escapes the repository.",
        )

    if not candidate.exists():
        raise PluginOperationError(
            f"Plugin subdirectory '{subdir}' does not exist in the repository.",
        )
    if not candidate.is_dir():
        raise PluginOperationError(
            f"Plugin subdirectory '{subdir}' is not a directory.",
        )

    return candidate


def _repo_name_from_url(url: str) -> str:
    """Extract the repo name from a Git URL for the plugin directory name."""
    # Strip trailing .git and slashes
    name = url.rstrip("/")
    if name.endswith(".git"):
        name = name[:-4]
    # Get last path component
    name = name.rsplit("/", 1)[-1]
    # Handle ssh-style urls: git@github.com:owner/repo
    if ":" in name:
        name = name.rsplit(":", 1)[-1].rsplit("/", 1)[-1]
    return name


def _read_manifest(plugin_dir: Path) -> dict:
    """Read plugin.yaml and return the parsed dict, or empty dict."""
    manifest_file = plugin_dir / "plugin.yaml"
    if not manifest_file.exists():
        return {}
    try:
        import yaml

        with open(manifest_file, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        logger.warning("Failed to read plugin.yaml in %s: %s", plugin_dir, e)
        return {}


def _copy_example_files(plugin_dir: Path, console) -> None:
    """Copy any .example files to their real names if they don't already exist.

    For example, ``config.yaml.example`` becomes ``config.yaml``.
    Skips files that already exist to avoid overwriting user config on reinstall.
    """
    for example_file in plugin_dir.glob("*.example"):
        real_name = example_file.stem  # e.g. "config.yaml" from "config.yaml.example"
        real_path = plugin_dir / real_name
        if not real_path.exists():
            try:
                shutil.copy2(example_file, real_path)
                console.print(
                    f"[dim]  Created {real_name} from {example_file.name}[/dim]"
                )
            except OSError as e:
                console.print(
                    f"[yellow]Warning:[/yellow] Failed to copy {example_file.name}: {e}"
                )


def _missing_requires_env_names(manifest: dict) -> list[str]:
    """Return declared ``requires_env`` names that are unset in ``~/.fan/.env``."""
    requires_env = manifest.get("requires_env") or []
    if not requires_env:
        return []

    from fan_cli.config import get_env_value

    env_specs: list[dict] = []
    for entry in requires_env:
        if isinstance(entry, str):
            env_specs.append({"name": entry})
        elif isinstance(entry, dict) and entry.get("name"):
            env_specs.append(entry)

    return [s["name"] for s in env_specs if s.get("name") and not get_env_value(s["name"])]





def _require_installed_plugin(name: str, plugins_dir: Path, console) -> Path:
    """Return the plugin path if it exists, or exit with an error listing installed plugins."""
    target = _sanitize_plugin_name(name, plugins_dir, allow_subdir=True)
    if not target.exists():
        installed = ", ".join(d.name for d in plugins_dir.iterdir() if d.is_dir()) or "(none)"
        console.print(
            f"[red]Error:[/red] Plugin '{name}' not found in {plugins_dir}.\n"
            f"Installed plugins: {installed}"
        )
        sys.exit(1)
    return target


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _install_plugin_core(identifier: str, *, force: bool) -> tuple[Path, dict, str]:
    """Clone Git plugin into ``~/.fan/plugins``.

    Returns ``(target_dir, installed_manifest, canonical_name)``.
    Raises ``PluginOperationError`` on failure.
    """
    import tempfile

    try:
        git_url, subdir = _resolve_git_url(identifier)
    except ValueError as e:
        raise PluginOperationError(str(e)) from e

    plugins_dir = _plugins_dir()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_clone = Path(tmp) / "plugin"

        git_exe = _resolve_git_executable()
        if not git_exe:
            raise PluginOperationError("git is not installed or not in PATH.")

        try:
            result = subprocess.run(
                [git_exe, "clone", "--depth", "1", git_url, str(tmp_clone)],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except FileNotFoundError as e:
            raise PluginOperationError(
                "git is not installed or not in PATH.",
            ) from e
        except subprocess.TimeoutExpired as e:
            raise PluginOperationError(
                "Git clone timed out after 60 seconds.",
            ) from e

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            raise PluginOperationError(f"Git clone failed:\n{err}")

        # Resolve the directory within the clone that holds the plugin. With a
        # subdir we move ONLY that subtree, so root-level docs/tests of a larger
        # repo don't leak into the plugins directory.
        if subdir:
            tmp_target = _resolve_subdir_within(tmp_clone, subdir)
        else:
            tmp_target = tmp_clone

        manifest = _read_manifest(tmp_target)
        plugin_name = manifest.get("name") or (
            subdir.rstrip("/").rsplit("/", 1)[-1] if subdir else _repo_name_from_url(git_url)
        )

        try:
            target = _sanitize_plugin_name(plugin_name, plugins_dir)
        except ValueError as e:
            raise PluginOperationError(str(e)) from e

        mv = manifest.get("manifest_version")
        if mv is not None:
            try:
                mv_int = int(mv)
            except (ValueError, TypeError):
                raise PluginOperationError(
                    f"Plugin '{plugin_name}' has invalid manifest_version "
                    f"'{mv}' (expected an integer).",
                ) from None
            if mv_int > _SUPPORTED_MANIFEST_VERSION:
                raise PluginOperationError(
                    f"Plugin '{plugin_name}' requires manifest_version {mv}, "
                    f"but this installer only supports up to {_SUPPORTED_MANIFEST_VERSION}. "
                    "Update Fan from Settings > About in the desktop app.",
                ) from None

        if target.exists():
            if not force:
                raise PluginOperationError(
                    f"Plugin '{plugin_name}' already exists. Use force reinstall "
                    f"or run `fan plugins update {plugin_name}`.",
                )
            shutil.rmtree(target)

        shutil.move(str(tmp_target), str(target))

    has_yaml = (target / "plugin.yaml").exists() or (target / "plugin.yml").exists()
    if not has_yaml and not (target / "__init__.py").exists():
        logger.warning(
            "%s has no plugin.yaml / __init__.py; may not be a valid plugin",
            plugin_name,
        )

    from rich.console import Console

    _copy_example_files(target, Console())
    installed_manifest = _read_manifest(target)
    installed_name = installed_manifest.get("name") or target.name
    return target, installed_manifest, installed_name



def cmd_update(name: str) -> None:
    """Update an installed plugin by pulling latest from its git remote."""
    from rich.console import Console

    console = Console()
    plugins_dir = _plugins_dir()

    try:
        target = _require_installed_plugin(name, plugins_dir, console)
    except ValueError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)

    if not (target / ".git").exists():
        console.print(
            f"[red]Error:[/red] Plugin '{name}' was not installed from git "
            f"(no .git directory). Cannot update."
        )
        sys.exit(1)

    console.print(f"[dim]Updating {name}...[/dim]")

    ok, output = _git_pull_plugin_dir(target)
    if not ok:
        console.print(f"[red]Error:[/red] {output}")
        sys.exit(1)

    # Copy any new .example files
    _copy_example_files(target, console)

    out = output.strip()
    if "Already up to date" in out:
        console.print(
            f"[green]✓[/green] Plugin [bold]{name}[/bold] is already up to date."
        )
    else:
        console.print(f"[green]✓[/green] Plugin [bold]{name}[/bold] updated.")
        console.print(f"[dim]{out}[/dim]")



def _get_disabled_set() -> set:
    """Read the disabled plugins set from config.yaml.

    An explicit deny-list. A plugin name here never loads, even if also
    listed in ``plugins.enabled``.
    """
    try:
        from fan_cli.config import load_config
        config = load_config()
        disabled = cfg_get(config, "plugins", "disabled", default=[])
        return set(disabled) if isinstance(disabled, list) else set()
    except Exception:
        return set()


def _save_disabled_set(disabled: set) -> None:
    """Write the disabled plugins list to config.yaml."""
    from fan_cli.config import load_config, save_config
    config = load_config()
    if "plugins" not in config:
        config["plugins"] = {}
    config["plugins"]["disabled"] = sorted(disabled)
    save_config(config)


def _get_enabled_set() -> set:
    """Read the enabled plugins allow-list from config.yaml.

    Plugins are opt-in: only names here are loaded. Returns ``set()`` if
    the key is missing (same behaviour as "nothing enabled yet").
    """
    try:
        from fan_cli.config import load_config
        config = load_config()
        plugins_cfg = config.get("plugins", {})
        if not isinstance(plugins_cfg, dict):
            return set()
        enabled = plugins_cfg.get("enabled", [])
        return set(enabled) if isinstance(enabled, list) else set()
    except Exception:
        return set()


def _save_enabled_set(enabled: set) -> None:
    """Write the enabled plugins list to config.yaml."""
    from fan_cli.config import load_config, save_config
    config = load_config()
    if "plugins" not in config:
        config["plugins"] = {}
    config["plugins"]["enabled"] = sorted(enabled)
    save_config(config)


def _resolve_plugin_key(name: str) -> Optional[str]:
    """Resolve a user-supplied plugin identifier to its canonical registry key.

    Accepts either the bare manifest name, the directory name, or a full
    path-derived key and returns the canonical
    key the loader gates on (``manifest.key`` or, for a flat plugin, the bare
    name). Returns ``None`` when no plugin matches.

    This is the single normalization point so ``fan plugins enable`` /
    ``disable`` write the same key that ``PluginManager`` matches against —
    nested category plugins included.
    """
    entries = _discover_all_plugins()
    # 1. Exact match on canonical key or manifest name — always unambiguous.
    for entry in entries:
        # entry = (name, version, description, source, dir_path, key)
        if name == entry[5] or name == entry[0]:
            return entry[5]
    # 2. Fall back to a bare leaf-name match for a nested category plugin,
    #    but only when it resolves to exactly one plugin so we never silently
    #    pick the wrong same-named nested plugin.
    leaf_matches = [entry[5] for entry in entries if name == entry[5].split("/")[-1]]
    if len(leaf_matches) == 1:
        return leaf_matches[0]
    return None


def cmd_enable(name: str) -> None:
    """Add a plugin to the enabled allow-list (and remove it from disabled)."""
    from rich.console import Console

    console = Console()
    # Discover the plugin — check installed (user) AND bundled, including
    # nested category plugins — and normalize to its canonical registry key.
    key = _resolve_plugin_key(name)
    if key is None:
        console.print(f"[red]Plugin '{name}' is not installed or bundled.[/red]")
        sys.exit(1)

    enabled = _get_enabled_set()
    disabled = _get_disabled_set()

    if key in enabled and key not in disabled:
        console.print(f"[dim]Plugin '{key}' is already enabled.[/dim]")
        return

    enabled.add(key)
    disabled.discard(key)
    # Drop any legacy bare-name entry so the two don't drift out of sync.
    bare = key.split("/")[-1]
    if bare != key:
        disabled.discard(bare)
    _save_enabled_set(enabled)
    _save_disabled_set(disabled)
    console.print(
        f"[green]✓[/green] Plugin [bold]{key}[/bold] enabled. "
        "Takes effect on next session."
    )


def cmd_disable(name: str) -> None:
    """Remove a plugin from the enabled allow-list (and add to disabled)."""
    from rich.console import Console

    console = Console()
    key = _resolve_plugin_key(name)
    if key is None:
        console.print(f"[red]Plugin '{name}' is not installed or bundled.[/red]")
        sys.exit(1)

    enabled = _get_enabled_set()
    disabled = _get_disabled_set()

    if key not in enabled and key in disabled:
        console.print(f"[dim]Plugin '{key}' is already disabled.[/dim]")
        return

    enabled.discard(key)
    # Drop any legacy bare-name entry from the allow-list too, so a stale
    # bare name can't keep a nested plugin loading after an explicit disable.
    bare = key.split("/")[-1]
    if bare != key:
        enabled.discard(bare)
    disabled.add(key)
    _save_enabled_set(enabled)
    _save_disabled_set(disabled)
    console.print(
        f"[yellow]\u2298[/yellow] Plugin [bold]{key}[/bold] disabled. "
        "Takes effect on next session."
    )


def _read_manifest_info(d: Path, prefix: str):
    """Read a plugin.yaml manifest and return (name, version, description, key).

    ``key`` is the path-derived registry key the loader gates on: ``name``
    for a flat plugin, ``<prefix>/<dir>`` for a nested category plugin —
    matching ``PluginManager._parse_manifest``.

    Returns None if no manifest file exists.
    """
    manifest_file = d / "plugin.yaml"
    if not manifest_file.exists():
        manifest_file = d / "plugin.yml"
    if not manifest_file.exists():
        return None
    try:
        import yaml
    except ImportError:
        yaml = None
    name = d.name
    version = ""
    description = ""
    if yaml:
        try:
            with open(manifest_file, encoding="utf-8") as f:
                manifest = yaml.safe_load(f) or {}
            name = manifest.get("name", d.name)
            version = manifest.get("version", "")
            description = manifest.get("description", "")
        except Exception:
            pass
    key = f"{prefix}/{d.name}" if prefix else name
    return name, version, description, key


def _scan_level(
    base: Path,
    source: str,
    skip_names: set,
    prefix: str,
    depth: int,
    seen: dict,
) -> None:
    """Recursive directory scan matching ``PluginManager._scan_directory_level``.

    A subdirectory with its own ``plugin.yaml`` is a plugin; one without (at
    depth 0) is treated as a category namespace and recursed into one level
    deeper (cap at 2 segments), so nested category plugins are
    discovered. Populates *seen* with
    ``key -> (name, version, description, source, dir, key)``.
    """
    if not base.is_dir():
        return
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        if depth == 0 and skip_names and d.name in skip_names:
            continue
        info = _read_manifest_info(d, prefix)
        if info is not None:
            name, version, description, key = info
            # User plugins override bundled on key collision.
            if key in seen and source == "bundled":
                continue
            src_label = source
            if source == "user" and (d / ".git").exists():
                src_label = "git"
            seen[key] = (name, version, description, src_label, d, key)
            continue
        if depth >= 1:
            continue
        sub_prefix = f"{prefix}/{d.name}" if prefix else d.name
        _scan_level(d, source, set(), sub_prefix, depth + 1, seen)


def _discover_all_plugins() -> list:
    """Return a list of (name, version, description, source, dir_path, key) for
    every plugin the loader can see — user + bundled + project.

    Matches the ordering/dedup of ``PluginManager.discover_and_load``:
    bundled first, then user; user overrides bundled on key collision.
    Mirrors the loader's nested-category handling: ``memory`` and
    ``model-providers`` have their own discovery systems and are skipped.
    """
    seen: dict = {}  # key -> (name, version, description, source, path, key)

    from fan_cli.plugins import get_bundled_plugins_dir
    repo_plugins = get_bundled_plugins_dir()
    for base, source, skip in (
        (repo_plugins, "bundled", {"memory", "platforms", "model-providers"}),
        (_plugins_dir(), "user", set()),
    ):
        _scan_level(base, source, skip, "", 0, seen)
    return list(seen.values())


def _plugin_status(name: str, enabled: set, disabled: set, key: str = "") -> str:
    """Return the user-facing activation state for a plugin name or key."""
    if name in disabled or key in disabled:
        return "disabled"
    if name in enabled or key in enabled:
        return "enabled"
    return "not enabled"


def _filter_plugin_entries(entries: list, args: Any, enabled: set, disabled: set) -> list:
    """Apply ``fan plugins list`` CLI filters."""
    filtered = entries
    if getattr(args, "no_bundled", False) or getattr(args, "user", False):
        filtered = [entry for entry in filtered if entry[3] != "bundled"]
    if getattr(args, "enabled", False):
        filtered = [
            entry for entry in filtered
            if _plugin_status(entry[0], enabled, disabled, key=entry[5]) == "enabled"
        ]
    return filtered


def cmd_list(args: Any | None = None) -> None:
    """List all plugins (bundled + user) with enabled/disabled state."""
    from rich.console import Console
    from rich.table import Table

    console = Console()
    entries = _discover_all_plugins()
    if not entries:
        console.print("[dim]No plugins installed.[/dim]")
        console.print("[dim]Install with:[/dim] fan plugins install owner/repo")
        return

    enabled = _get_enabled_set()
    disabled = _get_disabled_set()
    entries = _filter_plugin_entries(entries, args, enabled, disabled)

    if getattr(args, "json", False):
        payload = [
            {
                "name": name,
                "status": _plugin_status(name, enabled, disabled, key=key),
                "version": str(version),
                "description": description,
                "source": source,
            }
            for name, version, description, source, _dir, key in entries
        ]
        print(json.dumps(payload, indent=2))
        return

    if getattr(args, "plain", False):
        for name, version, _description, source, _dir, key in entries:
            status = _plugin_status(name, enabled, disabled, key=key)
            print(f"{status:12} {source:8} {str(version):8} {name}")
        return

    if not entries:
        console.print("[dim]No plugins matched the selected filters.[/dim]")
        return

    table = Table(title="Plugins", show_lines=False)
    table.add_column("Name", style="bold")
    table.add_column("Status")
    table.add_column("Version", style="dim")
    table.add_column("Description")
    table.add_column("Source", style="dim")

    for name, version, description, source, _dir, key in entries:
        status_name = _plugin_status(name, enabled, disabled, key=key)
        if status_name == "disabled":
            status = "[red]disabled[/red]"
        elif status_name == "enabled":
            status = "[green]enabled[/green]"
        else:
            status = "[yellow]not enabled[/yellow]"
        table.add_row(name, status, str(version), description, source)

    console.print()
    console.print(table)
    console.print()
    console.print("[dim]Compact view:[/dim] fan plugins list --plain --no-bundled")
    console.print("[dim]Interactive toggle:[/dim] fan plugins")
    console.print("[dim]Enable/disable:[/dim] fan plugins enable/disable <name>")
    console.print("[dim]Plugins are opt-in by default — only 'enabled' plugins load.[/dim]")


# ---------------------------------------------------------------------------
# Provider plugin discovery helpers
# ---------------------------------------------------------------------------


def _discover_memory_providers() -> list[tuple[str, str]]:
    """Return [(name, description), ...] for available memory providers."""
    try:
        from plugins.memory import discover_memory_providers
        return [(name, desc) for name, desc, _avail in discover_memory_providers()]
    except Exception:
        return []


def _discover_context_engines() -> list[tuple[str, str]]:
    """Return [(name, description), ...] for available context engines.

    Includes plugin-registered engines installed as Fan plugins via
    ``ctx.register_context_engine``.
    """
    engines: list[tuple[str, str]] = []
    seen: set[str] = set()

    try:
        from fan_cli.plugins import discover_plugins, get_plugin_context_engine
        discover_plugins()
        plugin_engine = get_plugin_context_engine()
        if plugin_engine and getattr(plugin_engine, "name", None) and plugin_engine.name not in seen:
            engines.append((plugin_engine.name, "installed plugin"))
    except Exception:
        pass

    return engines


def _get_current_memory_provider() -> str:
    """Return the current memory.provider from config (empty = built-in)."""
    try:
        from fan_cli.config import load_config
        config = load_config()
        return cfg_get(config, "memory", "provider", default="") or ""
    except Exception:
        return ""


def _get_current_context_engine() -> str:
    """Return the current context.engine from config."""
    try:
        from fan_cli.config import load_config
        config = load_config()
        return cfg_get(config, "context", "engine", default="compressor") or "compressor"
    except Exception:
        return "compressor"


def _save_memory_provider(name: str) -> None:
    """Persist memory.provider to config.yaml."""
    from fan_cli.config import load_config, save_config
    config = load_config()
    if "memory" not in config:
        config["memory"] = {}
    config["memory"]["provider"] = name
    save_config(config)


def _save_context_engine(name: str) -> None:
    """Persist context.engine to config.yaml."""
    from fan_cli.config import load_config, save_config
    config = load_config()
    if "context" not in config:
        config["context"] = {}
    config["context"]["engine"] = name
    save_config(config)



# ---------------------------------------------------------------------------
# Composite plugins UI
# ---------------------------------------------------------------------------





def dashboard_install_plugin(
    identifier: str,
    *,
    force: bool,
    enable: bool,
) -> dict[str, Any]:
    """Non-interactive install for the web dashboard. Returns a JSON-serializable dict."""
    warnings: list[str] = []
    try:
        git_url, _subdir = _resolve_git_url(identifier)
        if git_url.startswith(("http://", "file://")):
            warnings.append(
                "Insecure URL scheme; prefer https:// or git@ for production installs.",
            )
    except ValueError:
        pass

    try:
        target, installed_manifest, installed_name = _install_plugin_core(
            identifier,
            force=force,
        )
    except PluginOperationError as exc:
        return {"ok": False, "error": str(exc)}

    missing_env = _missing_requires_env_names(installed_manifest)
    if enable:
        en = _get_enabled_set()
        dis = _get_disabled_set()
        en.add(installed_name)
        dis.discard(installed_name)
        _save_enabled_set(en)
        _save_disabled_set(dis)

    hint: str | None = None
    ap = target / "after-install.md"
    if ap.exists():
        hint = str(ap)

    return {
        "ok": True,
        "plugin_name": installed_name,
        "warnings": warnings,
        "missing_env": missing_env,
        "after_install_path": hint,
        "enabled": enable,
    }


def _get_plugin_toolset_key(name: str) -> Optional[str]:
    """Return the toolset key a plugin registers its tools under, or None.

    Queries the live tool registry — the plugin must already be loaded.
    Falls back to reading ``provides_tools`` from plugin.yaml and looking
    up the toolset from the registry for the first tool name found.
    """
    try:
        from tools.registry import registry
    except Exception:
        return None

    # Check the plugin manager for tools this plugin registered
    try:
        from fan_cli.plugins import discover_plugins, get_plugin_manager
        discover_plugins()  # idempotent — ensures plugins are loaded
        manager = get_plugin_manager()
        for _key, loaded in manager._plugins.items():
            if loaded.manifest.name == name or _key == name:
                for tool_name in loaded.tools_registered:
                    entry = registry.get_entry(tool_name)
                    if entry and entry.toolset:
                        return entry.toolset
                break
    except Exception:
        pass

    # Fallback: read provides_tools from manifest on disk and query registry
    try:
        from fan_cli.plugins import get_bundled_plugins_dir
        for base in (get_bundled_plugins_dir(), _plugins_dir()):
            if not base.is_dir():
                continue
            candidate = base / name
            if candidate.is_dir():
                manifest = _read_manifest(candidate)
                for tool_name in manifest.get("provides_tools") or []:
                    entry = registry.get_entry(tool_name)
                    if entry and entry.toolset:
                        return entry.toolset
    except Exception:
        pass

    return None


def _toggle_plugin_toolset(name: str, *, enable: bool) -> None:
    """Add or remove a plugin's toolset from platform_toolsets for all platforms.

    Only acts if the plugin actually provides tools (has a toolset key).
    """
    toolset_key = _get_plugin_toolset_key(name)
    if not toolset_key:
        return

    from fan_cli.config import load_config, save_config

    config = load_config()
    platform_toolsets = config.get("platform_toolsets")
    if not isinstance(platform_toolsets, dict):
        platform_toolsets = {}
        config["platform_toolsets"] = platform_toolsets

    changed = False
    for platform, ts_list in platform_toolsets.items():
        if not isinstance(ts_list, list):
            continue
        if enable:
            if toolset_key not in ts_list:
                ts_list.append(toolset_key)
                changed = True
        elif toolset_key in ts_list:
            ts_list.remove(toolset_key)
            changed = True

    # If enabling and no platforms have toolset lists yet, add to "cli" at minimum
    if enable and not changed and not platform_toolsets:
        platform_toolsets["cli"] = [toolset_key]
        changed = True

    if changed:
        save_config(config)


def dashboard_set_agent_plugin_enabled(name: str, *, enabled: bool) -> dict[str, Any]:
    """Enable or disable a plugin in ``config.yaml`` (runtime allow/deny lists).

    For plugins that provide tools (toolsets), also toggles the toolset in
    ``platform_toolsets`` so the agent actually sees the tools in sessions.
    """
    # Normalize to the canonical registry key (including nested category
    # plugins reached by bare name) so the persisted
    # allow/deny entry matches what the loader gates on — same intent as the
    # CLI cmd_enable/cmd_disable resolution.
    key = _resolve_plugin_key(name)
    if key is None:
        return {"ok": False, "error": f"Plugin '{name}' is not installed or bundled."}

    en = _get_enabled_set()
    dis = _get_disabled_set()
    bare = key.split("/")[-1]

    if enabled:
        if key in en and key not in dis:
            return {"ok": True, "name": key, "unchanged": True}
        en.add(key)
        dis.discard(key)
        if bare != key:
            dis.discard(bare)
        _save_enabled_set(en)
        _save_disabled_set(dis)
        _toggle_plugin_toolset(key, enable=True)
        return {"ok": True, "name": key, "unchanged": False}

    if key not in en and key in dis:
        return {"ok": True, "name": key, "unchanged": True}

    en.discard(key)
    if bare != key:
        en.discard(bare)
    dis.add(key)
    _save_enabled_set(en)
    _save_disabled_set(dis)
    _toggle_plugin_toolset(key, enable=False)
    return {"ok": True, "name": key, "unchanged": False}


def _user_installed_plugin_dir(name: str) -> Optional[Path]:
    """Resolved path under ``~/.fan/plugins/<name>`` if it exists."""
    plugins_dir = _plugins_dir()
    try:
        target = _sanitize_plugin_name(name, plugins_dir, allow_subdir=True)
    except ValueError:
        return None
    return target if target.is_dir() else None


def dashboard_update_user_plugin(name: str) -> dict[str, Any]:
    """``git pull`` inside ``~/.fan/plugins/<name>``."""
    target = _user_installed_plugin_dir(name)
    if target is None:
        return {
            "ok": False,
            "error": f"Plugin '{name}' was not found under {_plugins_dir()}.",
        }

    if not (target / ".git").exists():
        return {
            "ok": False,
            "error": f"Plugin '{name}' is not a git checkout; cannot pull updates.",
        }

    ok, msg = _git_pull_plugin_dir(target)
    if not ok:
        return {"ok": False, "error": msg}

    from rich.console import Console

    _copy_example_files(target, Console())
    unchanged = "Already up to date" in msg
    return {"ok": True, "name": name, "output": msg, "unchanged": unchanged}


def _git_pull_plugin_dir(target: Path) -> tuple[bool, str]:
    git_exe = _resolve_git_executable()
    if not git_exe:
        return False, "git is not installed or not in PATH."
    try:
        result = subprocess.run(
            [git_exe, "pull", "--ff-only"],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(target),
        )
    except FileNotFoundError:
        return False, "git is not installed or not in PATH."
    except subprocess.TimeoutExpired:
        return False, "Git pull timed out after 60 seconds."

    if result.returncode != 0:
        err = (result.stderr or "").strip() or result.stdout.strip()
        return False, err or "git pull failed."
    return True, result.stdout.strip()


def dashboard_remove_user_plugin(name: str) -> dict[str, Any]:
    """Delete a plugin tree under ``~/.fan/plugins/`` only."""
    plugins_dir = _plugins_dir()
    for n, _ver, _d, src, _path, _key in _discover_all_plugins():
        if n == name and src == "bundled":
            return {"ok": False, "error": "Bundled plugins cannot be removed from the dashboard."}

    target = _user_installed_plugin_dir(name)
    if target is None:
        return {
            "ok": False,
            "error": f"Plugin '{name}' was not found under {plugins_dir}.",
        }

    shutil.rmtree(target)
    return {"ok": True, "name": name}
