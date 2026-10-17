#!/usr/bin/env bash
# Small-account feature matrix: run every stored-row surface against one
# account and record each payload + exit code.
#
#   scripts/small-account-matrix.sh <username> [output-dir]
#
# Reads only: nothing is fetched except `lookup`, whose browser probe persists
# nothing. Live surfaces (investigate / public / post / anonstories) stay
# manual because they take minutes; run them separately when needed.
#
# Uses the configured provider from .env (override with IGTRACK_PROVIDER).
set -euo pipefail

username="${1:?usage: scripts/small-account-matrix.sh <username> [output-dir]}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${2:-$root/.tmp/account-matrix/$(date -u +%Y%m%dT%H%M%SZ)-${username}}"
mkdir -p "$out"
cd "$root"

cli=(node apps/cli/bin/igtrack.mjs)

run() {
  local name=$1
  shift
  if ! "${cli[@]}" "$@" --json > "$out/$name.json" 2> "$out/$name.err"; then
    echo "FAIL $name: igtrack $* --json (see $out/$name.err)" >&2
    exit 1
  fi
  printf '%s exit=0 cmd=igtrack %s --json\n' "$name" "$*" >> "$out/SUMMARY.txt"
  printf '  ok  %s\n' "$name"
}

echo "Account: $username"
echo "Output:  $out"

run status status
run dossier dossier "$username"
run insights insights "$username"
run relationships relationships "$username"
run tags tags "$username"
run activity activity --since 7d
run report report "$username" --period weekly
run reports reports "$username" --period weekly
run recent recent "$username"
run audience audience "$username"
run export_posts export "$username" --kind posts --format json
run digest digest "$username" --since 7d
run research research "$username"
run plan plan "$username"
run evidence evidence "$username"
run scans_list scans "$username"
run lookup lookup "$username"
run doctor doctor

echo "All 18 surfaces exited 0. Payloads: $out"
