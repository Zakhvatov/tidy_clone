# flow-setup — рабочий поток и оркестрация

## 1. Origin засинхронизирован

```
$ git remote add origin https://github.com/Zakhvatov/tidy_clone.git
$ git push -u origin master
 * [new branch]      master -> master
branch 'master' set up to track 'origin/master'.
```

Репозиторий на GitHub был пуст (0 ветвей), master запушен первым. Доступ подтверждён `gh auth status`
(аккаунт Zakhvatov, scope `repo`).

## 2. Документ потока

`docs/dev-flow.md` — роли (worker / reviewer / tester / auditor / coordinator), порядок работы над
задачей, формат доказательств, границы и запреты, правила ветки и коммитов.

## 3. Саб-агенты реально запускаются

Проверено 3 факта:

1. `pi -p --no-session` работает headless и умеет пользоваться инструментами:
   ```
   $ pi -p "Создай файл hello.txt ..." --mode text --no-session
   sub-agent works
   ```
2. Скрипт-обёртка `tools/agents/run.sh` запускает роль в фоне, пишет лог и статус:
   ```
   $ tools/agents/run.sh worker selftest .agents/prompts/selftest.md &
   $ tools/agents/poll.sh selftest
   worker-selftest                    done:0     bytes=957      idle=36s
   ```
3. Агент вернул отчёт в требуемом формате (`STATUS: done`, ФАЙЛЫ, ПРОВЕРКИ, РИСКИ, РЕШЕНИЯ) и создал
   файл-артефакт `docs/evidence/raw/flow-selftest.txt`.

Побочная находка: `claude` CLI установлен, но не залогинен («Not logged in · Please run /login»),
поэтому саб-агенты запускаются через `pi`, а не через `claude`. Orca-worktree остаются доступны как
способ изоляции параллельных исполнителей.
