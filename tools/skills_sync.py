#!/usr/bin/env python3
"""
Skills Sync -- Manifest-based seeding and updating of bundled skills.

Copies bundled skills from the repo's skills/ directory into ~/.fan/skills/
and uses a manifest to track which skills have been synced and their origin hash.

Manifest format (v2): each line is "skill_name:origin_hash" where origin_hash
is the MD5 of the bundled skill at the time it was last synced to the user dir.
Old v1 manifests (plain names without hashes) are auto-migrated.

Update logic:
  - NEW skills (not in manifest): copied to user dir, origin hash recorded.
  - EXISTING skills (in manifest, present in user dir):
      * If user copy matches origin hash: user hasn't modified it → safe to
        update from bundled if bundled changed. New origin hash recorded.
      * If user copy differs from origin hash: user customized it → SKIP.
  - DELETED by user (in manifest, absent from user dir): respected, not re-added.
  - REMOVED from bundled (in manifest, gone from repo): cleaned from manifest.

The manifest lives at ~/.fan/skills/.bundled_manifest.
"""

import hashlib
import logging
import os
import shutil
from pathlib import Path
from fan_constants import get_bundled_skills_dir, get_fan_home
from agent.skill_utils import is_excluded_skill_path
from typing import Dict, List, Set, Tuple
from utils import atomic_replace

logger = logging.getLogger(__name__)


FAN_HOME = get_fan_home()
SKILLS_DIR = FAN_HOME / "skills"
MANIFEST_FILE = SKILLS_DIR / ".bundled_manifest"

# Marker file written by the installer `--no-skills` flag. When present in
# FAN_HOME, sync_skills() is a no-op so neither the installer, `fan update`,
# nor a direct sync re-injects bundled skills. Delete the file to opt back in.
NO_BUNDLED_SKILLS_MARKER = ".no-bundled-skills"


def _get_bundled_dir() -> Path:
    """Locate the bundled skills/ directory.

    Checks FAN_BUNDLED_SKILLS env var first (set by Nix wrapper),
    then a wheel-installed data dir, then falls back to the relative
    path from this source file.
    """
    return get_bundled_skills_dir(Path(__file__).parent.parent / "skills")


def _build_external_skill_index() -> Set[str]:
    """Return names already supplied by configured read-only skill directories.

    Bundled skills are copied into the local profile during startup/update.
    If an external directory already provides the same skill, copying another
    local version makes resolution ambiguous.  Index both directory and
    frontmatter names because the resolver accepts either form.
    """
    try:
        from agent.skill_utils import (
            _external_dirs_cache_clear,
            get_external_skills_dirs,
        )
    except ImportError:
        return set()

    _external_dirs_cache_clear()
    names: Set[str] = set()
    for external_dir in get_external_skills_dirs():
        for skill_md in external_dir.rglob("SKILL.md"):
            if is_excluded_skill_path(skill_md):
                continue
            names.add(skill_md.parent.name)
            frontmatter_name = _read_skill_name(skill_md, "")
            if frontmatter_name:
                names.add(frontmatter_name)
    return names


def _read_manifest() -> Dict[str, str]:
    """
    Read the manifest as a dict of {skill_name: origin_hash}.

    Handles both v1 (plain names) and v2 (name:hash) formats.
    v1 entries get an empty hash string which triggers migration on next sync.
    """
    if not MANIFEST_FILE.exists():
        return {}
    try:
        result = {}
        for line in MANIFEST_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            if ":" in line:
                # v2 format: name:hash
                name, _, hash_val = line.partition(":")
                result[name.strip()] = hash_val.strip()
            else:
                # v1 format: plain name — empty hash triggers migration
                result[line] = ""
        return result
    except (OSError, IOError):
        return {}


def _read_suppressed_names() -> set:
    """Built-in skills the curator pruned — must NOT be re-seeded on sync.

    Delegates to ``tools.skill_usage`` (single source of truth) and falls back
    to reading ``~/.fan/skills/.curator_suppressed`` directly if that import
    is unavailable in a packaged/update context.
    """
    try:
        from tools.skill_usage import read_suppressed_names

        return read_suppressed_names()
    except Exception:
        path = SKILLS_DIR / ".curator_suppressed"
        if not path.exists():
            return set()
        names = set()
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    names.add(line)
        except OSError:
            pass
        return names


