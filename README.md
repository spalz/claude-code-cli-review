# Claude Code with Review

> Run Claude CLI sessions and review every AI-generated change — hunk by hunk — without leaving your editor.

**Claude Code with Review** turns VS Code and Cursor into a full interactive environment for working with Claude CLI. It automatically intercepts every file modification Claude makes and presents inline diffs with granular accept/reject controls. No more blindly trusting AI output — review each change on your terms.

---

## Session Manager

Run multiple Claude CLI conversations in real terminal sessions directly in the sidebar. Start new chats, resume previous ones, rename and organize them with tabs.

- Full terminal with colors, cursor, and 10,000-line scrollback
- Session history with timestamps, message counts, and git branch info
- Drag & drop files from Explorer into the terminal for instant context
- Send code selections to Claude with `Alt+K` or right-click menu
- Paste images directly into the terminal for visual context
- Sessions persist across editor restarts — pick up where you left off
- Archive old sessions to keep the list clean

<!-- 📸 Screenshot: sidebar with session list and embedded terminal -->
<!-- ![Sessions](media/screenshots/sessions.png) -->

---

## Hunk-Level Code Review

Every file Claude modifies is captured automatically. Changes appear as inline diffs right in the editor — green for additions, red with strikethrough for removals. Each change block (hunk) gets its own **Keep** / **Undo** buttons directly in the code.

- Accept or reject individual hunks within a single file
- Navigate between hunks and files with keyboard shortcuts
- Batch operations: keep or undo all changes in a file, or across all files
- Full undo/redo history for review decisions (`Cmd+Z` / `Cmd+Shift+Z`)
- Review progress toolbar with counters: `2/5` hunks, `1/3` files
- Review state survives editor restarts
- Handles edits, new files, and file deletions

<!-- 📸 Screenshot: editor with inline diff decorations and Keep/Undo buttons -->
<!-- ![Review](media/screenshots/review.png) -->

---

## Built-in Claude CLI Settings

Configure Claude CLI without touching JSON files. The settings panel lets you adjust behavior across global and project scopes:

- Theme, output style, editor mode (vim/emacs), permission mode
- Model selection, language, thinking mode
- Notification sounds, auto-updates, and more
- Scope toggle: effective (merged), global, or project-level

<!-- 📸 Screenshot: settings panel -->
<!-- ![Settings](media/screenshots/settings.png) -->

---

## Quick Start

1. Install the extension from the Marketplace
2. Open the **Claude Code Review** sidebar (`Ctrl+Alt+B`)
3. Click **+** to start a new Claude CLI session
4. Work with Claude — every file change appears for review automatically
5. Use **Keep** / **Undo** on each change, or batch-resolve entire files

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+B` | Toggle sidebar panel |
| `Alt+K` | Send selection to Claude session |
| `Cmd+Y` | Keep (accept) current change |
| `Cmd+N` | Undo (reject) current change |
| `Cmd+]` / `Cmd+[` | Next / previous change |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo / redo review action |

All commands available via Command Palette under **Claude Code Review:**.

---

## Requirements

- **VS Code** >= 1.100.0 or **Cursor**
- [**Claude CLI**](https://docs.anthropic.com/en/docs/claude-code) installed and available in PATH
- **Git**

---

## License

MIT
