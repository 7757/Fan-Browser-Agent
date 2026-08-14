import os

from tools.environments import local


def _fake_isdir(existing):
    normalized = {path.replace("\\", "/") for path in existing}
    return lambda path: path.replace("\\", "/") in normalized


def test_derives_coreutils_from_portable_git_layout(monkeypatch):
    monkeypatch.setattr(local, "_IS_WINDOWS", True)
    monkeypatch.setattr(local, "_git_bash_bin_dirs_cache", None)
    monkeypatch.setattr(local, "_find_bash", lambda: "/portable/bin/bash.exe")
    monkeypatch.setattr(
        local.os.path,
        "isdir",
        _fake_isdir(
            {
                "/portable/mingw64/bin",
                "/portable/usr/bin",
                "/portable/bin",
            }
        ),
    )

    directories = local._git_bash_bin_dirs()

    assert directories == [
        "/portable/mingw64/bin",
        "/portable/usr/bin",
        "/portable/bin",
    ]


def test_derives_root_when_bash_lives_under_usr_bin(monkeypatch):
    monkeypatch.setattr(local, "_IS_WINDOWS", True)
    monkeypatch.setattr(local, "_git_bash_bin_dirs_cache", None)
    monkeypatch.setattr(local, "_find_bash", lambda: "/mingit/usr/bin/bash.exe")
    monkeypatch.setattr(
        local.os.path,
        "isdir",
        _fake_isdir({"/mingit/mingw64/bin", "/mingit/usr/bin"}),
    )

    assert local._git_bash_bin_dirs() == [
        "/mingit/mingw64/bin",
        "/mingit/usr/bin",
    ]


def test_git_bash_path_helper_is_empty_off_windows(monkeypatch):
    monkeypatch.setattr(local, "_IS_WINDOWS", False)
    monkeypatch.setattr(local, "_git_bash_bin_dirs_cache", None)

    assert local._git_bash_bin_dirs() == []


def test_prepend_git_bash_dirs_is_idempotent(monkeypatch):
    monkeypatch.setattr(os, "pathsep", ";")
    monkeypatch.setattr(local, "_git_bash_bin_dirs_cache", [
        "/portable/usr/bin",
        "/portable/bin",
    ])
    existing = r"/portable/usr/bin;C:\Windows\System32;/portable/bin"

    assert local._prepend_git_bash_dirs(existing) == existing


def test_run_environment_places_coreutils_before_system32(monkeypatch):
    monkeypatch.setattr(os, "pathsep", ";")
    monkeypatch.setattr(local, "_IS_WINDOWS", True)
    monkeypatch.setattr(local, "_git_bash_bin_dirs_cache", [
        "/portable/mingw64/bin",
        "/portable/usr/bin",
    ])
    monkeypatch.setattr(local, "_FAN_BIN_DIR", None)

    run_env = local._make_run_env({"PATH": r"C:\Windows\System32"})
    entries = run_env["PATH"].split(";")

    assert entries[:2] == [
        "/portable/mingw64/bin",
        "/portable/usr/bin",
    ]
    assert entries[2] == r"C:\Windows\System32"


def test_run_environment_does_not_inject_git_paths_on_posix(monkeypatch):
    monkeypatch.setattr(local, "_IS_WINDOWS", False)
    monkeypatch.setattr(local, "_git_bash_bin_dirs_cache", None)
    monkeypatch.setattr(local, "_FAN_BIN_DIR", None)

    run_env = local._make_run_env({"PATH": "/custom/bin:/usr/bin"})

    assert "mingw" not in run_env["PATH"]
