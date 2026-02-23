# Этап 3 — Create / Delete файлов

## Цель
Проверить Write (создание нового файла), Bash rm (удаление), changeType=create и changeType=delete.

---

## Шаг 3a — Write: создание нового файла

### Промт для Claude Code

```
Создай новый файл /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-test-helper.ts с содержимым:

/**
 * CCR Test Helper — temporary file for testing
 */
export function ccrTestAdd(a: number, b: number): number {
  return a + b;
}

export function ccrTestMultiply(a: number, b: number): number {
  return a * b;
}

export const CCR_TEST_VERSION = '1.0.0';
```

### Проверки 3a
- [ ] Review появился — весь файл подсвечен зелёным (changeType=create)
- [ ] Нет красных строк (нечего удалять — файл новый)
- [ ] StatusBar показывает файл в review

### Reject All (= отменить создание)
- [ ] Нажать Reject All (или Undo на единственный hunk)
- [ ] Файл **УДАЛЁН** с диска

### Проверка удаления
```bash
ls -la /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-test-helper.ts
# Ожидание: "No such file or directory"
```

---

## Шаг 3b — Повторное создание + Accept

### Промт для Claude Code

```
Создай файл /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-test-helper.ts с тем же содержимым что и раньше (CCR Test Helper с функциями ccrTestAdd, ccrTestMultiply и константой CCR_TEST_VERSION).
```

### Проверки 3b
- [ ] Review появился снова (create)
- [ ] Нажать **Accept All** → файл остался на диске
- [ ] Содержимое файла корректное

### Проверка наличия
```bash
cat /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-test-helper.ts
# Ожидание: содержимое файла видно
```

---

## Шаг 3c — Bash rm: удаление файла

### Промт для Claude Code

```
Удали файл через Bash:
rm /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-test-helper.ts
```

### Проверки 3c
- [ ] Review появился с changeType=delete
- [ ] Весь контент показан красным (strikethrough) — строки которые были в файле
- [ ] Нет зелёных строк

### Reject (= отменить удаление, восстановить файл)
- [ ] Нажать **Reject All** → файл **ВОССТАНОВЛЕН** на диске
- [ ] Содержимое совпадает с оригиналом

### Проверка восстановления
```bash
cat /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-test-helper.ts
# Ожидание: файл существует, содержимое правильное
```

---

## Шаг 3d — Повторное удаление + Accept

### Промт для Claude Code

```
Удали файл:
rm /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-test-helper.ts
```

### Проверки 3d
- [ ] Review = delete
- [ ] **Accept All** → файл удалён окончательно
- [ ] `ls` подтверждает что файла нет

---

## Очистка

```bash
rm -f /Users/spals/projects/aiots/aiots-platform-spa/src/helpers/ccr-test-helper.ts
```
