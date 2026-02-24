#!/usr/bin/env bash
# Claude Code Review — Notification hook v8.0
# Managed by Claude Code Review extension. Do not edit manually.
# Forwards notifications to the extension server which decides whether to show OS alerts.

INPUT=$(cat)

curl -s -X POST http://127.0.0.1:27182/notify   -H "Content-Type: application/json"   -d "$INPUT" 2>/dev/null || true

exit 0
