// Hook script generators — bash scripts for PostToolUse, PreToolUse, Notification
import { HOOK_VERSION } from "./constants";

export function getPostHookScript(): string {
	return `#!/usr/bin/env bash
# Claude Code Review — PostToolUse hook v${HOOK_VERSION}
# Managed by Claude Code Review extension. Do not edit manually.

LOG="/tmp/ccr-hook.log"
echo "[ccr-hook] $(date +%H:%M:%S) --- post hook invoked ---" >> "$LOG"

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
CCR_PORT_FILE="$HOOK_DIR/../ccr-port"
if [[ ! -f "$CCR_PORT_FILE" ]]; then
  echo "[ccr-hook] $(date +%H:%M:%S) skip: no ccr-port file (VS Code not running?)" >> "$LOG"
  exit 0
fi
CCR_PORT=$(cat "$CCR_PORT_FILE")
echo "[ccr-hook] $(date +%H:%M:%S) port=$CCR_PORT" >> "$LOG"

INPUT=$(cat)
echo "[ccr-hook] $(date +%H:%M:%S) raw input length: \${#INPUT}" >> "$LOG"

# Single Python call — parses JSON and produces properly escaped payload via json.dumps()
PAYLOAD=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    tool = d.get('tool_name', '')
    if tool in ('Edit', 'Write'):
        fp = d.get('tool_input', {}).get('file_path', '')
        if fp:
            print(json.dumps({'file': fp, 'tool': tool}))
    elif tool == 'Bash':
        cmd = d.get('tool_input', {}).get('command', '')
        print(json.dumps({'tool': 'Bash', 'command': cmd}))
except Exception as e:
    print('[ccr-hook] python error: ' + str(e), file=sys.stderr)
    sys.exit(1)
" 2>>"$LOG")

PYTHON_EXIT=$?
if [[ $PYTHON_EXIT -ne 0 ]]; then
  echo "[ccr-hook] $(date +%H:%M:%S) skip: python parse failed (exit=$PYTHON_EXIT)" >> "$LOG"
  exit 0
fi

if [[ -z "$PAYLOAD" ]]; then
  echo "[ccr-hook] $(date +%H:%M:%S) skip: no payload (unsupported tool or empty path)" >> "$LOG"
  exit 0
fi

echo "[ccr-hook] $(date +%H:%M:%S) sending payload: $PAYLOAD" >> "$LOG"
RESPONSE=$(curl -sf -w "\\n%{http_code}" -X POST -H "Content-Type: application/json" \\
  -d "$PAYLOAD" \\
  http://127.0.0.1:$CCR_PORT/changed 2>&1)
CURL_EXIT=$?
echo "[ccr-hook] $(date +%H:%M:%S) curl exit=$CURL_EXIT response=$RESPONSE" >> "$LOG"

exit 0
`;
}

export function getPreHookScript(): string {
	return `#!/usr/bin/env bash
# Claude Code Review — PreToolUse hook v${HOOK_VERSION}
# Managed by Claude Code Review extension. Do not edit manually.
# Captures file content BEFORE Claude modifies it.

LOG="/tmp/ccr-hook.log"
echo "[ccr-pre-hook] $(date +%H:%M:%S) --- pre hook invoked ---" >> "$LOG"

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
CCR_PORT_FILE="$HOOK_DIR/../ccr-port"
if [[ ! -f "$CCR_PORT_FILE" ]]; then
  echo "[ccr-pre-hook] $(date +%H:%M:%S) skip: no ccr-port file" >> "$LOG"
  exit 0
fi
CCR_PORT=$(cat "$CCR_PORT_FILE")
echo "[ccr-pre-hook] $(date +%H:%M:%S) port=$CCR_PORT" >> "$LOG"

INPUT=$(cat)

# Single Python call — parses JSON, reads file content, produces escaped payload
PAYLOAD=$(echo "$INPUT" | python3 -c "
import sys, json, os, base64
try:
    d = json.load(sys.stdin)
    tool = d.get('tool_name', '')
    if tool in ('Edit', 'Write'):
        fp = d.get('tool_input', {}).get('file_path', '')
        if not fp:
            sys.exit(0)
        content = ''
        if os.path.isfile(fp):
            with open(fp, 'rb') as f:
                content = base64.b64encode(f.read()).decode()
        print(json.dumps({'file': fp, 'content': content}))
    elif tool == 'Bash':
        cmd = d.get('tool_input', {}).get('command', '')
        print(json.dumps({'tool': 'Bash', 'command': cmd}))
    else:
        sys.exit(0)
except Exception as e:
    print('[ccr-pre-hook] python error: ' + str(e), file=sys.stderr)
    sys.exit(1)
" 2>>"$LOG")

PYTHON_EXIT=$?
if [[ $PYTHON_EXIT -ne 0 ]]; then
  echo "[ccr-pre-hook] $(date +%H:%M:%S) skip: python parse failed (exit=$PYTHON_EXIT)" >> "$LOG"
  exit 0
fi

if [[ -z "$PAYLOAD" ]]; then
  echo "[ccr-pre-hook] $(date +%H:%M:%S) skip: no payload" >> "$LOG"
  exit 0
fi

echo "[ccr-pre-hook] $(date +%H:%M:%S) sending snapshot" >> "$LOG"
curl -sf -X POST -H "Content-Type: application/json" \\
  -d "$PAYLOAD" \\
  http://127.0.0.1:$CCR_PORT/snapshot >>"$LOG" 2>&1
echo "[ccr-pre-hook] $(date +%H:%M:%S) snapshot sent" >> "$LOG"

exit 0
`;
}

export function getNotifyHookScript(): string {
	return `#!/usr/bin/env bash
# Claude Code Review — Notification hook v${HOOK_VERSION}
# Managed by Claude Code Review extension. Do not edit manually.
# Forwards notifications to the extension server which decides whether to show OS alerts.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
CCR_PORT_FILE="$HOOK_DIR/../ccr-port"
[[ ! -f "$CCR_PORT_FILE" ]] && exit 0
CCR_PORT=$(cat "$CCR_PORT_FILE")

INPUT=$(cat)

curl -s -X POST http://127.0.0.1:$CCR_PORT/notify \
  -H "Content-Type: application/json" \
  -d "$INPUT" 2>/dev/null || true

exit 0
`;
}
