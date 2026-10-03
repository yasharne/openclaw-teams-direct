#!/usr/bin/env bash
# Run as root after installing experiment dependencies/browser in app/.
set -euo pipefail
account=teams-bridge-probe
home=/var/lib/teams-bridge-probe
chrome=$(find "$home/.cache/ms-playwright" -path '*/chrome-linux64/chrome' -type f -print -quit)
test -n "$chrome"
systemd-run --collect --unit=teams-probe-display --uid="$account" --property=UMask=0077 /usr/bin/Xvfb :97 -screen 0 1440x900x24 -nolisten tcp
for attempt in {1..10}; do
  test -S /tmp/.X11-unix/X97 && break
  sleep 1
done
test -S /tmp/.X11-unix/X97
systemd-run --collect --unit=teams-probe-vnc --uid="$account" --property=UMask=0077 /usr/bin/x11vnc -display :97 -localhost -rfbport 5997 -nopw -forever -shared -quiet
systemd-run --collect --unit=teams-probe-web --uid="$account" --property=UMask=0077 /usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5997
# sandbox disabled only inside this dedicated unprivileged probe account;
# do not use this browser profile for unrelated browsing.
systemd-run --collect --unit=teams-probe-browser --uid="$account" --setenv=HOME="$home" --setenv=DISPLAY=:97 --property=UMask=0077 --property=StandardOutput=null --property=StandardError=null "$chrome" --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$home/profile" https://teams.cloud.microsoft/
printf '%s\n' 'Browser access listens on host loopback port 6080; use an SSH tunnel.'
