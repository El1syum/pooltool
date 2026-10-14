# Pooltool Online operations

The service is isolated from Cyberpool and other applications. It uses
`/opt/pooltool-online`, port 8790, its own SQLite data and systemd unit.
The operator account on the authorized `el1s` host is `ops` with passwordless sudo.
Do not clear other applications or files to make room for this release.

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
Readiness is checked for up to 120 seconds: cold JIT initialization on the shared
two-vCPU host took about 50 seconds, while a cached restart took about 2 seconds.

Service logs: `sudo journalctl -u pooltool-online.service -f`.
Readiness: `curl --fail http://127.0.0.1:8790/ready`.
Runtime configuration: `/opt/pooltool-online/shared/server.env` (mode 600).
Use HTTPS/WSS behind a reverse proxy before VK integration or public production
authentication. The direct HTTP port is intended for functional testing.

## Persistence and recovery

Back up the database with SQLite's online backup API rather than copying an
active WAL file alone. Stop/start/restart of the service preserves rooms,
registered commands, results, profiles, Elo and telemetry. Reconnect grants a
fresh grace period after server restart. Pending simulations resume from durable
state. Confirm readiness before directing players to a new release.

For rollback, stop the service, point `/opt/pooltool-online/current` to a verified
prior release, and start the service using its existing release environment.
Do not roll back the database without a matching backup.

There is one ASGI service worker and a configurable bounded count of killable CPU
workers. Configure PHYSICS_WORKERS=1 on the current two-vCPU host to preserve
capacity for its existing applications. A timed-out computation releases its
slot; the server restores the confirmed state and records the rejection.
