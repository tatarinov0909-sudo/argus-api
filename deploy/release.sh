#!/usr/bin/env bash
# Выкладка файлов API на прод по правилу владельца:
# проверка → бэкап приложения и базы → атомарная замена → миграции →
# перезапуск → проверка здоровья → откат приложения при любой ошибке.
#
#   deploy/release.sh <метка> [--migrate] <файл>...
#
# Файлы — пути от корня репозитория, только закоммиченные. Миграции
# node-pg-migrate выполняет каждую в своей транзакции: упавшая не меняет
# базу, поэтому откатывается только приложение. База из бэкапа руками:
#   pg_restore --clean -d argus <папка>/database.dump
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=root@193.187.94.167
APP=/opt/argus-api
label=${1:?укажите метку выкладки}; shift
migrate=0; files=()
for a in "$@"; do if [ "$a" = --migrate ]; then migrate=1; else files+=("$a"); fi; done
[ ${#files[@]} -gt 0 ] || { echo "не указаны файлы"; exit 1; }
ts=$(date +%Y%m%d-%H%M%S)
backup=/opt/argus-backups/$label-$ts
remote() { ssh -i ~/.ssh/argus_vps -o BatchMode=yes "$HOST" "$@"; }

echo "1/6 проверка"
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "нет файла $f"; exit 1; }
  git diff --quiet HEAD -- "$f" || { echo "$f не закоммичен"; exit 1; }
  case "$f" in *.js) node --check "$f" ;; esac
done
remote "curl -sf http://127.0.0.1:3000/health >/dev/null" || { echo "прод нездоров ещё до выкладки"; exit 1; }

echo "2/6 бэкап в $backup"
# Новые файлы в архив не попадут — их список нужен, чтобы откат их удалил.
remote "set -e; mkdir -p $backup; chmod 700 $backup; cd $APP
  : > $backup/new-files
  existing=''; for f in ${files[*]}; do if [ -e \"\$f\" ]; then existing=\"\$existing \$f\"; else echo \"\$f\" >> $backup/new-files; fi; done
  tar cf $backup/application.tar \$existing 2>/dev/null || tar cf $backup/application.tar --files-from /dev/null
  sudo -u postgres pg_dump -Fc argus > $backup/database.dump; chmod 600 $backup/database.dump
  test -s $backup/database.dump"

echo "3/6 выкладка"
tar cf - "${files[@]}" | remote "set -e; in=$APP/.incoming-$ts; mkdir -p \$in; tar xf - -C \$in
  cd \$in; find . -type f | while read -r f; do mkdir -p \"$APP/\$(dirname \"\$f\")\"; mv -f \"\$f\" \"$APP/\$f\"; done
  rm -rf \$in"

rollback() {
  echo "ОТКАТ приложения из $backup"
  remote "cd $APP; tar xf $backup/application.tar; while read -r f; do rm -f \"\$f\"; done < $backup/new-files
    pm2 restart argus-api --update-env >/dev/null; sleep 4; curl -sf http://127.0.0.1:3000/health" \
    && echo "откат выполнен, прод здоров" || echo "ВНИМАНИЕ: после отката прод не отвечает"
  exit 1
}

if [ $migrate = 1 ]; then
  echo "4/6 миграции"
  remote "cd $APP && sudo -u postgres DATABASE_URL='postgres:///argus?host=/var/run/postgresql' npx node-pg-migrate up -m src/db/migrations --no-single-transaction 2>&1 | tail -3" || rollback
else
  echo "4/6 миграций нет"
fi

echo "5/6 перезапуск"
remote "pm2 restart argus-api --update-env >/dev/null" || rollback

echo "6/6 проверка здоровья"
for i in $(seq 1 15); do
  sleep 2
  if remote "curl -sf http://127.0.0.1:3000/health >/dev/null && pm2 jlist | grep -q '\"status\":\"online\"'"; then
    sleep 5  # падение при первом запросе к базе проявляется не сразу
    remote "curl -sf http://127.0.0.1:3000/health >/dev/null" || rollback
    echo "готово: $label, бэкап $backup"
    exit 0
  fi
done
rollback