def _write_manifest(entries: Dict[str, str]):
    """Write the manifest file atomically in v2 format (name:hash).

    Uses a temp file + os.replace() to avoid corruption if the process
    crashes or is interrupted mid-write.
    """
    import tempfile

    MANIFEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = "\n".join(f"{name}:{hash_val}" for name, hash_val in sorted(entries.items())) + "\n"

    try:
        fd, tmp_path = tempfile.mkstemp(
            dir=str(MANIFEST_FILE.parent),
            prefix=".bundled_manifest_",
            suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            atomic_replace(tmp_path, MANIFEST_FILE)
        except BaseException:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except Exception as e:
        logger.debug("Failed to write skills manifest %s: %s", MANIFEST_FILE, e, exc_info=True)


def _read_skill_name(skill_md: Path, fallback: str) -> str:
    """Read the name field from SKILL.md YAML frontmatter, falling back to *fallback*."""
    try:
        content = skill_md.read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return fallback
    in_frontmatter = False
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped == "---":
            if in_frontmatter:
                break
            in_frontmatter = True
            continue
        if in_frontmatter and stripped.startswith("name:"):
            value = stripped.split(":", 1)[1].strip().strip("\"'")
            if value:
                return value
    return fallback


def _discover_bundled_skills(bundled_dir: Path) -> List[Tuple[str, Path]]:
    """
    Find all SKILL.md files in the bundled directory.
    Returns list of (skill_name, skill_directory_path) tuples.
    """
    skills = []
    if not bundled_dir.exists():
        return skills

    for skill_md in bundled_dir.rglob("SKILL.md"):
        if is_excluded_skill_path(skill_md):
            continue
        skill_dir = skill_md.parent
        skill_name = _read_skill_name(skill_md, skill_dir.name)
        skills.append((skill_name, skill_dir))

    return skills


def _compute_relative_dest(skill_dir: Path, bundled_dir: Path) -> Path:
    """
    Compute the destination path in SKILLS_DIR preserving the category structure.
    e.g., bundled/skills/mlops/axolotl -> ~/.fan/skills/mlops/axolotl
    """
    rel = skill_dir.relative_to(bundled_dir)
    return SKILLS_DIR / rel


def _dir_hash(directory: Path) -> str:
    """Compute a hash of all file contents in a directory for change detection."""
    hasher = hashlib.md5()
    try:
        for fpath in sorted(directory.rglob("*")):
            if fpath.is_file():
                rel = fpath.relative_to(directory)
                hasher.update(str(rel).encode("utf-8"))
                hasher.update(fpath.read_bytes())
    except (OSError, IOError):
        pass
    return hasher.hexdigest()


def sync_skills(quiet: bool = False) -> dict:
    """
    Sync bundled skills into ~/.fan/skills/ using the manifest.

    Returns:
        dict with keys: copied (list), updated (list), skipped (int),
                        user_modified (list), cleaned (list), total_bundled (int)
    """
    # Opt-out: a Fan home that wrote the .no-bundled-skills marker gets zero
    # bundled-skill seeding. Returning the empty-result shape with
    # skipped_opt_out lets callers report "opted out" instead of
    # "synced 0 / failed".
    if (FAN_HOME / NO_BUNDLED_SKILLS_MARKER).exists():
        if not quiet:
            print("  (skipped — Fan home opted out of bundled skills via .no-bundled-skills)")
        return {
            "copied": [], "updated": [], "skipped": 0,
            "user_modified": [], "cleaned": [], "total_bundled": 0,
            "skipped_opt_out": True,
        }

    bundled_dir = _get_bundled_dir()
    if not bundled_dir.exists():
        return {
            "copied": [], "updated": [], "skipped": 0,
            "user_modified": [], "cleaned": [], "suppressed": [], "total_bundled": 0,
        }

    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    manifest = _read_manifest()
    bundled_skills = _discover_bundled_skills(bundled_dir)
    bundled_names = {name for name, _ in bundled_skills}
    suppressed = _read_suppressed_names()
    external_index = _build_external_skill_index()
    shadowed_by_external: List[str] = []

    copied = []
    updated = []
    user_modified = []
    suppressed_skipped: List[str] = []
    skipped = 0

    for skill_name, skill_src in bundled_skills:
        # Curator-pruned built-ins: do not re-seed. The suppression list
        # (~/.fan/skills/.curator_suppressed) is written when the curator
        # archives a bundled skill with curator.prune_builtins enabled. Without
        # this skip, every `fan update` would resurrect a skill the user
        # deliberately pruned. Restoring the skill clears its suppression entry.
        if skill_name in suppressed:
            suppressed_skipped.append(skill_name)
            continue

        dest = _compute_relative_dest(skill_src, bundled_dir)
        bundled_hash = _dir_hash(skill_src)

        # Recover an orphaned backup before classifying. If a previous update was
        # interrupted between moving dest aside and copying the new version in,
        # the user's only copy sits in dest.bak while dest is gone — without
        # this, the "in manifest but not on disk" branch below misreads the skill
        # as user-deleted and it silently vanishes.
        _orphan = dest.with_suffix(".bak")
        if _orphan.exists() and not dest.exists():
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(_orphan), str(dest))
                logger.info("Recovered orphaned skill backup: %s", _orphan)
            except (OSError, IOError):
                logger.warning(
                    "Could not recover orphaned skill backup %s", _orphan,
                    exc_info=True,
                )

        if skill_name in external_index:
            # An external source owns this name. Do not create a competing
            # local copy or add a manifest baseline for a skill we did not
            # write. A pristine shadow from an older sync is safe to remove;
            # a customized local skill is deliberately preserved.
            shadowed_by_external.append(skill_name)
            skipped += 1
            if not quiet:
                print(
                    f"  ⇢ {skill_name} (deferred to external_dirs, "
                    "not written to local tree)"
                )
            if dest.exists() and _dir_hash(dest) == bundled_hash:
                _rmtree_writable(dest)
                manifest.pop(skill_name, None)
                if not quiet:
                    print(f"  ✓ removed stale shadow of {skill_name}")
            continue

        if skill_name not in manifest:
            # ── New skill — never offered before ──
            try:
                if dest.exists():
                    # User already has a skill with the same name — don't overwrite.
                    # Only baseline in the manifest when the on-disk copy is
                    # byte-identical to bundled (e.g. a reset that re-syncs, or
                    # a coincidentally identical local copy); that case is harmless
                    # to track. If the copy differs (custom skill
                    # or user-edited) skip the manifest write: recording
                    # bundled_hash there would poison update detection by making
                    # user_hash != origin_hash read as "user-modified" on every
                    # subsequent sync, permanently blocking bundled updates.
                    skipped += 1
                    if _dir_hash(dest) == bundled_hash:
                        manifest[skill_name] = bundled_hash
                    elif not quiet:
                        print(
                            f"  ⚠ {skill_name}: bundled version shipped but you "
                            f"already have a local skill by this name — yours "
                            f"was kept. Delete the skill directory to restore the bundled copy "
                            f"to replace it with the bundled version."
                        )
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(skill_src, dest)
                    copied.append(skill_name)
                    manifest[skill_name] = bundled_hash
                    if not quiet:
                        print(f"  + {skill_name}")
            except (OSError, IOError) as e:
                if not quiet:
                    print(f"  ! Failed to copy {skill_name}: {e}")
                # Do NOT add to manifest — next sync should retry

        elif dest.exists():
            # ── Existing skill — in manifest AND on disk ──
            origin_hash = manifest.get(skill_name, "")
            user_hash = _dir_hash(dest)

            if not origin_hash:
                # v1 migration: no origin hash recorded. Set baseline from
                # user's current copy so future syncs can detect modifications.
                manifest[skill_name] = user_hash
                if user_hash == bundled_hash:
                    skipped += 1  # already in sync
                else:
                    # Can't tell if user modified or bundled changed — be safe
                    skipped += 1
                continue

            if user_hash != origin_hash:
                # User modified this skill — don't overwrite their changes
                user_modified.append(skill_name)
                if not quiet:
                    print(f"  ~ {skill_name} (user-modified, skipping)")
                continue

            # User copy matches origin — check if bundled has a newer version
            if bundled_hash != origin_hash:
                try:
                    # Move old copy to a backup so we can restore on failure
                    backup = dest.with_suffix(".bak")
                    # A stale backup from an earlier failure would make
                    # shutil.move() nest dest inside it (or fail) and poison the
                    # restore path below. Current dest is authoritative — clear
                    # the leftover first.
                    if backup.exists():
                        _rmtree_writable(backup)
                    shutil.move(str(dest), str(backup))
                    try:
                        shutil.copytree(skill_src, dest)
                        manifest[skill_name] = bundled_hash
                        updated.append(skill_name)
                        if not quiet:
                            print(f"  ↑ {skill_name} (updated)")
                        # Remove backup after successful copy
                        try:
                            _rmtree_writable(backup)
                        except (OSError, IOError):
                            logger.debug("Could not remove backup %s", backup, exc_info=True)
                    except (OSError, IOError):
                        # Restore from backup. A partially-written dest must not
                        # shadow the user's copy or block the restore — clear it
                        # first, then move the backup home.
                        if backup.exists():
                            if dest.exists():
                                try:
                                    _rmtree_writable(dest)
                                except (OSError, IOError):
                                    logger.warning(
                                        "Could not clear partial copy %s during restore",
                                        dest, exc_info=True,
                                    )
                            if not dest.exists():
                                shutil.move(str(backup), str(dest))
                        raise
                except (OSError, IOError) as e:
                    if not quiet:
                        print(f"  ! Failed to update {skill_name}: {e}")
            else:
                skipped += 1  # bundled unchanged, user unchanged

        else:
            # ── In manifest but not on disk — user deleted it ──
            skipped += 1

    # Clean stale manifest entries (skills removed from bundled dir)
    cleaned = sorted(set(manifest.keys()) - bundled_names)
    for name in cleaned:
        del manifest[name]

    # Also copy DESCRIPTION.md files for categories (if not already present)
    for desc_md in bundled_dir.rglob("DESCRIPTION.md"):
        rel = desc_md.relative_to(bundled_dir)
        dest_desc = SKILLS_DIR / rel
        if not dest_desc.exists():
            try:
                dest_desc.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(desc_md, dest_desc)
            except (OSError, IOError) as e:
                logger.debug("Could not copy %s: %s", desc_md, e)

    _write_manifest(manifest)
    return {
        "copied": copied,
        "updated": updated,
        "skipped": skipped,
        "user_modified": user_modified,
        "cleaned": cleaned,
        "suppressed": suppressed_skipped,
        "total_bundled": len(bundled_skills),
        "shadowed_by_external": shadowed_by_external,
    }


