# Claude Code Review — Project Rules

## Overview

VS Code / Cursor extension for interactive code review of Claude CLI output. Provides hunk-level accept/reject, PTY session management with xterm.js, and hook-based change tracking.

## Architecture

```
Claude CLI (PTY) → PostToolUse Hook → HTTP Server (port 27182) → State → UI
```

- **Entry point**: `src/extension.ts` — activation, command registration, provider wiring
- **Types**: `src/types/` — 6 domain-specific type files + barrel index
- **Core logic**: `src/lib/` — modular TypeScript, max 300 lines per file
- **Actions**: `src/lib/actions/` — review-actions, navigation, file-review
- **Main view**: `src/lib/main-view/` — provider, message-handler, session-manager, state-updater, html-builder
- **Webview**: `media/webview/` — JS modules (core, sessions, terminals, review, settings, message-router) + CSS
- **Media**: `media/` — xterm.js, icon, CSS (prebuilt, not built from source)
- **Hook**: `.claude/hooks/ccr-review-hook.sh` — bash script installed at runtime
- **Build output**: `dist/extension.js` — single esbuild bundle

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Build**: esbuild (CJS bundle) + tsc for type checking
- **Runtime**: VS Code Extension Host (Node.js)
- **Package manager**: yarn
- **Dependencies**: `@types/vscode`, `@types/node`, `typescript`, `esbuild` (dev only)
- **Min VS Code**: ^1.100.0

## Code Conventions

### TypeScript Style

- Strict mode (`"strict": true`) — no `any` without explicit `eslint-disable` comment.
- ES module imports (`import`/`export`) — esbuild bundles to CJS.
- Camel case for functions and variables, PascalCase for classes and types.
- File names: kebab-case (`main-view-provider.ts`, `hook-manager.ts`).
- Max 300 lines per file, aim for ~200.

### VS Code Patterns

- Push **all** disposables to `context.subscriptions`.
- Commands registered in `extension.ts` — handlers delegate to `lib/actions/`.
- State management centralized in `lib/state.ts` — single source of truth.
- Refresh cycle: `state.refreshAll()` → CodeLens + MainView + StatusBar.
- Monkey-patching via `setRefreshAll(fn)` / `setRefreshReview(fn)` setters (esbuild-safe).
- WebviewViewProvider in `lib/main-view/` with `retainContextWhenHidden`.
- Lazy `require("../actions")` in message-handler to avoid potential circular deps.

### Error Handling

- Wrap activation in try/catch — log and re-throw.
- Silent `try {} catch {}` only for non-critical cleanup (e.g., `deactivate` file writes).
- Use `log.log()` from `lib/log.ts` for all logging.
- Cast errors: `(err as Error).message` in catch blocks.

## Key Files

| File                      | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `src/extension.ts`        | Entry point, command registration                               |
| `src/types/`              | All type definitions (review, session, pty, messages, hook, ui) |
| `src/lib/main-view/`      | Sidebar WebviewViewProvider + terminal (5 modules)              |
| `src/lib/actions/`        | Business logic: accept/reject/navigate (3 modules)              |
| `src/lib/review.ts`       | FileReview model, content merging                               |
| `src/lib/state.ts`        | Centralized state                                               |
| `src/lib/server.ts`       | HTTP bridge (port 27182)                                        |
| `src/lib/hook-manager.ts` | Hook installation/validation                                    |
| `src/lib/diff.ts`         | Git diff parsing                                                |
| `src/lib/pty-manager.ts`  | PTY session spawning                                            |
| `src/lib/codelens.ts`     | Keep/Undo CodeLens buttons                                      |
| `src/lib/decorations.ts`  | Diff highlighting                                               |
| `src/lib/status-bar.ts`   | Context-sensitive status bar                                    |
| `src/lib/sessions.ts`     | Claude session discovery                                        |
| `media/webview/`          | Webview JS/CSS (6 JS modules + styles.css)                      |

## Development Workflow

```bash
# Install dependencies
yarn install

# Type check
yarn typecheck

# Build (dev)
yarn build

# Build (production, minified)
yarn build:prod

# Watch mode
yarn watch

# Install to VS Code
cp -r . ~/.vscode/extensions/local.claude-code-review-0.5.0/

# Install to Cursor
cp -r . ~/.cursor/extensions/local.claude-code-review-0.5.0/

# Reload editor
# Cmd+Shift+P → Developer: Reload Window
```

## Testing

- No test infrastructure yet.
- Debug with `Developer: Show Running Extensions` and Output channel logs.
- Hook logs: `/tmp/ccr-hook.log`.

## Important Notes

- Port 27182 must be free — HTTP server for hook communication.
- Hook requires `bash`, `python3` (for JSON parsing), and `curl`.
- Extension uses `onStartupFinished` activation — loads after VS Code is ready.
- `node-pty` loaded from VS Code's internal `node_modules`, not bundled.
- CSP: webview uses `script-src ${webview.cspSource}` (no `'unsafe-inline'`).
- Webview JS files are plain JS (not TypeScript) — executed in browser context.
