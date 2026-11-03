# Pooltool Online operations

The service is isolated from Cyberpool and other applications. It uses
`/opt/pooltool-online`, port 8790, its own SQLite data and systemd unit.
The operator account on the authorized `el1s` host is `ops` with passwordless sudo.
Do not clear other applications or files to make room for this release.
Resolve the current hostname from the `el1s` SSH configuration before publishing
a preview link: the host address can change. Do not reuse a stale IP from an
older delivery note. The match HUD can be updated as static frontend assets
without restarting the Python service: back up the current frontend first,
install hashed assets/fonts before `dist/index.html`, then verify `/ready` and
run the live browser smoke checks. Keep old hashed chunks for already-open games.

The ordinary preview URL `/` serves the current frontend; a `?v=` parameter is
not part of deployment or routing. HTML entry documents (including conditional
304 and HEAD responses) use `Cache-Control: no-store`, while hashed assets keep
their normal static-file behavior. Applying this header policy requires a Python
service restart. A tab that had already cached the older HTML before this policy
may need one hard reload; the server cannot retroactively change that cached
response's headers.

## Deployment

Build `online/client/dist`, package the repository's checked-out `pooltool`,
`online`, `pyproject.toml`, `README.md` and `LICENSE.txt`. Exclude `.venv`,
`node_modules`, caches, telemetry/data and local environment files. Include the
original ball GLBs: pooltool's import checks ballset resources even in headless
mode. The root fork was obtained with a sparse checkout excluding huge room art;
server physics needs no room render models.

Upload the archive then run:

```bash
sudo bash /tmp/pooltool-release/online/ops/deploy.sh /tmp/pooltool-online.tgz
```

Dependencies are installed into a separate `.venv` inside each release before the
active symlink changes. A failed readiness check restores the prior verified
release. Installation errors leave the active service and its dependencies alone.
Readiness is checked for up to 240 seconds (it now includes warming the first
physics worker): cold JIT initialization on the shared
two-vCPU host took about 50 seconds, while a cached restart took about 2 seconds.

Service logs: `sudo journalctl -u pooltool-online.service -f`.
Readiness: `curl --fail http://127.0.0.1:8790/ready`.
Runtime configuration: `/opt/pooltool-online/shared/server.env` (mode 600).
Use HTTPS/WSS behind a reverse proxy before VK integration or public production
authentication. The direct HTTP port is intended for functional testing.

## Shared visual model library

The model workshop uses a separate administrator login, not the guest player's
nickname or game token. Configure `ASSET_ADMIN_USERNAME` and
`ASSET_ADMIN_PASSWORD_HASH` in the private server environment. Empty or malformed
credentials fail closed: the public library remains readable but no administrator
can log in. Generate a hash without placing a plaintext password on a command line:

For an initial handoff, use the credential helper instead: it creates a unique
password in a private Markdown file and a separate hash-only environment fragment.
Both output paths are required, must be outside every Git worktree, and must not
already exist. Files use mode 0600 on POSIX or a current-user-only Windows ACL,
applied before secrets are written. Nothing secret is printed. For example:

```powershell
.venv\Scripts\python.exe -m online.ops.create_asset_admin --output C:/Users/User/.codex/secrets/pooltool-model-admin-20261103.md --env-output C:/Users/User/.codex/secrets/pooltool-model-admin-20261103.env
```

The default username is `model-admin`; override it with `--username`. Use
`--prompt-password` for hidden manual input instead of generation. This helper
does not upload credentials or restart the service. For a hash-only manual setup:

```bash
.venv/bin/python -c 'from getpass import getpass; from online.server.assets import hash_admin_password; print(hash_admin_password(getpass("Unique model-admin password: ")))'
```

The stored format is `scrypt$16384$8$1$<salt>$<digest>`. Copy the hash literally;
do not expand its `$` characters in a shell. Store no plaintext password in Git.
Changing either credential invalidates prior administrator sessions after the
service restarts. Sessions expire after eight hours and only their SHA-256 token
hashes are stored in SQLite. Login is rate-limited by client IP and username.
Writes require the HttpOnly/SameSite=Strict cookie plus an `X-Asset-CSRF` token;
the session restore endpoint returns that token without requiring a CSRF header.

The user explicitly permits administrator login over the current HTTP testing
preview. HTTP does not encrypt credentials, cookies, or model uploads: use a unique
testing-only password and do not reuse production credentials. The cookie is
automatically Secure on actual HTTPS. This exception does not change the HTTPS
requirement for a later public/VK production deployment.

Set `POOLTOOL_ASSET_ROOT=/opt/pooltool-online/shared/assets`; without it the
directory defaults to `assets` alongside the configured SQLite database. This
directory must be persistent across releases, readable/writable by the service,
and not a source-code/static-build directory. Back up both this directory and the
database. The database stores public selection/configuration, metadata, and
administrator session hashes; files are immutable GLBs with server-generated IDs.

Only self-contained GLB 2 files are accepted, at most 50 MiB each, 500 records and
2 GiB total (including disabled records). Uploads stream to bounded temporary
files, are validated before publication, hashed and atomically renamed. External
URIs, malformed container/geometry ranges, excessive geometry/node counts, cycles
and required external decoder extensions are rejected. Clients also enforce their
renderer resource limits. Disabling a model is reversible and clears its selected
slot; it does not delete its file. Permanent purge is deliberately not exposed in
the workshop. An empty library keeps the procedural table/environment fallback.
Visual assets never change authoritative physics geometry.

The existing HTTP preview can keep the generated hash-only values in
`/opt/pooltool-online/shared/asset-admin.env` (mode 600, service-owned). Install
`asset-library-preview.conf` as a service drop-in to load this separate file;
the main `server.env` and migration guard stay unchanged. Run daemon-reload and
restart once, then verify `/ready` and `/api/assets/admin/session` before use.
The plaintext handoff stays outside Git on the operator's computer.

## Persistence and recovery

Back up the database with SQLite's online backup API rather than copying an
active WAL file alone. Stop/start/restart of the service preserves rooms,
registered commands, results, profiles, Elo and telemetry. Reconnect grants a
fresh grace period after server restart. Pending simulations resume from durable
state. Confirm readiness before directing players to a new release.

For rollback, stop the service, point `/opt/pooltool-online/current` to a verified
prior release, and start the service using its existing release environment.
Do not roll back the database without a matching backup.

There is one ASGI service worker and a configurable count of pre-warmed, killable
CPU workers (PHYSICS_WORKERS). Each stays resident (about 230 MB measured locally)
so shots do not pay process startup and JIT warmup. Configure PHYSICS_WORKERS=1 on
the current two-vCPU host to preserve capacity for its existing applications.
`/ready` returns 503 until one worker is warm, so the deploy readiness check also
covers warmup. A timed-out or crashed computation kills that worker and a
replacement warms in the background; the server restores the confirmed state and
records the rejection. With one worker, shots arriving during that warmup wait up
to SHOT_COMPUTE_TIMEOUT_SECONDS.
