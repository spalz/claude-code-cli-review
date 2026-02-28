# Development

## Prerequisites

- Node.js, yarn
- VS Code ^1.100.0 or Cursor

## Commands

```bash
yarn install          # Install dependencies
yarn build            # Build + deploy to ~/.vscode/extensions/
yarn build:prod       # Minified production build + deploy
yarn typecheck        # Type checking (tsc --noEmit)
yarn test             # Run tests (vitest)
yarn watch            # Watch mode (esbuild)
```

## Local development cycle

1. `yarn build` — собирает `dist/extension.js` и копирует в `~/.vscode/extensions/`
2. В VS Code: `Cmd+Shift+P → Developer: Reload Window`
3. Логи: Output panel → "Claude Code Review"
4. Hook логи: `/tmp/ccr-hook.log`

## Генерация .vsix

```bash
npx @vscode/vsce package -o claude-code-review-$(node -p "require('./package.json').version").vsix
```

Для установки в Cursor (нет автодеплоя):

```bash
cp -r . ~/.cursor/extensions/local.claude-code-review-$(node -p "require('./package.json').version")/
```

## Публикация

```bash
node scripts/publish.js <patch|minor|major>
```

Требует `.env` файл:

```
dev_azure_access_token=<token>
open_vsx_registry_access_token=<token>
```

Скрипт: bump version → package .vsix → publish VS Code Marketplace + Open VSX → git tag + push.

## Структура сборки

- **esbuild** → `dist/extension.js` (CJS bundle)
- **deploy.js** → копирует в `~/.vscode/extensions/`, чистит старые версии
- Webview JS (`media/webview/`) — plain JS, не транспилируется
- `node-pty` загружается из VS Code internal `node_modules`

## Тесты

```bash
yarn test                              # Все тесты
yarn test src/lib/__tests__/foo.test.ts # Один файл
```

Framework: vitest. Моки VS Code API в `src/lib/__tests__/mocks/vscode.ts`.

## Порты и зависимости

- HTTP server: порт **27182** (hook → extension communication)
- Hook требует: `bash`, `python3`, `curl`
