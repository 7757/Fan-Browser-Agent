import json
import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DESKTOP_PACKAGE = PROJECT_ROOT / "apps" / "desktop" / "package.json"
ROOT_LOCK = PROJECT_ROOT / "package-lock.json"
EXACT_SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


def _desktop_package() -> dict:
    return json.loads(DESKTOP_PACKAGE.read_text(encoding="utf-8"))


def _electron_spec(package: dict) -> str:
    for section in ("dependencies", "devDependencies"):
        value = package.get(section, {}).get("electron")
        if value:
            return value
    raise AssertionError("Electron is missing from the desktop package")


def test_electron_dependency_is_an_exact_version():
    spec = _electron_spec(_desktop_package())

    assert EXACT_SEMVER.fullmatch(spec), (
        f"Electron must be exactly pinned, got {spec!r}; a range can silently "
        "change its native postinstall implementation."
    )


def test_electron_dependency_matches_builder_version():
    package = _desktop_package()

    assert _electron_spec(package) == package.get("build", {}).get("electronVersion")


def test_lockfile_resolves_only_the_pinned_electron_version():
    spec = _electron_spec(_desktop_package())
    lock = json.loads(ROOT_LOCK.read_text(encoding="utf-8"))
    resolved = {
        metadata.get("version")
        for path, metadata in lock.get("packages", {}).items()
        if path.endswith("node_modules/electron") and metadata.get("version")
    }

    assert resolved == {spec}
