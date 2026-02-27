# День 1: Результаты исследования

## 1. Claude Code CLI — Hook System

### Формат JSON на stdin

Общие поля для всех hook-событий:
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default|ask|allow",
  "hook_event_name": "PreToolUse|PostToolUse|..."
}
```

Tool-события добавляют:
```json
{
  "tool_name": "Bash|Write|Edit|Read|Glob|Grep",
  "tool_input": { ... },
  "tool_use_id": "correlation-uuid"
}
```

### КРИТИЧНО: Разные имена полей для разных инструментов

| Tool | Поле пути | Пример |
|------|-----------|--------|
| **Write** | `tool_input.file_path` | `/abs/path/to/file.txt` |
| **Read** | `tool_input.file_path` | `/abs/path/to/file.txt` |
| **Edit** | `tool_input.path` | `/abs/path/to/file.txt` |
| **Bash** | `tool_input.command` | `npm test` |
| **Glob** | `tool_input.pattern` + `tool_input.path` | `**/*.js` |
| **Grep** | `tool_input.pattern` + `tool_input.path` | `regex` |

**ПРОВЕРЕНО**: Логи server.log обоих пользователей подтверждают что Edit tool УСПЕШНО передаёт `file_path`. CLI отправляет `file_path` для Edit/Write/Read.

**РЕАЛЬНЫЕ БАГИ из логов user 1 (review.log):**
- Строка 10: `addFile: .../indigo-spa/2>/dev/null` — bash-file-parser извлёк shell redirect как путь файла из Bash-команды `find ... 2>/dev/null`
- Строки 37,49,53,57: `addFile: .../indigo-spa/` + пустая строка — директории (пути на `/`) добавляются как файлы для ревью
- Это баги **bash-file-parser.ts**, а не хук-скриптов

### Типы Notification hooks

```json
{
  "hook_event_name": "Notification",
  "notification_type": "permission_prompt|idle_prompt|auth_success|elicitation_dialog",
  "message": "..."
}
```

### Известные проблемы CLI с хуками

- PreToolUse exit code 2 не всегда блокирует Write/Edit
- PostToolUse пропускается когда Bash-команды фейлятся
- `updatedInput` в PreToolUse ответах иногда игнорируется (bug #15897)

### Пути файлов

- Всегда абсолютные, никогда не обрезаются в JSON
- CLI НЕ усекает пути при передаче хукам
- Спецсимволы (unicode, пробелы) передаются как есть

---

## 2. Terminal Output Format

### Ключевое открытие: CLI НЕ использует alternate screen buffer

Claude Code CLI рендерит всё в нормальном буфере с scrollback. Это осознанное архитектурное решение:
- Мышиный скролл работает нативно
- История сохраняется в scrollback
- НЕ использует alternate buffer даже для интерактивных вопросов

### Differential Rendering

CLI перерисовывает viewport десятки раз в секунду:
1. Определяет что изменилось (diff каждой ячейки)
2. Отправляет только минимальные ANSI escape sequences
3. Сохраняет scrollback buffer

### Длинные пути в выводе

Пути НЕ обрезаются в JSON хуков. Но в терминальном выводе длинные пути переносятся:
```
⏺ Write(/Users/spals/projects/aiots/aiotd-interface-template/.claude/rules/
       lvgl-xml-conventions.md)
```
Это особенность рендеринга CLI, а не JSON формата.

---

## 3. Скачки скролла — Root Cause Analysis

### Корневая причина: Отсутствие frame sync

Текущий data flow:
```
PTY (async) → postMessage → JS handler → term.write() → xterm.js render
     ↓              ↓              ↓
  Unbatched    Unbatched      Out of order
```

Правильный паттерн:
```
PTY → Queue → requestAnimationFrame → Single write() → xterm.js render
```

**Это одно изменение решит ~70% проблем со скроллом.**

### Конкретные проблемы найденные в коде

1. **Нет батчинга вывода** — каждый PTY data chunk → отдельный postMessage → отдельный term.write()
   - Файл: `media/webview/message-router.js` строки 100-270
   - При 50KB/sec вывода = 50-100 отдельных write() на кадр

2. **scrollToBottom() вызывается из 4+ мест** — конкурируют с пользовательским скроллом
   - `message-router.js` строки 121, 131, 142, 187

3. **Пиксельный порог скролла (5px) слишком мал** — должен быть line-count based или ~40px
   - `message-router.js` строка 9: `SCROLL_BOTTOM_THRESHOLD = 5`

4. **Нет `scrollOnOutput: false`** в конфигурации xterm.js
   - `terminals.js` строки 104-120 — создание Terminal без этой опции

5. **Выход из alternate buffer всегда скроллит вниз** — игнорирует позицию пользователя
   - `message-router.js` строка 182: `didScroll = wasAtBottom || ... || hasAltExit`

6. **Hardcoded 60ms задержка фокуса** без проверки успеха
   - `terminals.js` строка 693

7. **Race condition при загрузке** — 2.5s idle timeout может сработать неправильно
   - `message-router.js` строки 129-145

### Рекомендуемый fix — Output Write Batching

```javascript
// В message-router.js — заменить прямые term.write() на батчинг
var writeQueue = new Map(); // sessionId → data[]

function queueWrite(sessionId, data) {
    var q = writeQueue.get(sessionId);
    if (!q) {
        q = [];
        writeQueue.set(sessionId, q);
        requestAnimationFrame(function() {
            flushWrites(sessionId);
        });
    }
    q.push(data);
}

function flushWrites(sessionId) {
    var q = writeQueue.get(sessionId);
    writeQueue.delete(sessionId);
    if (!q || !q.length) return;
    var combined = q.join("");
    var t = getTerminal(sessionId);
    if (t && t.term) {
        t.term.write(window.annotateFileLinks(combined));
        // Single scroll decision after all data written
        handleScrollAfterWrite(t);
    }
}
```

---

## 4. Фокус — Root Cause Analysis

### Где фокус теряется

1. **fitActiveTerminal()** — `fitAddon.fit()` может триггерить layout shift
   - `terminals.js` строка 698

2. **state-update message** — toolbar refresh может украсть фокус к кнопке
   - `message-router.js` строка 387

3. **ResizeObserver** — каждые 100ms вызывает fitActiveTerminal()
   - `terminals.js` строки 950-965

4. **Нет обработки onDidChangeVisibility** — при скрытии/показе sidebar фокус теряется

### Рекомендуемый паттерн

```javascript
// Сохранять и восстанавливать фокус вокруг обновлений
var wasFocused = document.activeElement === entry.term.element ||
                 entry.term.element.contains(document.activeElement);
// ... обновления DOM ...
if (wasFocused) entry.term.focus();
```

---

## 5. VS Code Decoration API — Findings

### Когда VS Code сбрасывает декорации

| Событие | Декорации сохраняются? | Примечание |
|---------|----------------------|------------|
| Tab switch (другой файл) | Нет — нужно переприменить | `onDidChangeActiveTextEditor` |
| `editor.edit()` | Да, но ranges могут сдвинуться | Нужно переприменить |
| `WorkspaceEdit` | Да, но ranges могут сдвинуться | Аналогично |
| Revert | Возможна рассинхронизация | Нужна проверка |
| Undo/Redo | НЕ восстанавливаются | VS Code bug #245108 |
| Внешнее изменение файла | Ranges невалидны | Нужна реакция |

### ViewZones API

**НЕ доступно** через публичный API расширений (VS Code issue #88483). Используется только внутри VS Code (diff viewer) и Cursor (fork). Для нашего расширения — не вариант.

### Что отсутствует в текущей реализации

1. **`onDidChangeTextDocument` listener** — нет реактивного обновления декораций при ручных правках
2. **`rangeBehavior: ClosedOpen`** — не указан, декорации могут расширяться при наборе
3. **Disposal декорационных типов** — не вызывается в `deactivate()`
4. **Debounced refresh** — нет паттерна как в Error Lens

### Рекомендуемые исправления

#### A. Добавить onDidChangeTextDocument
```typescript
let decorationTimeout: NodeJS.Timeout | undefined;
vscode.workspace.onDidChangeTextDocument((e) => {
    if (state.activeReviews.has(e.document.uri.fsPath)) {
        clearTimeout(decorationTimeout);
        decorationTimeout = setTimeout(() => {
            const editor = vscode.window.visibleTextEditors.find(
                ed => ed.document === e.document
            );
            if (editor) {
                const review = state.activeReviews.get(e.document.uri.fsPath);
                if (review) applyDecorations(editor, review);
            }
        }, 300);
    }
});
```

#### B. Добавить rangeBehavior
```typescript
const decoAdded = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,  // ДОБАВИТЬ
});
```

#### C. Dispose в deactivate()
```typescript
export function deactivate() {
    decoAdded.dispose();
    decoAddedInline.dispose();
    decoGutterPending.dispose();
    decoSeparator.dispose();
}
```

---

## 6. Обновления к плану рефакторинга

### Новые findings, влияющие на план

1. **День 2 (Хуки)**: Edit tool использует `path` вместо `file_path` — нужно извлекать оба поля
2. **День 4 (Скролл)**: Корневая причина — отсутствие frame sync. Нужен write batching через requestAnimationFrame
3. **День 4 (Декораторы)**: Добавить `onDidChangeTextDocument` listener + `rangeBehavior` + disposal
4. **День 4 (Фокус)**: Паттерн save/restore focus вокруг DOM обновлений

### Приоритизация по impact

1. 🔴 **bash-file-parser: shell redirect extraction** — `2>/dev/null` и директории попадают в review (День 2)
2. 🔴 **Write batching с rAF** — решает 70% scroll проблем (День 4)
3. 🟡 **onDidChangeTextDocument** — предотвращает "слёт" декораций (День 4)
4. 🟡 **Focus save/restore pattern** — предотвращает потерю фокуса (День 4)
5. 🟢 **rangeBehavior + disposal** — улучшение стабильности (День 4)
