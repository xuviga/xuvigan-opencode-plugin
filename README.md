# XuViGaN Plugin Pack

## Что осталось

**1 флай 4 функции. Всё в одном.**

| Плагин | Что делает |
|--------|-----------|
| `xuvigan.ts` | Memory + Errors + Verify + Guard |

## Почему выброшено

| Плагин | Почему выброшен |
|--------|----------------|
| checkpoint.ts | Защита без safety net — бессмысленно |
| context.ts | Инжект каждый раз — шум |
| decisions.ts | Требует ручного вызова |
| decomposer.ts | Лучше просто сделать |
| scratchpad.ts | Memory лучше |
| superprompt.ts | Генерировал шумный текст |
| workflow.ts | Никто не вызывает вручную |
| xuvigan.ts | GO-требование → friction |
| decisions.ts | Нужен явный decision_log |

## Что делает xuvigan.ts

**Automatic:**
- Session start → напоминает preferences/blockers
- Bash output → ищет в базе ошибок → подсказывает решение
- Write .ts/.js → проверяет импорты, логирует проблемы
- Bash dangerous → warn (не блокирует!)
- Write sensitive → warn (не блокирует!)

**Tools (13 штук):**
- `memory_remember`, `memory_search`, `memory_forget`
- `error_check`, `error_log`, `error_resolve`
- `verify_check`, `verify_file`, `verify_imports`
- `guard_scan`

## Установка

```bash
cd ~/.config/opencode && bun install
```
