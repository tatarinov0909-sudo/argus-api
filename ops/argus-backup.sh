#!/bin/bash
# A consistent DB dump and matching API recovery configuration. Root-only files.
set -euo pipefail
umask 077
DIR=${ARGUS_BACKUP_DIR:-/var/backups/argus}
ENV_FILE=${ARGUS_API_ENV_FILE:-/opt/argus-api/.env}
DATABASE=${ARGUS_DATABASE:-argus}
KEEP=14
mkdir -p "$DIR"
chown root:root "$DIR"
chmod 700 "$DIR"
exec 9>"$DIR/.backup.lock"
flock -n 9 || exit 0
STAMP=$(date +%Y-%m-%d_%H%M%S)
FILE="$DIR/argus-$STAMP.sql.gz"
cleanup() { rm -f -- "$FILE.part" "$FILE.env.part" "$FILE.json.part"; }
trap cleanup EXIT
test -s "$ENV_FILE"
cp -- "$ENV_FILE" "$FILE.env.part"
chmod 600 "$FILE.env.part"
# Preserve GRANT/REVOKE: losing the restricted app role grants would make a
# restored schema look healthy while breaking the application or overgranting it.
sudo -u postgres pg_dump --no-owner "$DATABASE" | gzip -9 > "$FILE.part"
gzip -t "$FILE.part"
test "$(stat -c%s "$FILE.part")" -ge 10240
# Key rotation during a dump invalidates the pair. Do not publish that backup.
cmp -s "$ENV_FILE" "$FILE.env.part"
python3 - "$FILE" "$DATABASE" <<'PY'
import datetime,hashlib,json,pathlib,sys
base=pathlib.Path(sys.argv[1])
def digest(path):
    result=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''): result.update(chunk)
    return result.hexdigest()
pathlib.Path(str(base)+'.json.part').write_text(json.dumps({
    'database':sys.argv[2], 'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sha256':digest(pathlib.Path(str(base)+'.part')),
    'configurationSha256':digest(pathlib.Path(str(base)+'.env.part')),
    'configurationMatched':True,
},indent=2),encoding='utf-8')
PY
chmod 600 "$FILE.part" "$FILE.json.part"
mv -- "$FILE.env.part" "$FILE.env"
mv -- "$FILE.json.part" "$FILE.json"
# Only the final .sql.gz name is visible to the external copy process.
mv -- "$FILE.part" "$FILE"
while IFS= read -r -d '' old; do
  rm -f -- "$old" "$old.env" "$old.json"
done < <(find "$DIR" -maxdepth 1 -type f -name 'argus-*.sql.gz' -mtime +"$KEEP" -print0)
printf 'argus-backup: verified database/configuration pair, %s bytes\n' "$(stat -c%s "$FILE")"
