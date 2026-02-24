# Changelog

All notable changes to the "Claude Code with Review" extension will be documented in this file.

## [0.5.0] — 2026-02-24

### Initial Public Release

- Interactive hunk-level code review for Claude CLI changes (accept/reject per hunk)
- PTY session management with xterm.js terminal
- Hook-based automatic change tracking via `PostToolUse`
- CodeLens buttons for Keep/Undo actions
- Diff highlighting with inline decorations
- Multi-file navigation (previous/next file, previous/next hunk)
- Undo/redo support for review actions
- Sidebar webview with session list, review panel, and settings
- Context menu integration: send selection or file to Claude session
- Keyboard shortcuts for all review actions
- OS notifications when Claude needs attention
- Configurable shell, environment variables, and CLI command
