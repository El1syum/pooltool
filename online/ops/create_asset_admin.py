"""Create private, never-overwritten model-admin handoff and hash-only env files.

Run as a module from the repository root. No password/hash is printed, placed in
command-line arguments, or persisted within a Git worktree. The caller provisions
the resulting env values and restarts the service separately.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
from getpass import getpass
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

from online.server.assets import hash_admin_password


def private_target(value: str | Path) -> Path:
    path = Path(value).expanduser().absolute()
    if path.is_symlink():
        raise ValueError("Output must not be a symbolic link")
    path = path.resolve()
    repository = Path(__file__).resolve().parents[2]
    if path == repository or path.is_relative_to(repository):
        raise ValueError("Credential outputs must be outside the project")
    if any((parent / ".git").exists() for parent in (path.parent, *path.parents)):
        raise ValueError("Credential outputs must be outside every Git worktree")
    if path.exists():
        raise FileExistsError("Refusing to overwrite an existing credential output")
    return path


def _restrict_windows_file(path: Path):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    identity = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], check=True,
                              capture_output=True, text=True, creationflags=flags)
    row = next(csv.reader(identity.stdout.strip().splitlines()))
    sid = row[-1].strip()
    if not re.fullmatch(r"S-1-[0-9-]+", sid):
        raise ValueError("Could not resolve the current Windows identity")
    # The new empty file has no inherited access after this operation. Apply the
    # ACL before writing secrets; avoid changing permissions of existing folders.
    subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"*{sid}:F"],
                   check=True, capture_output=True, text=True, creationflags=flags)


def _private_write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # O_EXCL closes the validation/write race; refuse symlinks where supported.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        if os.name == "nt":
            _restrict_windows_file(path)
        else:
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            fd = None
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        if fd is not None:
            os.close(fd)
        path.unlink(missing_ok=True)
        raise


def create_credentials(*, username: str, output: str | Path, env_output: str | Path,
                       password: str | None = None) -> tuple[Path, Path]:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", username):
        raise ValueError("Username must be 1–64 ASCII letters, digits, dot, underscore or hyphen")
    handoff, environment = private_target(output), private_target(env_output)
    if handoff == environment:
        raise ValueError("Handoff and environment outputs must be different files")
    password = secrets.token_urlsafe(24) if password is None else password
    if any(ord(char) < 32 or ord(char) == 127 for char in password):
        raise ValueError("Password must not contain control characters")
    password_hash = hash_admin_password(password)
    # A generated password is safe in a code block. Prompted passwords may contain
    # arbitrary backticks, so choose a fence that cannot terminate early.
    longest = max((len(match.group()) for match in re.finditer(r"`+", password)), default=0)
    fence = "`" * max(3, longest + 1)
    created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    document = (
        "# Pooltool model-library administrator — private\n\n"
        f"Created: {created}\n\n"
        f"Username: `{username}`\n\n"
        f"Password:\n\n{fence}text\n{password}\n{fence}\n\n"
        "Keep this file private and outside Git. This password is only for the\n"
        "model-library administration, not the player's game account.\n\n"
        "The current HTTP testing preview is unencrypted: do not reuse this\n"
        "password anywhere else. Use HTTPS before production/VK publication.\n\n"
        "Provision the companion hash-only environment file on the server, then\n"
        "restart the service once. Do not source the file in a shell; the scrypt\n"
        "hash contains literal dollar signs. Changing either credential invalidates\n"
        "existing admin sessions after restart.\n"
    )
    env = ("# Private model-admin configuration; no plaintext password.\n"
           f"ASSET_ADMIN_USERNAME={username}\nASSET_ADMIN_PASSWORD_HASH={password_hash}\n")
    created_paths = []
    try:
        _private_write(handoff, document)
        created_paths.append(handoff)
        _private_write(environment, env)
        created_paths.append(environment)
    except BaseException:
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise
    return handoff, environment


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", default="model-admin")
    parser.add_argument("--output", type=Path, required=True, help="Private Markdown handoff path outside Git")
    parser.add_argument("--env-output", type=Path, required=True, help="Hash-only env path outside Git")
    parser.add_argument("--prompt-password", action="store_true", help="Use hidden input instead of generating a unique password")
    args = parser.parse_args(argv)
    try:
        password = None
        if args.prompt_password:
            password = getpass("Unique testing-only model-admin password: ")
            if password != getpass("Repeat password: "):
                raise ValueError("Passwords do not match")
        create_credentials(username=args.username, output=args.output, env_output=args.env_output, password=password)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # No repr of arguments, hashes or password. Only safe class/message strings.
        print(f"Credential files were not created: {type(error).__name__}", file=sys.stderr)
        return 1
    print("Private handoff and hash-only environment files created. No credentials were printed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
