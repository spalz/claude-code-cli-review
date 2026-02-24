#!/usr/bin/env bash
# Claude Code Review — Notification hook v8.2
# Managed by Claude Code Review extension. Do not edit manually.
# Forwards notifications to the extension server which decides whether to show OS alerts.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
CCR_PORT_FILE="$HOOK_DIR/../ccr-port"
[[ ! -f "$CCR_PORT_FILE" ]] && exit 0
CCR_PORT=$(cat "$CCR_PORT_FILE")

INPUT=$(cat)

curl -s -X POST http://127.0.0.1:$CCR_PORT/notify   -H "Content-Type: application/json"   -d "$INPUT" 2>/dev/null || true

exit 0
