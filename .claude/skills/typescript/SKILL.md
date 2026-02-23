---
name: typescript
description: TypeScript conventions, patterns, and best practices. Use when writing, reviewing, or refactoring TypeScript code, migrating from JavaScript to TypeScript, or setting up TypeScript tooling.
user-invocable: false
---

# TypeScript Conventions & Best Practices

## Compiler Configuration

- Enable `strict: true` in `tsconfig.json` — never disable individual strict checks.
- Target ES2022+ (`"target": "ES2022"`) for modern Node.js / VS Code extension host.
- Use `"module"÷ "Node16"` or `"NodeNext"` for correct ESM/CJS interop with `moduleResolution` set to match.
- Enable `"isolatedModules": true` for compatibility with esbuild and other transpilers.
- Enable `"skipLibCheck": true` to speed up compilation (type-check only your code, not `node_modules`).
- Set `"exactOptionalPropertyTypes": true` to distinguish `undefined` from missing properties.

## Type System

### Prefer Explicit Types at Boundaries

- Export types for function signatures, return values, and public APIs.
- Let TypeScript infer types for local variables, intermediate computations.

```typescript
// Good — explicit at boundary
export function parseHunks(diff: string): Hunk[] { ... }

// Good — inferred locally
const lines = diff.split('\n');
const count = lines.length;
```

### Discriminated Unions over Flags

```typescript
// Bad
interface Result { success: boolean; data?: Data; error?: Error; }

// Good
type Result = { kind: 'ok'; data: Data } | { kind: 'error'; error: Error };
```

### Use `satisfies` for Type Validation Without Widening

```typescript
const config = {
  port: 27182,
  host: '127.0.0.1',
} satisfies ServerConfig;
// typeof config.port is 27182, not number
```

### Avoid `any`

- Use `unknown` for values of unknown type — force narrowing before use.
- Use `Record<string, unknown>` instead of `object` or `{}`.
- If `any` is truly unavoidable, add `// eslint-disable-next-line @typescript-eslint/no-explicit-any` with a comment explaining why.

### Utility Types

- Prefer `Readonly<T>`, `ReadonlyArray<T>`, `ReadonlyMap<K,V>` for immutable data.
- Use `Pick<T, K>` and `Omit<T, K>` to derive narrower types from existing ones.
- Use `Extract` / `Exclude` for union type manipulation.

## Code Patterns

### Error Handling

```typescript
// Use typed errors with discriminated unions
type AppError =
  | { code: 'NOT_FOUND'; path: string }
  | { code: 'PARSE_ERROR'; line: number; message: string }
  | { code: 'NETWORK'; cause: Error };

// Or use Result pattern instead of throwing
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
```

### Async Patterns

- Always use `async/await` over raw Promises.
- Handle errors with try/catch at the appropriate boundary.
- Use `Promise.all()` for independent parallel operations, `Promise.allSettled()` when failures should not abort others.

### Naming Conventions

| Entity              | Convention                      | Example                  |
| ------------------- | ------------------------------- | ------------------------ |
| Types / Interfaces  | PascalCase                      | `FileReview`, `HunkData` |
| Functions / Methods | camelCase                       | `parseUnifiedDiff`       |
| Constants           | UPPER_SNAKE_CASE                | `DEFAULT_PORT`           |
| Enums               | PascalCase + PascalCase members | `Status.InProgress`      |
| File names          | kebab-case                      | `file-review.ts`         |
| Type parameters     | Single uppercase or descriptive | `T`, `TResult`           |

### Imports

- Use named imports — avoid `import *`.
- Group imports: node built-ins, external packages, internal modules.
- Use `import type { ... }` for type-only imports.

```typescript
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { FileReview } from './review';
import { parseHunks } from './diff';
```

## Migration from JavaScript

When migrating `.js` files to `.ts`:

1. Rename to `.ts` — fix type errors incrementally.
2. Add `// @ts-check` to JS files as a pre-migration step to catch issues early.
3. Replace `require()` / `module.exports` with `import` / `export`.
4. Add parameter and return types to exported functions first.
5. Replace `@typedef` JSDoc with proper TypeScript interfaces.
6. Use `allowJs: true` and `checkJs: true` during gradual migration.

## Tooling

### ESLint (Flat Config)

Use `eslint.config.mjs` with `typescript-eslint`:

```javascript
import tseslint from 'typescript-eslint';
export default tseslint.config(
  tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } }
);
```

### esbuild (Bundling)

- Always externalize `vscode` module.
- Set `platform: 'node'`, `format: 'cjs'` for VS Code extensions.
- Enable `sourcemap` in development, disable in production.
- Use `--production` flag for minification on publish.
