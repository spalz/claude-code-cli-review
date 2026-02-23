# Этап 1 — Smoke: один Edit, один hunk

## Цель
Базовая проверка: хук срабатывает, review появляется, декорации рендерятся, accept/reject работает.

---

## Промт для Claude Code

```
Прочитай файл /Users/spals/projects/aiots/aiots-platform-spa/next.config.mjs и добавь в самое начало файла (перед первой строкой) комментарий:

// CCR Smoke Test

Используй Edit tool. Больше ничего не меняй.
```

---

## Проверки после появления review

### UI
- [ ] В редакторе появились декорации: зелёный фон у добавленной строки `// CCR Smoke Test`
- [ ] Кнопки "Keep ⌘Y" / "Undo ⌘N" видны справа от строки
- [ ] StatusBar внизу показывает информацию о review (1 file)
- [ ] В Sidebar "Claude Code Review" файл отображается в списке

### Accept
- [ ] Нажать **Keep (⌘Y)** → комментарий остаётся в файле
- [ ] Декорации исчезли
- [ ] StatusBar показывает "all files reviewed" или пустой

### Undo после Accept
- [ ] **Ctrl+Z** → review state восстановился
- [ ] Декорации (зелёный фон) вернулись
- [ ] Кнопки Keep/Undo снова видны
- [ ] StatusBar снова показывает 1 hunk

### Reject
- [ ] Нажать **Undo (⌘N)** → комментарий удалён из файла
- [ ] Файл вернулся к оригиналу
- [ ] Декорации исчезли

### Undo после Reject
- [ ] **Ctrl+Z** → review state восстановился снова
- [ ] Декорации вернулись

---

## Очистка

```bash
cd /Users/spals/projects/aiots/aiots-platform-spa
git checkout -- next.config.mjs
```
