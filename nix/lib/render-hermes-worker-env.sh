#!/usr/bin/env bash
# Render the Hermes gateway environment from runtime files, never from Nix values.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo 'hermes worker environment: expected output, gateway file, optional research file' >&2
  exit 1
fi

output="$1"
gateway_file="$2"

read_token() {
  local file="$1" token
  if [ ! -s "$file" ]; then
    echo 'hermes worker environment: missing or empty credential' >&2
    return 1
  fi

  # Bash drops NULs and trailing LF bytes during command substitution. Compare
  # the original file to the accepted form before using the converted string.
  token="$(cat "$file")" || return 1
  if [[ ! "$token" =~ ^[A-Za-z0-9._~:/?@%+=,-]+$ ]] ||
    { ! cmp -s "$file" <(printf '%s' "$token") &&
      ! cmp -s "$file" <(printf '%s\n' "$token"); }; then
    echo 'hermes worker environment: invalid credential bytes' >&2
    return 1
  fi
  printf '%s' "$token"
}

gateway_key="$(read_token "$gateway_file")"
if [ "$#" -eq 3 ]; then
  research_key="$(read_token "$3")"
fi

# The parent directory is root-owned by systemd RuntimeDirectory. Publish in
# the same directory so an already running worker sees either complete version.
temporary="$(mktemp "${output}.XXXXXXXX")"
trap 'rm -f "$temporary"' EXIT
chmod 0600 "$temporary"
printf 'API_SERVER_KEY=%s\n' "$gateway_key" > "$temporary"
if [ "$#" -eq 3 ]; then
  printf 'TAVILY_API_KEY=%s\n' "$research_key" >> "$temporary"
fi
mv -f "$temporary" "$output"
