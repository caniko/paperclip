#!/usr/bin/env bash
set -euo pipefail

render="$1"
store_credential="$2"
umask 0077
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
gateway="$fixture/gateway"
research="$fixture/research"
environment="$fixture/env"

printf 'gateway-valid\n' > "$gateway"
printf 'tvly-valid\n' > "$research"
bash "$render" "$environment" "$gateway" "$research"
printf 'API_SERVER_KEY=gateway-valid\nTAVILY_API_KEY=tvly-valid\n' > "$fixture/expected"
cmp "$fixture/expected" "$environment"
test "$(stat -c '%a' "$environment")" = 600

reject() {
  if bash "$render" "$environment" "$gateway" "$research" > "$fixture/stdout" 2> "$fixture/stderr"; then
    echo 'malformed worker credentials were accepted' >&2
    exit 1
  fi
  test ! -s "$fixture/stdout"
  cmp "$fixture/expected" "$environment"
}

# Validate the actual source, not just the configured path spelling.
chmod 0644 "$research"
reject
chmod 0640 "$research"
bash "$render" "$environment" "$gateway" "$research"
cmp "$fixture/expected" "$environment"
mv "$research" "$fixture/private-research"
ln -s "$store_credential" "$research"
reject
rm "$research"
ln -s "$fixture/private-research" "$research"
bash "$render" "$environment" "$gateway" "$research"
cmp "$fixture/expected" "$environment"
rm "$research"
mkfifo "$research"
reject
rm "$research"
mkdir "$research"
reject
rmdir "$research"
mv "$fixture/private-research" "$research"

for bad in 'tvly\nother' 'tvly\n\n' 'tvly\r\n' 'tvly\000other' 'tvly\000\n' 'tvly"other' 'tvly\tother'; do
  printf '%b' "$bad" > "$research"
  reject
done
printf '' > "$research"
reject
rm "$research"
reject
printf 'tvly-valid' > "$research"
printf 'gateway\000other' > "$gateway"
reject
printf 'gateway\r\n' > "$gateway"
reject

# A worker without a research credential must not receive web access.
printf 'gateway-valid' > "$gateway"
bash "$render" "$environment" "$gateway"
printf 'API_SERVER_KEY=gateway-valid\n' > "$fixture/expected"
cmp "$fixture/expected" "$environment"
test "$(stat -c '%a' "$environment")" = 600
