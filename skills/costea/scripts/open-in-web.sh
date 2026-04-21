#!/usr/bin/env bash
set -euo pipefail

# Costea — open the current task in the Web UI /estimate page.
#
# Usage:
#   open-in-web.sh "refactor the auth module"
#   open-in-web.sh --print "refactor the auth module"   # print URL only
#   open-in-web.sh --json '{"task":"…",…}'              # read task from JSON
#
# The URL is built from COSTEA_WEB_URL (default: http://localhost:3000).
# Opens the system browser via `open` (macOS), `xdg-open` (Linux), or
# `start` (Windows/Git Bash). With --print, only the URL is echoed to
# stdout so the caller can embed it in receipts or share sheets.

BASE="${COSTEA_WEB_URL:-http://localhost:3000}"
MODE="open"
TASK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print|-p) MODE="print"; shift ;;
    --json|-j)
      if ! command -v jq &>/dev/null; then
        echo "Error: --json requires jq" >&2
        exit 1
      fi
      TASK=$(echo "$2" | jq -r '.task // empty')
      shift 2
      ;;
    --base) BASE="$2"; shift 2 ;;
    -h|--help)
      sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) TASK="$1"; shift ;;
  esac
done

if [[ -z "$TASK" ]]; then
  echo "Usage: open-in-web.sh [--print] <task>" >&2
  exit 1
fi

# URL-encode without depending on python/jq (works in plain bash).
urlencode() {
  local raw="$1" out="" i c
  for (( i=0; i<${#raw}; i++ )); do
    c="${raw:i:1}"
    case "$c" in
      [a-zA-Z0-9._~-]) out+="$c" ;;
      ' ')             out+="%20" ;;
      *)               printf -v out '%s%%%02X' "$out" "'$c" ;;
    esac
  done
  printf '%s' "$out"
}

ENCODED=$(urlencode "$TASK")
URL="${BASE%/}/estimate?task=${ENCODED}"

if [[ "$MODE" == "print" ]]; then
  printf '%s\n' "$URL"
  exit 0
fi

# Open cross-platform.
if command -v open &>/dev/null; then
  open "$URL"
elif command -v xdg-open &>/dev/null; then
  xdg-open "$URL" >/dev/null 2>&1
elif command -v start &>/dev/null; then
  start "" "$URL"
else
  # No opener available — degrade to printing so the user can copy it.
  printf '%s\n' "$URL"
fi