def _rmtree_writable(path: Path) -> None:
    """Remove a directory tree, making read-only entries writable first.

    Handles immutable package sources (Nix store, deb/rpm installs) that
    preserve read-only permissions on copied files *and* directories
    (``r-xr-xr-x``).  Removing a child requires write permission on its
    parent directory, so the retry handler makes the failing path **and its
    parent** writable before re-attempting.  See #34860, #34972.
    """
    # Defense in depth for destructive skill maintenance. Every legitimate
    # caller passes one skill directory (or its adjacent ``.bak`` directory),
    # never SKILLS_DIR itself. Resolve both sides so ``..`` and symlink escapes
    # cannot turn a bad destination into a recursive deletion of FAN_HOME or
    # another directory outside the skills tree.
    target = Path(path).resolve()
    skills_root = SKILLS_DIR.resolve()
    if skills_root not in target.parents:
        raise ValueError(
            f"refusing to rmtree {target!r}: not strictly under "
            f"{skills_root!r} (skills deletion scope guard)"
        )

    import stat

    def _on_error(func, fpath, exc_info):
        # Unlinking a child requires the parent dir to be writable, so chmod
        # the parent as well as the failing path, then retry.
        for target in (os.path.dirname(fpath), fpath):
            try:
                os.chmod(target, stat.S_IRWXU)
            except OSError:
                pass
        func(fpath)

    shutil.rmtree(path, onerror=_on_error)


