#!/usr/bin/env bash
# simulate-review.sh — Simulate Claude Code hook for testing review extension
# Usage:
#   ./scripts/simulate-review.sh <scenario> [workspace_path]
#
# Scenarios:
#   single    — 1 file, 1 hunk (simple edit)
#   multi     — 1 file, 3+ hunks (additions, deletions, modifications)
#   batch     — 5 files changed at once
#   addonly   — pure additions (no removed lines) — tests undo edge case
#   delete    — file deletion
#   create    — new file creation
#   big       — large file with 10+ hunks
#   stress    — 20 files, various change types
#   revert    — modify then revert to test re-edit
#   all       — run all scenarios sequentially
#
# The script creates temp files in $WORKSPACE/.ccr-test/, sends hooks, and cleans up on exit.

set -euo pipefail

PORT=27182
BASE_URL="http://127.0.0.1:${PORT}"
SCENARIO="${1:-single}"
WORKSPACE="${2:-$(pwd)}"
TEST_DIR="${WORKSPACE}/.ccr-test"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Check server is running
check_server() {
  if ! curl -s "${BASE_URL}/status" > /dev/null 2>&1; then
    echo -e "${RED}Error: Review server not running on port ${PORT}${NC}"
    echo "Open VS Code with the extension active first."
    exit 1
  fi
  echo -e "${GREEN}Server OK${NC} — $(curl -s ${BASE_URL}/status)"
}

# Send snapshot (before content) for a file
send_snapshot() {
  local file="$1"
  local content
  if [ -f "$file" ]; then
    content=$(base64 < "$file")
  else
    content=""
  fi
  curl -s -X POST "${BASE_URL}/snapshot" \
    -H "Content-Type: application/json" \
    -d "{\"file\": \"${file}\", \"content\": \"${content}\", \"tool\": \"Edit\"}" > /dev/null
  echo -e "  ${CYAN}snapshot${NC} → ${file}"
}

# Send changed notification (after edit)
send_changed() {
  local file="$1"
  curl -s -X POST "${BASE_URL}/changed" \
    -H "Content-Type: application/json" \
    -d "{\"file\": \"${file}\", \"tool\": \"Edit\"}" > /dev/null
  echo -e "  ${GREEN}changed${NC}  → ${file}"
}

# Full cycle: snapshot → edit → changed
simulate_edit() {
  local file="$1"
  local new_content="$2"
  send_snapshot "$file"
  echo "$new_content" > "$file"
  send_changed "$file"
}

# Create test dir
setup() {
  mkdir -p "$TEST_DIR"
  echo -e "${YELLOW}Test dir: ${TEST_DIR}${NC}"
}

# Cleanup
cleanup() {
  if [ -d "$TEST_DIR" ]; then
    echo -e "\n${YELLOW}Cleanup: rm -rf ${TEST_DIR}${NC}"
    rm -rf "$TEST_DIR"
  fi
}

pause() {
  echo -e "\n${YELLOW}>>> Press Enter to continue (or Ctrl+C to stop)...${NC}"
  read -r
}

# ─── Scenarios ───────────────────────────────────────────────────────────────

scenario_single() {
  echo -e "\n${CYAN}━━━ Scenario: single (1 file, 1 hunk) ━━━${NC}"
  local f="${TEST_DIR}/hello.ts"

  cat > "$f" << 'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
EOF

  simulate_edit "$f" 'export function greet(name: string): string {
  const greeting = `Hello, ${name}!`;
  console.log(greeting);
  return greeting;
}'
  echo -e "${GREEN}Done. Check VS Code for 1 file with 1 hunk.${NC}"
}

scenario_multi() {
  echo -e "\n${CYAN}━━━ Scenario: multi (1 file, 3+ hunks) ━━━${NC}"
  local f="${TEST_DIR}/utils.ts"

  cat > "$f" << 'EOF'
// Utility functions
import { readFileSync } from "fs";

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  return a / b;
}

export function format(value: number): string {
  return value.toString();
}

export function parse(input: string): number {
  return parseInt(input, 10);
}
EOF

  simulate_edit "$f" '// Utility functions v2
import { readFileSync } from "fs";
import { join } from "path";

