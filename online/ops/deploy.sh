#!/usr/bin/env bash
set -euo pipefail

archive=${1:?Usage: sudo bash deploy.sh /absolute/release.tgz}
app_root=${APP_ROOT:-/opt/pooltool-online}
case "$app_root" in /opt/pooltool-online) ;; *) echo 'APP_ROOT must be /opt/pooltool-online' >&2; exit 1 ;; esac
test -f "$archive"
release="$app_root/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d "$release" "$app_root/shared"
tar -xzf "$archive" -C "$release"
python3 -m venv "$release/.venv"
python="$release/.venv/bin/python"
"$python" -m pip install --no-cache-dir --extra-index-url https://archive.panda3d.org/simple/ -r "$release/online/runtime-requirements.txt"
"$python" -m pip install --no-deps -e "$release"
install -d -o ops -g ops "$app_root/shared/data" "$app_root/shared/cache" "$app_root/shared/home"
if ! test -f "$app_root/shared/server.env"; then
  install -m 600 -o ops -g ops "$release/online/ops/server.env.example" "$app_root/shared/server.env"
fi
previous=$(readlink -f "$app_root/current" || true)
ln -sfn "$release" "$app_root/current"
install -m 644 "$release/online/ops/pooltool-online.service" /etc/systemd/system/pooltool-online.service
systemctl daemon-reload
systemctl enable --now pooltool-online.service
systemctl restart pooltool-online.service
for attempt in $(seq 1 120); do
  if curl --fail --silent http://127.0.0.1:8790/ready >/dev/null; then
    echo "Pooltool Online ready: $release"
    exit 0
  fi
  sleep 1
done
journalctl -u pooltool-online.service -n 60 --no-pager
if test -n "$previous" && test -x "$previous/.venv/bin/python"; then
  ln -sfn "$previous" "$app_root/current"
  systemctl restart pooltool-online.service
  echo "Readiness failed; restored previous release: $previous" >&2
fi
exit 1