def reset_bundled_skill(name: str, restore: bool = False) -> dict:
    """
    Reset a bundled skill's manifest tracking so future syncs work normally.

    When a user edits a bundled skill, subsequent syncs mark it as
    ``user_modified`` and skip it forever — even if the user later copies
    the bundled version back into place, because the manifest still holds
    the *old* origin hash. This function breaks that loop.

    Args:
        name: The skill name (matches the manifest key / skill frontmatter name).
        restore: If True, also delete the user's copy in SKILLS_DIR and let
                 the next sync re-copy the current bundled version. If False
                 (default), only clear the manifest entry — the user's
                 current copy is preserved but future updates work again.

    Returns:
        dict with keys:
          - ok: bool, whether the reset succeeded
          - action: one of "manifest_cleared", "restored", "not_in_manifest",
                    "bundled_missing"
          - message: human-readable description
          - synced: dict from sync_skills() if a sync was triggered, else None
    """
    manifest = _read_manifest()
    bundled_dir = _get_bundled_dir()
    bundled_skills = _discover_bundled_skills(bundled_dir)
    bundled_by_name = dict(bundled_skills)

    in_manifest = name in manifest
    is_bundled = name in bundled_by_name

    if not in_manifest and not is_bundled:
        return {
            "ok": False,
            "action": "not_in_manifest",
            "message": (
                f"'{name}' is not a tracked bundled skill. Nothing to reset. "
                f"(Delete the local skill directory to remove it.)"
            ),
            "synced": None,
        }

    # Step 1 (optional): delete the user's copy so next sync re-copies bundled.
    # Must happen BEFORE manifest deletion so that a failed rmtree does not
    # leave the skill in a manifest-less limbo state (see #34972).
    deleted_user_copy = False
    if restore:
        if not is_bundled:
            return {
                "ok": False,
                "action": "bundled_missing",
                "message": (
                    f"'{name}' has no bundled source — manifest entry preserved "
                    f"but cannot restore from bundled (skill was removed upstream)."
                ),
                "synced": None,
            }
        dest = _compute_relative_dest(bundled_by_name[name], bundled_dir)
        if dest.exists():
            try:
                _rmtree_writable(dest)
                deleted_user_copy = True
            except (OSError, IOError) as e:
                return {
                    "ok": False,
                    "action": "not_reset",
                    "message": (
                        f"Could not delete user copy at {dest}: {e}. "
                        f"Manifest entry preserved — nothing was changed."
                    ),
                    "synced": None,
                }

    # Step 2: drop the manifest entry so next sync treats it as new
    if in_manifest:
        del manifest[name]
        _write_manifest(manifest)

    # Step 3: run sync to re-baseline (or re-copy if we deleted)
    synced = sync_skills(quiet=True)

    if restore and deleted_user_copy:
        action = "restored"
        message = f"Restored '{name}' from bundled source."
    elif restore:
        # Nothing on disk to delete, but we re-synced — acts like a fresh install
        action = "restored"
        message = f"Restored '{name}' (no prior user copy, re-copied from bundled)."
    else:
        action = "manifest_cleared"
        message = (
            f"Cleared manifest entry for '{name}'. Future `fan update` runs "
            f"will re-baseline against your current copy and accept upstream changes."
        )

    return {"ok": True, "action": action, "message": message, "synced": synced}


