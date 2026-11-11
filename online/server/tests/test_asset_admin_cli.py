"""Credential generation never writes or prints a secret in the repository."""

import os
from pathlib import Path
import re

import pytest

from online.ops.create_asset_admin import create_credentials, main, private_target
from online.server.assets import verify_admin_password


def test_private_credentials_hash_only_env_and_no_stdout(tmp_path, capsys):
    handoff, environment = tmp_path / "handoff.md", tmp_path / "admin.env"
    assert main(["--output", str(handoff), "--env-output", str(environment)]) == 0
    document, env = handoff.read_text(encoding="utf-8"), environment.read_text(encoding="utf-8")
    password = re.search(r"```text\n([^\n]+)\n```", document).group(1)
    values = dict(line.split("=", 1) for line in env.splitlines() if line and not line.startswith("#"))
    assert values["ASSET_ADMIN_USERNAME"] == "model-admin"
    assert verify_admin_password(password, values["ASSET_ADMIN_PASSWORD_HASH"])
    assert password not in env
    captured = capsys.readouterr()
    assert password not in captured.out + captured.err
    assert values["ASSET_ADMIN_PASSWORD_HASH"] not in captured.out + captured.err
    if os.name != "nt":
        assert handoff.stat().st_mode & 0o777 == 0o600
        assert environment.stat().st_mode & 0o777 == 0o600


def test_refuses_any_existing_output_without_partial_creation(tmp_path):
    handoff, environment = tmp_path / "handoff.md", tmp_path / "admin.env"
    environment.write_text("do-not-change", encoding="utf-8")
    with pytest.raises(FileExistsError):
        create_credentials(username="admin", output=handoff, env_output=environment)
    assert not handoff.exists()
    assert environment.read_text(encoding="utf-8") == "do-not-change"


def test_refuses_project_or_nested_git_worktree(tmp_path):
    repository = Path(__file__).resolve().parents[3]
    with pytest.raises(ValueError):
        private_target(repository / "do-not-create-admin.md")
    nested = tmp_path / "other-repository"
    nested.mkdir()
    (nested / ".git").write_text("gitdir: elsewhere", encoding="utf-8")
    with pytest.raises(ValueError):
        private_target(nested / "secret.md")


def test_failure_creating_second_file_removes_only_own_first(tmp_path, monkeypatch):
    import online.ops.create_asset_admin as helper
    original = helper._private_write
    count = [0]

    def failing(path, content):
        count[0] += 1
        if count[0] == 2:
            raise OSError("test write failure")
        return original(path, content)

    monkeypatch.setattr(helper, "_private_write", failing)
    with pytest.raises(OSError):
        create_credentials(username="admin", output=tmp_path / "handoff.md", env_output=tmp_path / "admin.env")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("username", ["bad\nASSET=oops", "admin user", ""])
def test_rejects_env_unsafe_username(tmp_path, username):
    with pytest.raises(ValueError):
        create_credentials(username=username, output=tmp_path / "handoff.md", env_output=tmp_path / "admin.env")
    assert list(tmp_path.iterdir()) == []
