# Database backup and recovery

The warehouse 1C base is never changed by these tools. These are backups of the
Argus PostgreSQL database and the API recovery configuration only.

## Implemented

- `argus-backup.sh` runs through the existing `argus-backup.timer` at 04:15
  Moscow time. The service creates a gzip SQL dump with role grants preserved,
  a matching `.env` sidecar and a SHA-256 manifest. It refuses to publish the
  pair if the API configuration changes during the dump.
- All server backup files are root-only (`0600`), inside a root-owned `0700`
  directory. Final filenames are published only after gzip/size checks.
- `pull-offsite-backup.py` copies the latest completed pair over authenticated
  OpenSSH with strict host-key checking. It checks SHA-256, complete gzip CRC,
  source age and matching configuration hash. The configuration is encrypted
  with Windows DPAPI CurrentUser before any local write, and decryption is
  checked in memory. Secrets are never logged.
- The SQL dump is stored with a private Windows ACL (current user, SYSTEM,
  Administrators). It contains private production data; never add it to Git,
  web directories, public attachments or test fixture repositories.
- Local retention keeps 14 verified sets. The server keeps 14 days.
- `install-offsite-backup-task.ps1` registers a windowless task at 04:45 local
  Windows time and at user login, with missed-run catch-up, network gating and
  three retries every 15 minutes. It uses `pythonw.exe` and windowless children.

Configuration is an operator-owned JSON file outside the repository. Fields:
`backupDirectory`, `scriptPath`, `pythonPath`, `pythonWindowlessPath`,
`identityFile`, `sshDestination`, `remoteBackupDirectory`, `keepCopies`,
`maxAgeHours`. No passwords or tokens belong in it. Use an existing authorized
SSH identity, and copy the runtime scripts to a stable private directory.

The registered instance on 11 September 2026 uses
`C:\Users\tatar\Documents\Argus Operations\BackupTools\config.json` and stores
copies in `C:\Users\tatar\Documents\Argus Operations\Backups`.
Task name: `Argus offsite database backup`.

## Verify a run

`Backups/status.json` must report `ok: true`, a fresh `verifiedAt`,
`gzipVerified: true` and `configurationMatched: true`. Check the Task Scheduler
last result is `0`; its next trigger should be 04:45. This proves transfer and
integrity, not a restore test. A restore test has its own dated report.

Never delete the last working backup because a new run failed. A failed pull
updates `status.json` and exits nonzero, leaving prior verified sets intact.

## Recovery procedure

1. Use a new PostgreSQL database/server. Keep the damaged production database
   intact. Verify the dump hash against its manifest and run `gzip -t`.
2. The SQL dump has no database switching command and no database creation
   statement. Create a new empty target database from `template0`, and revoke
   public connection access while recovery is being checked.
3. Create the `argus_app` login role on a new server before restoration (and any
   additional application roles present in that server's schema). Set its new
   password through the normal secret configuration process; do not print it.
   SQL GRANT/REVOKE statements in the dump restore the existing restricted
   permissions. Do not replace them with blanket privileges.
4. Restore with PostgreSQL's `psql -X -v ON_ERROR_STOP=1 --single-transaction`
   into the explicit new target database. Pipe decompressed SQL into stdin.
5. Check table/row totals and all constraints; compare application-role grants
   with the baseline. Test tenant isolation and core application reads against
   the recovered database before changing any production connection.
6. Recover the matching API configuration from `.env.dpapi` using the `protect`
   helper in `pull-offsite-backup.py` with `decrypt=True`, under the same Windows
   account on this computer. Write it only into a private recovery directory
   (or pass it in memory to a secured administrative deployment). Never print
   it. Update the database connection for the recovered server; retain the
   encryption key needed for encrypted marketplace credentials.
7. Restore the matching application version and environment, then test the
   recovered application locally. Do not start marketplace/1C jobs on both old
   and recovered installations. Switch production only after explicit incident
   review and a verified recovery test.

## Limits

This PC is independent from the VPS, but transfer requires this Windows user
to be logged in, with the PC awake and online. A login trigger catches a missed
night. It is not an always-on external storage service. DPAPI protects the
configuration specifically for this Windows account/computer: copying the
ciphertext alone to a different computer is insufficient. Keep recovery access
to this Windows account. Simultaneous loss of the VPS and this PC is not covered.

The database can restore without the API configuration, but encrypted external
credentials cannot be recovered without the matching encryption key. This is
why the configuration is backed up as part of each verified pair.

## Validation performed on 11 September 2026

An actual external copy was transferred back and restored into a newly named,
isolated database. Restoration succeeded: 40 tables, 12,139 products and 985
documents; no unvalidated constraints; `argus_app` table grants matched the
source. The temporary database and uploaded file were removed afterwards.
The native scheduled task completed successfully with result `0`.

The detailed verification report belongs in the operations workspace
`outputs/offsite-restore-verification-20260911.json`, not in customer data.