def set_bundled_skills_opt_out(enabled: bool) -> dict:
    """Toggle the .no-bundled-skills opt-out marker for the current Fan home.

    When ``enabled`` is True, writes FAN_HOME/.no-bundled-skills so the
    installer, ``fan update``, and any direct sync stop seeding bundled
    skills. When False, removes the marker so seeding resumes on the next
    sync. This is the on-disk state used by bundled-skill management.
    ``opt-in``; removal of already-present skills is a separate, explicit
    step (see ``remove_pristine_bundled_skills``).

    Returns:
        dict with keys: ok (bool), changed (bool), marker (str path),
                        message (str).
    """
    marker = FAN_HOME / NO_BUNDLED_SKILLS_MARKER
    existed = marker.exists()
    try:
        if enabled:
            FAN_HOME.mkdir(parents=True, exist_ok=True)
            marker.write_text(
                "This Fan home opted out of bundled-skill seeding "
                "(bundled-skills opt-out marker).\n"
                "Delete this file to re-enable sync on the next `fan update`.\n",
                encoding="utf-8",
            )
            changed = not existed
            message = (
                "Opted out of bundled skills. Future install / update / sync "
                "runs will not seed bundled skills into this Fan home."
                if changed
                else "Already opted out — marker was already present."
            )
        else:
            if existed:
                marker.unlink()
            changed = existed
            message = (
                "Opted back in. The next bundled-skills "
                "opt-in --sync`) will re-seed bundled skills."
                if changed
                else "Not opted out — no marker to remove."
            )
    except OSError as e:
        return {
            "ok": False, "changed": False, "marker": str(marker),
            "message": f"Could not update opt-out marker at {marker}: {e}",
        }
    return {"ok": True, "changed": changed, "marker": str(marker), "message": message}



