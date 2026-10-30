#!/usr/bin/env bash
# Retain live process, container and JavaScript evidence shortly before the
# runnerd step cap. Observation only: it never signals anything but the
# inspector request and never changes the outcome of the profile.
set -uo pipefail
EVIDENCE="$1"
DELAY_SECONDS="$2"
sleep "$DELAY_SECONDS"
out="$EVIDENCE/hang-diagnostics"
mkdir -p "$out"
snapshot() {
  date -u +%FT%TZ
  ps -eo pid,ppid,etime,time,stat,wchan:32,args --forest
}
snapshot > "$out/ps-1.txt" 2>&1
timeout 30 docker ps -a > "$out/docker-ps.txt" 2>&1
container="$(cat "$EVIDENCE/remote-continuity-container.id" 2>/dev/null || true)"
if [ -n "$container" ]; then
  timeout 30 docker logs --tail 200 "$container" > "$out/docker-logs.txt" 2>&1
  timeout 30 docker exec "$container" ps -eo pid,ppid,etime,time,stat,args > "$out/container-ps.txt" 2>&1
fi
for pid in $(pgrep -f 'vitest/dist/workers/' | head -n 1); do
  timeout 120 node .github/scripts/inspect-hung-node.mjs "$pid" > "$out/worker-$pid-profile.txt" 2>&1
done
snapshot > "$out/ps-2.txt" 2>&1
