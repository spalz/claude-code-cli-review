// Hook script generators — bash scripts for PostToolUse, PreToolUse, Notification
import { HOOK_VERSION } from "./constants";

export function getPostHookScript(): string {
	return `#!/usr/bin/env bash
# Claude Code Review — PostToolUse hook v${HOOK_VERSION}
# Managed by Claude Code Review extension. Do not edit manually.

LOG="/tmp/ccr-hook.log"
echo "[ccr-hook] $(date +%H:%M:%S) --- post hook invoked ---" >> "$LOG"

INPUT=$(cat)
echo "[ccr-hook] $(date +%H:%M:%S) raw input: $INPUT" >> "$LOG"

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

echo "[ccr-hook] $(date +%H:%M:%S) tool=$TOOL_NAME file=$FILE_PATH" >> "$LOG"

if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
  if [[ -z "$FILE_PATH" ]]; then
    echo "[ccr-hook] $(date +%H:%M:%S) skip: empty file path" >> "$LOG"
    exit 0
  fi
  RESPONSE=$(curl -sf -w "\\n%{http_code}" -X POST -H "Content-Type: application/json" \\
    -d "{\\"file\\":\\"$FILE_PATH\\",\\"tool\\":\\"$TOOL_NAME\\"}" \\
    http://127.0.0.1:27182/changed 2>&1)
  CURL_EXIT=$?
  echo "[ccr-hook] $(date +%H:%M:%S) curl exit=$CURL_EXIT response=$RESPONSE" >> "$LOG"
elif [[ "$TOOL_NAME" == "Bash" ]]; then
  echo "[ccr-hook] $(date +%H:%M:%S) Bash tool detected, sending command" >> "$LOG"
  echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cmd=d.get('tool_input',{}).get('command','')
print(json.dumps({'tool':'Bash','command':cmd}))
" 2>/dev/null | curl -sf -X POST -H "Content-Type: application/json" -d @- http://127.0.0.1:27182/changed >/dev/null 2>&1
else
  echo "[ccr-hook] $(date +%H:%M:%S) skip: tool is not Edit/Write/Bash" >> "$LOG"
fi

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

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

echo "[ccr-pre-hook] $(date +%H:%M:%S) tool=$TOOL_NAME file=$FILE_PATH" >> "$LOG"

if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
  if [[ -z "$FILE_PATH" ]]; then
    exit 0
  fi
  if [[ -f "$FILE_PATH" ]]; then
    CONTENT=$(base64 < "$FILE_PATH")
  else
    CONTENT=""
  fi
  curl -sf -X POST -H "Content-Type: application/json" \\
    -d "{\\"file\\":\\"$FILE_PATH\\",\\"content\\":\\"$CONTENT\\"}" \\
    http://127.0.0.1:27182/snapshot >/dev/null 2>&1
  echo "[ccr-pre-hook] $(date +%H:%M:%S) snapshot sent for $FILE_PATH" >> "$LOG"
elif [[ "$TOOL_NAME" == "Bash" ]]; then
  echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cmd=d.get('tool_input',{}).get('command','')
print(json.dumps({'tool':'Bash','command':cmd}))
" 2>/dev/null | curl -sf -X POST -H "Content-Type: application/json" -d @- http://127.0.0.1:27182/snapshot >/dev/null 2>&1
  echo "[ccr-pre-hook] $(date +%H:%M:%S) Bash snapshot sent" >> "$LOG"
fi
exit 0
`;
}

export function getNotifyHookScript(): string {
	return `#!/usr/bin/env bash
# Claude Code Review — Notification hook v${HOOK_VERSION}
# Managed by Claude Code Review extension. Do not edit manually.
# Sends OS-level notifications so the user doesn't miss Claude Code events.

INPUT=$(cat)

MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','Claude Code needs your attention'))" 2>/dev/null || echo "Claude Code needs your attention")
TITLE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title','Claude Code Review'))" 2>/dev/null || echo "Claude Code Review")

if [[ "$(uname)" == "Darwin" ]]; then
  osascript -e "display notification \\"$MESSAGE\\" with title \\"$TITLE\\"" 2>/dev/null
elif command -v notify-send &>/dev/null; then
  notify-send "$TITLE" "$MESSAGE" 2>/dev/null
fi

exit 0
`;
}
