#!/usr/bin/env bash
# Claude Code Review — Notification hook v8.1
# Managed by Claude Code Review extension. Do not edit manually.
# Forwards notifications to the extension server which decides whether to show OS alerts.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
CCR_PORT=$(cat "$HOOK_DIR/../ccr-port" 2>/dev/null || echo 27182)

INPUT=$(cat)

curl -s -X POST http://127.0.0.1:$CCR_PORT/notify   -H "Content-Type: application/json"   -d "$INPUT" 2>/dev/null || true

exit 0
