# Этап 2 — Multi-hunk: несколько изменений в одном файле

## Цель
Проверить что множественные hunks отображаются корректно, partial accept/reject работает, навигация между hunks.

---

## Промт для Claude Code

```
Прочитай файл /Users/spals/projects/aiots/aiots-platform-spa/src/app/api/telegram/telegramFormatMessage.ts

Затем сделай ТРИ изменения в этом файле одним Edit:

1. Добавь комментарий "// CCR Change 1: header" самой первой строкой файла
2. Внутри функции escapeMarkdown добавь console.log('CCR Change 2: escape called') первой строкой тела функции
3. Добавь комментарий "// CCR Change 3: footer" самой последней строкой файла

Используй один вызов Edit.
```

---

## Проверки

### Отображение 3 hunks
- [ ] В редакторе видны 3 отдельных блока с декорациями (зелёный фон)
- [ ] Каждый блок имеет свои кнопки Keep/Undo
- [ ] Счётчик показывает "Change 1/3", "Change 2/3", "Change 3/3" у каждого блока

### Навигация
- [ ] Cmd+стрелка (или ccr.nextHunk/prevHunk) переключает между hunks
- [ ] Курсор прыгает к нужному hunk

### Partial accept: Accept hunk 1
- [ ] Нажать Keep на первом hunk (комментарий header)
- [ ] Hunk 1 исчез, остались 2 unresolved
- [ ] Счётчик обновился: "Change 1/2", "Change 2/2"

### Undo partial accept
- [ ] **Ctrl+Z** → hunk 1 снова unresolved
- [ ] Счётчик вернулся: "Change 1/3", "Change 2/3", "Change 3/3"
- [ ] Все 3 блока с декорациями на месте

### Partial mix: Reject 1, Accept 2, Reject 3
- [ ] Undo на hunk 1 (reject header comment)
- [ ] Keep на hunk 2 (accept console.log)
- [ ] Undo на hunk 3 (reject footer comment)
- [ ] Файл финализирован:
  - Строка `// CCR Change 1: header` — отсутствует
  - Строка `console.log('CCR Change 2: escape called')` — присутствует
  - Строка `// CCR Change 3: footer` — отсутствует
- [ ] Декорации полностью исчезли

---

## Очистка

```bash
cd /Users/spals/projects/aiots/aiots-platform-spa
git checkout -- src/app/api/telegram/telegramFormatMessage.ts
```
