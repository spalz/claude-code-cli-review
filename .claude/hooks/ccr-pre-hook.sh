#!/usr/bin/env bash
# Claude Code Review — PreToolUse hook v8.1
# Managed by Claude Code Review extension. Do not edit manually.
# Captures file content BEFORE Claude modifies it.

LOG="/tmp/ccr-hook.log"
echo "[ccr-pre-hook] $(date +%H:%M:%S) --- pre hook invoked ---" >> "$LOG"

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
CCR_PORT=$(cat "$HOOK_DIR/../ccr-port" 2>/dev/null || echo 27182)
echo "[ccr-pre-hook] $(date +%H:%M:%S) port=$CCR_PORT" >> "$LOG"

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
  curl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"file\":\"$FILE_PATH\",\"content\":\"$CONTENT\"}" \
    http://127.0.0.1:$CCR_PORT/snapshot >/dev/null 2>&1
  echo "[ccr-pre-hook] $(date +%H:%M:%S) snapshot sent for $FILE_PATH" >> "$LOG"
elif [[ "$TOOL_NAME" == "Bash" ]]; then
  echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cmd=d.get('tool_input',{}).get('command','')
print(json.dumps({'tool':'Bash','command':cmd}))
" 2>/dev/null | curl -sf -X POST -H "Content-Type: application/json" -d @- http://127.0.0.1:$CCR_PORT/snapshot >/dev/null 2>&1
  echo "[ccr-pre-hook] $(date +%H:%M:%S) Bash snapshot sent" >> "$LOG"
fi
exit 0
