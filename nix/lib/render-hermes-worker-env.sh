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
  local file="$1" token resolved credential opened mode size
  if ! resolved="$(readlink -e -- "$file")" || [ ! -f "$resolved" ] ||
    ! { exec {credential}<"$resolved"; } 2>/dev/null; then
    echo 'hermes worker environment: invalid credential source' >&2
    return 1
  fi
  # Bind validation and all byte reads to the same opened inode. Runtime
  # symlink rotation must not substitute an unchecked source between reads.
  opened="/proc/$BASHPID/fd/$credential"
  resolved="$(readlink -e -- "$opened")" || return 1
  read -r mode size <<< "$(stat -Lc '%a %s' -- "$opened")"
  if [ ! -f "$opened" ] || [[ "$resolved" == /nix/store || "$resolved" == /nix/store/* ]] ||
    (( (8#$mode & 7) != 0 || size == 0 || size > 1048576 )); then
    echo 'hermes worker environment: invalid credential source' >&2
    return 1
  fi

  # Bash drops NULs and trailing LF bytes during command substitution. Compare
  # the original file to the accepted form before using the converted string.
  token="$(head -c 1048577 -- "$opened")" || return 1
  if [[ ! "$token" =~ ^[A-Za-z0-9._~:/?@%+=,-]+$ ]] ||
    (( ${#token} > 1048576 )) ||
    { ! cmp -s "$opened" <(printf '%s' "$token") &&
      ! cmp -s "$opened" <(printf '%s\n' "$token"); }; then
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
