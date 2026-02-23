# Этап 4 — Persistence: сохранение/восстановление через Reload

## Цель
Проверить что после Reload Window: файлы на диске содержат modifiedContent (НЕ merged), review state восстанавливается, можно продолжить review.

**Это самый критичный тест** — именно здесь проверяется починенный баг с merged content.

---

## Промт для Claude Code

```
Сделай два изменения:

1. Прочитай /Users/spals/projects/aiots/aiots-platform-spa/src/queries/use-breakpoint.tsx и добавь комментарий "// CCR Persist Test 1" в самое начало файла.

2. Прочитай /Users/spals/projects/aiots/aiots-platform-spa/src/utils/i18n/getTranslation.ts и добавь комментарий "// CCR Persist Test 2" в самое начало файла.

Используй отдельные Edit для каждого файла.
```

---

## Подготовка состояния перед reload

### Проверки — оба файла в review
- [ ] `use-breakpoint.tsx` показывает 1 hunk (комментарий)
- [ ] `getTranslation.ts` показывает 1 hunk (комментарий)
- [ ] StatusBar: 2 files

### Частичное разрешение
- [ ] **Accept hunk в `use-breakpoint.tsx`** (файл 1 resolved)
- [ ] `getTranslation.ts` остаётся unresolved
- [ ] StatusBar: 1 file remaining

---

## Reload Window

**Действие**: `Cmd+Shift+P → Developer: Reload Window`

---

## Проверки ПОСЛЕ reload

### Файлы на диске (КРИТИЧНО)
```bash
# Файл 1 — был accepted, должен содержать modifiedContent
head -3 /Users/spals/projects/aiots/aiots-platform-spa/src/queries/use-breakpoint.tsx
# Ожидание: "// CCR Persist Test 1" — первая строка, далее обычный код
# НЕ ДОЛЖНО быть двух версий строк (merged content)

# Файл 2 — был unresolved, тоже должен быть modifiedContent
head -3 /Users/spals/projects/aiots/aiots-platform-spa/src/utils/i18n/getTranslation.ts
# Ожидание: "// CCR Persist Test 2" — первая строка
# НЕ ДОЛЖНО быть обеих версий (старая + новая)
```

### Review state восстановлен
- [ ] Sidebar показывает файл(ы) в review
- [ ] Первый unresolved файл (`getTranslation.ts`) автоматически открылся
- [ ] Декорации (зелёный фон) применились
- [ ] Кнопки Keep/Undo видны

### Можно продолжить review
- [ ] **Accept** оставшийся hunk в `getTranslation.ts`
- [ ] Файл финализирован
- [ ] Review завершён, "all files reviewed"

---

## Бонус: двойной reload

Если время позволяет — повторить:
1. Добавить ещё одно изменение
2. НЕ resolve'ить
3. Reload
4. Проверить что review восстановился
5. Resolve
6. Reload ещё раз
7. Проверить что review state чист (нет persist файла)

---

## Очистка

```bash
cd /Users/spals/projects/aiots/aiots-platform-spa
git checkout -- src/queries/use-breakpoint.tsx src/utils/i18n/getTranslation.ts
rm -f .claude/review-state.json
```
