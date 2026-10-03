#!/usr/bin/env bash
# Run as root on Ubuntu 24.04. No account or tenant identifiers belong here.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
account=teams-bridge-probe
home=/var/lib/teams-bridge-probe
if ! id "$account" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$home" --shell /usr/sbin/nologin "$account"
fi
test "$(getent passwd "$account" | cut -d: -f6)" = "$home"
install -d -m 0700 -o "$account" -g "$account" "$home" "$home/app" "$home/profile" "$home/state"
apt-get update -qq
apt-get install -y --no-install-recommends xvfb x11vnc novnc python3-websockify libgtk-3-0 libnss3 libgbm1 libasound2t64
printf '%s\n' 'Private browser prerequisites installed.'
