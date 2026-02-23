---
name: vscode-extension
description: VS Code extension development standards, patterns, and API guidelines for 2025-2026. Use when creating, modifying, debugging, or reviewing VS Code extension code. Covers activation, commands, webviews, testing, packaging, security, and performance.
user-invocable: false
---

# VS Code Extension Development Standards (2025-2026)

## Architecture

### Extension Lifecycle

```
activate(context) → register providers, commands, listeners → push to context.subscriptions
deactivate()      → async cleanup, return Promise if needed
```

- Every resource from VS Code API returns a `Disposable` — always push to `context.subscriptions`.
- Export both `activate()` and `deactivate()`.
- Never hold global mutable state outside of `activate()` scope.

### Activation Events

- Use the **most specific** activation event. Never use `*`.
- Prefer `onStartupFinished` over `*` when global activation is truly needed.
- Since VS Code 1.74+, `contributes.commands` entries generate implicit `onCommand` activation — no need to list them separately.
- Available events: `onLanguage`, `onCommand`, `onDebug`, `workspaceContains`, `onView`, `onUri`, `onWebviewPanel`, `onCustomEditor`, `onStartupFinished`, `onChatParticipant`, `onLanguageModelTool`.

### Project Structure

```
extension/
├── src/                    # Source code (TypeScript preferred)
│   ├── extension.ts        # Entry point: activate/deactivate
│   ├── providers/          # CodeLens, TreeView, WebView providers
│   ├── commands/           # Command handlers
│   └── utils/              # Shared utilities
├── media/                  # Static assets (icons, CSS, bundled libs)
├── dist/                   # Bundled output (esbuild/webpack)
├── test/                   # Tests (compiled separately, NOT bundled)
├── package.json            # Extension manifest
├── tsconfig.json           # TypeScript config
├── esbuild.js              # Build script
└── .vscodeignore           # Files to exclude from VSIX
```

## Extension Manifest (package.json)

### Required Fields

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "publisher": "publisher-id",
  "engines": { "vscode": "^1.100.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onStartupFinished"]
}
```

- Pin `engines.vscode` to the **minimum required** version with caret (`^`).
- Never use `"engines": { "vscode": "*" }`.
- Point `main` to the bundled output, not source.

### Capabilities Declaration

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": "limited",
    "description": "Disables code execution features in untrusted workspaces",
    "restrictedConfigurations": ["myExt.executablePath"]
  },
  "virtualWorkspaces": {
    "supported": "limited",
    "description": "File system features unavailable in virtual workspaces"
  }
}
```

## Common API Patterns

### Commands

```typescript
const disposable = vscode.commands.registerCommand('ext.command', async (arg) => {
  // handler
});
context.subscriptions.push(disposable);
```

### Webview

```typescript
const panel = vscode.window.createWebviewPanel('type', 'Title', vscode.ViewColumn.One, {
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
});
// Use getNonce() and CSP for security
```

**Always set Content Security Policy in webviews:**

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    img-src ${webview.cspSource} data:;">
```

### WebviewViewProvider (Sidebar)

```typescript
class MyViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(msg => { /* handle */ });
  }
}
// Register with retainContextWhenHidden for persistent state
vscode.window.registerWebviewViewProvider('viewId', provider, {
  webviewOptions: { retainContextWhenHidden: true }
});
```

### CodeLens Provider

```typescript
class MyCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    // return CodeLens array
  }

  refresh() { this._onDidChange.fire(); }
}
```

### Editor Decorations

```typescript
const decorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(0,255,0,0.1)',
  isWholeLine: true,
});
editor.setDecorations(decorationType, ranges);
// Reapply on tab switch via onDidChangeActiveTextEditor
```

### Status Bar

```typescript
const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
item.text = '$(icon-id) Label';
item.command = 'ext.command';
item.show();
context.subscriptions.push(item);
```

### Configuration

```typescript
const config = vscode.workspace.getConfiguration('myExtension');
const value = config.get<string>('settingName', 'default');

// Watch for changes
vscode.workspace.onDidChangeConfiguration(e => {
  if (e.affectsConfiguration('myExtension.settingName')) {
    // React to change
  }
});
```

## Security

- **No sandbox model exists** — extensions have full system access. Minimize what you use.
- Never ship secrets, API keys, or credentials.
- Validate and sanitize all inputs, especially in webviews.
- Use Content Security Policy (CSP) in every webview.
- Declare `capabilities.untrustedWorkspaces` behavior.
- Minimize filesystem and network access to only what's required.
- Keep dependencies minimal and audited.
- Use `nonce` for inline scripts in webviews.

## Performance

### Startup

- Bundle with esbuild — loading one file is dramatically faster than hundreds of modules.
- Use the most specific activation event to defer loading.
- Defer expensive initialization (network, file parsing) until the feature is first used.

### Runtime

- Push all disposables to `context.subscriptions` to prevent memory leaks.
- Unregister event listeners when no longer needed.
- Avoid holding references to large data structures longer than necessary.
- Monitor with `Developer: Show Running Extensions` during development.

### Bundling with esbuild

```javascript
const esbuild = require('esbuild');
const production = process.argv.includes('--production');

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],  // Always externalize vscode
});
```

## Testing

### Setup

- Use `@vscode/test-cli` + `@vscode/test-electron` for desktop extension tests.
- Use `@vscode/test-web` for web extension tests.
- Configure via `.vscode-test.js` at project root.
- Tests run under **Mocha** with full VS Code API access.

### Best Practices

- Keep test code **un-bundled** — compile with `tsc` to `out/` folder.
- Use `--disable-extensions` in test launch args to isolate.
- Run in CI with `xvfb-run` on Linux (VS Code needs a display).
- For webview E2E testing, consider WebdriverIO with VS Code plugin.

## Packaging & Publishing

- Use `@vscode/vsce` for packaging (`vsce package`) and publishing.
- Run `vsce package --no-dependencies` when using a bundler.
- `vscode:prepublish` script runs automatically before publish — use for production build.
- Icon: 128x128px PNG (SVGs not allowed).
- Use `.vscodeignore` to exclude `node_modules/`, `src/`, `out/`, test files, configs.

### .vscodeignore Example

```
.vscode/**
node_modules/**
src/**
out/**
test/**
**/*.ts
**/*.map
.gitignore
tsconfig.json
esbuild.js
.eslintrc*
eslint.config.*
```

## Accessibility

- Every actionable element must be keyboard-navigable.
- Set informative `aria-label` on focusable elements — most critical info first.
- Meet color contrast minimums: 4.5:1 (High Contrast), 3:1 (editor), 4.5:1 (non-editor UI).
- Apply `text-decoration: var(--text-link-decoration)` to links.
- Test with screen readers (VoiceOver on macOS).

## Localization

- Use `vscode.l10n.t("string")` in extension code (VS Code 1.73+).
- Use `package.nls.json` for static `package.json` strings.
- Use `@vscode/l10n` npm package for webviews/subprocesses.
- Use `@vscode/l10n-dev` to extract translatable strings.

## Additional Resources

For detailed reference on specific topics, see:
- [VS Code Extension API](https://code.visualstudio.com/api)
- [Extension Samples](https://github.com/microsoft/vscode-extension-samples)
- [Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