export function add(a: number, b: number): number {
  if (typeof a !== "number" || typeof b !== "number") throw new Error("Invalid args");
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

export function format(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

export function parse(input: string): number {
  const result = parseInt(input, 10);
  if (isNaN(result)) throw new Error("Invalid number");
  return result;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}'
  echo -e "${GREEN}Done. Check VS Code for 1 file with multiple hunks.${NC}"
}

scenario_addonly() {
  echo -e "\n${CYAN}━━━ Scenario: addonly (pure additions — undo edge case) ━━━${NC}"
  local f="${TEST_DIR}/config.ts"

  cat > "$f" << 'EOF'
export const config = {
  port: 3000,
  host: "localhost",
};
EOF

  # Only additions — no lines removed
  simulate_edit "$f" 'export const config = {
  port: 3000,
  host: "localhost",
  debug: true,
  logLevel: "info",
  timeout: 5000,
};'
  echo -e "${GREEN}Done. Pure additions — test Cmd+Z here! Each undo should revert one hunk.${NC}"
}

scenario_batch() {
  echo -e "\n${CYAN}━━━ Scenario: batch (5 files at once) ━━━${NC}"

  for i in 1 2 3 4 5; do
    local f="${TEST_DIR}/module-${i}.ts"
    cat > "$f" << EOF
// Module ${i}
export function fn${i}(): string {
  return "original ${i}";
}
EOF
  done

  echo -e "  ${YELLOW}Files created, sending hooks...${NC}"

  for i in 1 2 3 4 5; do
    local f="${TEST_DIR}/module-${i}.ts"
    send_snapshot "$f"
  done

  for i in 1 2 3 4 5; do
    local f="${TEST_DIR}/module-${i}.ts"
    cat > "$f" << EOF
// Module ${i} — updated
export function fn${i}(): string {
  return "modified ${i}";
}

export function helper${i}(): void {
  console.log("helper for module ${i}");
}
EOF
    send_changed "$f"
  done

  echo -e "${GREEN}Done. 5 files in review.${NC}"
}

scenario_create() {
  echo -e "\n${CYAN}━━━ Scenario: create (new file) ━━━${NC}"
  local f="${TEST_DIR}/brand-new.ts"

  # File doesn't exist yet — empty snapshot
  curl -s -X POST "${BASE_URL}/snapshot" \
    -H "Content-Type: application/json" \
    -d "{\"file\": \"${f}\", \"content\": \"\", \"tool\": \"Write\"}" > /dev/null

  cat > "$f" << 'EOF'
// Brand new file created by Claude
export interface NewFeature {
  id: string;
  name: string;
  enabled: boolean;
}

export function createFeature(name: string): NewFeature {
  return { id: crypto.randomUUID(), name, enabled: true };
}
EOF
  send_changed "$f"
  echo -e "${GREEN}Done. New file — reject should delete it.${NC}"
}

scenario_delete() {
  echo -e "\n${CYAN}━━━ Scenario: delete (file removal) ━━━${NC}"
  local f="${TEST_DIR}/to-delete.ts"

  cat > "$f" << 'EOF'
// This file will be deleted
export const LEGACY_API = "https://old.api.com";
export function legacyCall(): void {
  console.log("deprecated");
}
EOF

  send_snapshot "$f"
  rm "$f"
  send_changed "$f"
  echo -e "${GREEN}Done. File deleted — reject should restore it.${NC}"
}

scenario_big() {
  echo -e "\n${CYAN}━━━ Scenario: big (large file, 10+ hunks) ━━━${NC}"
  local f="${TEST_DIR}/big-file.ts"

  # Generate original — 20 functions
  {
    echo "// Big file with many functions"
    echo ""
    for i in $(seq 1 20); do
      echo "export function func${i}(x: number): number {"
      echo "  return x * ${i};"
      echo "}"
      echo ""
    done
  } > "$f"

  send_snapshot "$f"

  # Modify every other function + add new ones
  {
    echo "// Big file with many functions — refactored"
    echo "import { log } from './log';"
    echo ""
    for i in $(seq 1 20); do
      if (( i % 2 == 0 )); then
        echo "export function func${i}(x: number): number {"
        echo "  log('func${i} called with', x);"
        echo "  const result = x * ${i} + 1;"
        echo "  return result;"
        echo "}"
      else
        echo "export function func${i}(x: number): number {"
        echo "  return x * ${i};"
        echo "}"
      fi
      echo ""
    done
    echo "export function newHelper(values: number[]): number {"
    echo "  return values.reduce((a, b) => a + b, 0);"
    echo "}"
  } > "$f"

  send_changed "$f"
  echo -e "${GREEN}Done. 10+ hunks in one file.${NC}"
}

