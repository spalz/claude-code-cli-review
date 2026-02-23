# Этап 5 — Re-edit и Bash-команды

## Цель
Проверить: повторное редактирование файла уже в review, Bash cp/mv, сложные bash-команды.

---

## Шаг 5a — Re-edit: первое изменение

### Промт для Claude Code

```
Прочитай /Users/spals/projects/aiots/aiots-platform-spa/src/components/forms/options.ts и добавь комментарий "// Version 1" в самое начало файла.
```

### Проверки
- [ ] Review появился с 1 hunk
- [ ] **НЕ делай accept/reject** — оставь unresolved

---

## Шаг 5b — Re-edit: повторное редактирование того же файла

### Промт для Claude Code

```
Прочитай /Users/spals/projects/aiots/aiots-platform-spa/src/components/forms/options.ts ещё раз. Замени комментарий "// Version 1" на "// Version 2" и добавь после него строку "// Additional line".
```

### Проверки
- [ ] Review **обновился** — не два review, а один обновлённый
- [ ] hunks отражают разницу между **оригиналом (git HEAD)** и **текущим** содержимым
- [ ] originalContent = версия из git (БЕЗ каких-либо комментариев)
- [ ] modifiedContent содержит "// Version 2" и "// Additional line"

### Accept
- [ ] **Accept All** → файл содержит "// Version 2" и "// Additional line"
- [ ] НЕ содержит "// Version 1"

### Reject (альтернативный путь — если undo)
- [ ] Ctrl+Z → вернуть в review
- [ ] **Reject All** → файл = оригинал из git (без ЛЮБЫХ комментариев)

---

## Шаг 5c — Bash: mv (переименование)

### Промт для Claude Code

```
Создай файл /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-move-source.ts:

export const SOURCE = 'original location';

Затем переименуй его:
mv /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-move-source.ts /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-move-dest.ts
```

### Проверки
- [ ] Два review: source (delete) + dest (create или edit)
- [ ] Source review: красные строки (удаление)
- [ ] Dest review: зелёные строки (создание)

### Варианты resolve:
- Accept оба → source удалён, dest существует (переименование подтверждено)
- Reject оба → source восстановлен, dest удалён (откат переименования)

---

## Шаг 5d — Bash: cp (копирование)

### Промт для Claude Code

```
Скопируй файл:
cp /Users/spals/projects/aiots/aiots-platform-spa/src/utils/i18n/getTranslation.ts /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-translation-copy.ts
```

### Проверки
- [ ] Review для нового файла (create)
- [ ] Оригинал НЕ в review (не изменился)
- [ ] **Reject** → копия удалена
- [ ] Оригинал не затронут

---

## Шаг 5e — Bash: сложная команда (echo + redirect)

### Промт для Claude Code

```
Выполни:
echo '{"test": true, "version": 1}' > /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-bash-test.json
```

### Проверки
- [ ] Review для нового файла
- [ ] Содержимое = JSON
- [ ] Accept → файл остаётся
- [ ] Или Reject → файл удалён

---

## Очистка

```bash
cd /Users/spals/projects/aiots/aiots-platform-spa
git checkout -- src/components/forms/options.ts
rm -f src/helpers/ccr-move-source.ts src/helpers/ccr-move-dest.ts
rm -f src/helpers/ccr-translation-copy.ts
rm -f src/helpers/ccr-bash-test.json
```
