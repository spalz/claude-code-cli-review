# Claude Code Review

Interactive code review extension for VS Code / Cursor. Manages Claude CLI sessions, tracks file changes automatically via hooks, and lets you accept or revert each change hunk-by-hunk — all from the sidebar.

## Features

### Embedded Claude Sessions

Run multiple Claude CLI sessions in built-in terminals (xterm.js + node-pty). Start new conversations, resume old ones, drag & drop files for context.

![Sessions](media/screenshots/sessions.png)

### Hunk-Level Code Review

Every file Claude modifies is captured automatically. Review inline diffs with **Keep** / **Undo** CodeLens buttons on each hunk. Navigate between changes, accept or reject per-file or all at once.

![Review](media/screenshots/review.png)

### Review Toolbar & Notifications

Sidebar toolbar shows progress across all changed files. Undo/redo history for review decisions. OS-level notifications ensure you never miss when Claude needs your attention.

![Toolbar](media/screenshots/toolbar.png)

## Requirements

- VS Code `>= 1.100.0` or Cursor
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and in PATH
- Git

## Install

```bash
# Build
yarn install && yarn build

# Or production build (minified)
yarn build:prod
```

The build script automatically deploys to `~/.vscode/extensions/`. Reload the editor after install.

## Quick Start

1. Open the **Claude Code Review** sidebar (Activity Bar icon or `Ctrl+Alt+B`)
2. Click **New Session** to launch Claude CLI
3. Work with Claude — modified files appear in the review queue automatically
4. Review diffs, keep or undo changes per hunk

## Keybindings

| Shortcut     | Action                        |
| ------------ | ----------------------------- |
| `Ctrl+Alt+B` | Toggle sidebar panel          |
| `Alt+K`      | Send selection to Claude      |

All commands are available via Command Palette (`Ctrl+Shift+P`) under `Claude Code Review:`.

## How It Works

```
Claude CLI (PTY)
    │  PreToolUse / PostToolUse hooks
    ▼
Hook Scripts (.claude/hooks/ccr-*.sh)
    │  HTTP POST → localhost:27182
    ▼
Extension HTTP Server
    │  Captures before/after file content
    ▼
Review State → CodeLens + Diff Decorations + Sidebar UI
```

Hooks are installed automatically on first run. They also block `/resume` and `/exit` in embedded sessions (use UI controls instead) and send OS notifications via the `Notification` hook.

## Settings

| Setting                       | Default  | Description                          |
| ----------------------------- | -------- | ------------------------------------ |
| `claudeCodeReview.cliCommand` | `claude` | CLI binary name (`claude` or custom) |

## License

MIT