scenario_stress() {
  echo -e "\n${CYAN}━━━ Scenario: stress (20 files, various types) ━━━${NC}"

  # Create 20 files
  for i in $(seq 1 20); do
    local f="${TEST_DIR}/stress-${i}.ts"
    cat > "$f" << EOF
// Stress test file ${i}
export const VALUE_${i} = ${i};

export function compute${i}(input: number): number {
  return input + VALUE_${i};
}

export function format${i}(n: number): string {
  return \`Result: \${n}\`;
}
EOF
  done

  echo -e "  ${YELLOW}20 files created, sending hooks...${NC}"

  # Snapshot all
  for i in $(seq 1 20); do
    send_snapshot "${TEST_DIR}/stress-${i}.ts"
  done

  # Modify all with varying changes
  for i in $(seq 1 20); do
    local f="${TEST_DIR}/stress-${i}.ts"

    if (( i % 4 == 0 )); then
      # Pure addition
      cat > "$f" << EOF
// Stress test file ${i}
export const VALUE_${i} = ${i};
export const EXTRA_${i} = ${i} * 10;

export function compute${i}(input: number): number {
  return input + VALUE_${i};
}

export function format${i}(n: number): string {
  return \`Result: \${n}\`;
}

export function bonus${i}(): string {
  return "new function";
}
EOF
    elif (( i % 4 == 1 )); then
      # Modification
      cat > "$f" << EOF
// Stress test file ${i} — v2
export const VALUE_${i} = ${i} * 2;

export function compute${i}(input: number): number {
  if (input < 0) throw new Error("negative");
  return input + VALUE_${i};
}

export function format${i}(n: number): string {
  return \`[${i}] Result: \${n}\`;
}
EOF
    elif (( i % 4 == 2 )); then
      # Mixed adds and removes
      cat > "$f" << EOF
// Stress test file ${i}
export const VALUE_${i} = ${i};

export function compute${i}(input: number): number {
  return input + VALUE_${i};
}
EOF
    else
      # Heavy rewrite
      cat > "$f" << EOF
// Completely rewritten file ${i}
import { log } from "./log";

interface Config${i} {
  value: number;
  label: string;
}

export const DEFAULT_CONFIG: Config${i} = {
  value: ${i},
  label: "item-${i}",
};

export function process${i}(config: Config${i}): string {
  log("processing", config.label);
  return \`\${config.label}: \${config.value}\`;
}
EOF
    fi

    send_changed "$f"
  done

  echo -e "${GREEN}Done. 20 files in review with various change types.${NC}"
}

scenario_revert() {
  echo -e "\n${CYAN}━━━ Scenario: revert (modify → accept → re-modify) ━━━${NC}"
  local f="${TEST_DIR}/revert-test.ts"

  cat > "$f" << 'EOF'
export function original(): string {
  return "v1";
}
EOF

  echo -e "  ${YELLOW}Step 1: First edit${NC}"
  simulate_edit "$f" 'export function original(): string {
  return "v2";
}'

  echo -e "  ${YELLOW}Accept the change in VS Code, then press Enter${NC}"
  pause

  echo -e "  ${YELLOW}Step 2: Second edit (re-edit same file)${NC}"
  simulate_edit "$f" 'export function original(): string {
  return "v3 — final";
}'
  echo -e "${GREEN}Done. File should show new review for second edit.${NC}"
}

# ─── Main ────────────────────────────────────────────────────────────────────

trap cleanup EXIT

check_server
setup

case "$SCENARIO" in
  single)   scenario_single ;;
  multi)    scenario_multi ;;
  addonly)  scenario_addonly ;;
  batch)    scenario_batch ;;
  create)   scenario_create ;;
  delete)   scenario_delete ;;
  big)      scenario_big ;;
  stress)   scenario_stress ;;
  revert)   scenario_revert ;;
  all)
    scenario_single;  pause
    scenario_multi;   pause
    scenario_addonly;  pause
    scenario_batch;   pause
    scenario_create;  pause
    scenario_delete;  pause
    scenario_big;     pause
    scenario_stress;  pause
    ;;
  *)
    echo -e "${RED}Unknown scenario: ${SCENARIO}${NC}"
    echo "Available: single, multi, addonly, batch, create, delete, big, stress, revert, all"
    exit 1
    ;;
esac

echo -e "\n${YELLOW}Test files in ${TEST_DIR}${NC}"
echo -e "${YELLOW}Press Enter to cleanup and exit...${NC}"
read -r