def remove_pristine_bundled_skills(dry_run: bool = False) -> dict:
    """Delete bundled skills that are present, manifest-tracked, AND unmodified.

    Safety is the whole point of this function. A skill on disk is removed
    ONLY when all of these hold:
      - it is recorded in the sync manifest (so it is genuinely a bundled
        skill, not a hand-written one), AND
      - it still exists in the bundled source (so we can hash-compare), AND
      - its on-disk copy is byte-identical to the manifest origin hash
        (so the user has not edited it).

    Anything user-modified or locally authored is left
    untouched and reported under ``skipped``. The manifest entry for each
    removed skill is dropped so a later opt-in re-seed treats it as new.

    Args:
        dry_run: When True, compute what would be removed without deleting.

    Returns:
        dict with keys: ok (bool), removed (list[str]),
                        skipped (list[dict]) where each dict is
                        {name, reason}, dry_run (bool), message (str).
    """
    manifest = _read_manifest()
    bundled_dir = _get_bundled_dir()
    bundled_by_name = dict(_discover_bundled_skills(bundled_dir))

    removed: List[str] = []
    skipped: List[dict] = []

    for name, origin_hash in sorted(manifest.items()):
        src = bundled_by_name.get(name)
        if src is None:
            # Tracked but no longer bundled upstream — leave it; not ours to judge.
            skipped.append({"name": name, "reason": "no bundled source (removed upstream)"})
            continue
        dest = _compute_relative_dest(src, bundled_dir)
        if not dest.exists():
            # Already gone from disk; just forget the stale manifest entry.
            if not dry_run and name in manifest:
                del manifest[name]
            continue
        on_disk = _dir_hash(dest)
        if on_disk != origin_hash:
            skipped.append({"name": name, "reason": "user-modified (kept)"})
            continue
        # Pristine bundled copy — safe to remove.
        if dry_run:
            removed.append(name)
            continue
        try:
            _rmtree_writable(dest)
        except (OSError, IOError) as e:
            skipped.append({"name": name, "reason": f"delete failed: {e}"})
            continue
        if name in manifest:
            del manifest[name]
        removed.append(name)

    if not dry_run and removed:
        _write_manifest(manifest)

    verb = "Would remove" if dry_run else "Removed"
    message = f"{verb} {len(removed)} pristine bundled skill(s); kept {len(skipped)}."
    return {
        "ok": True, "removed": removed, "skipped": skipped,
        "dry_run": dry_run, "message": message,
    }


if __name__ == "__main__":
    print("Syncing bundled skills into ~/.fan/skills/ ...")
    result = sync_skills(quiet=False)
    parts = [
        f"{len(result['copied'])} new",
        f"{len(result['updated'])} updated",
        f"{result['skipped']} unchanged",
    ]
    if result["user_modified"]:
        names = result["user_modified"]
        MAX_SHOW = 5
        shown = ", ".join(names[:MAX_SHOW])
        if len(names) > MAX_SHOW:
            shown += f", +{len(names) - MAX_SHOW} more"
        parts.append(f"{len(names)} user-modified (kept): {shown}")
    if result["cleaned"]:
        parts.append(f"{len(result['cleaned'])} cleaned from manifest")
    print(f"\nDone: {', '.join(parts)}. {result['total_bundled']} total bundled.")
