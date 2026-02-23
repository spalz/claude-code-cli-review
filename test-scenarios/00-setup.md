# Этап 0 — Подготовка

## Перед началом тестирования

1. Собрать расширение:
```bash
cd /Users/spals/projects/extensions/claude-code-review
yarn build
```

2. Установить в VS Code:
```bash
cp -r . ~/.vscode/extensions/local.claude-code-review-8.0.0/
```

3. Reload VS Code: `Cmd+Shift+P → Developer: Reload Window`

4. Открыть проект:
```
/Users/spals/projects/aiots/aiots-platform-spa
```

5. Убедиться что хуки установлены:
   - Sidebar "Claude Code Review" видна
   - Если промт на установку хуков — установить

6. Проверить что порт свободен:
```bash
curl -s http://127.0.0.1:27182/status | python3 -m json.tool
```
Ожидаемый ответ: `{"ok": true, "version": "8.0.0", ...}`

7. Открыть Output Channel: `Cmd+Shift+P → Output: Show Output Channel → Claude Code Review`

## Ключевые логи для проверки

При каждом действии в Output Channel должны появляться соответствующие логи:

| Действие | Ожидаемый лог |
|----------|--------------|
| Hook отправил файл | `ReviewManager.addFile: /path/to/file` |
| Hunk resolved | `ReviewManager.resolveHunk: file=..., hunkId=N, accept=true/false, remaining=N` |
| Файл финализирован | `ReviewManager.finalizeFile: ..., type=edit, allAccepted=..., allRejected=...` |
| Edit через undo-стек | `ReviewManager.applyContentViaEdit: applying via TextEditor.edit for ...` |
| Snapshot записан | `undo-history: recorded snapshot key=..., unresolved=N, total snapshots=N` |
| Ctrl+Z обнаружен | `doc-listener: undo/redo detected for ..., unresolved=N, wasActive=...` |
| Snapshot найден | `undo-history: lookup HIT key=..., unresolved=N` |
| State восстановлен | `ReviewManager.restoreFromSnapshot: updating/re-creating review for ...` |
| Dispose (reload) | `ReviewManager.dispose: restoring N files to modifiedContent` |
| Persistence save | `persistence: saved N files` |
| Persistence restore | `ReviewManager.restore: restoring N files` |

**НЕ должен** спамить `terminal-input` — он отфильтрован.

## Очистка после каждого этапа

```bash
cd /Users/spals/projects/aiots/aiots-platform-spa
git checkout -- .
git clean -fd src/helpers/ 2>/dev/null
```

## Файлы-кандидаты для тестов

| Файл | Строк | Описание |
|------|-------|----------|
| `src/app/api/telegram/telegramFormatMessage.ts` | 92 | Форматтер сообщений Telegram |
| `src/queries/products/functions/function-queries.ts` | 92 | React Query хуки |
| `src/app/[lng]/use-session.ts` | 87 | Хук сессий SWR |
| `src/components/forms/options.ts` | 77 | Генератор опций форм |
| `src/queries/use-breakpoint.tsx` | 78 | Responsive хук |
| `src/utils/i18n/getTranslation.ts` | 31 | Утилита переводов |
| `next.config.mjs` | 16 | Конфиг Next.js |
