# Release notes: storage, backups, restore, disk, time zone (wip-data)

## New
- Backups can be locked with a passphrase. Set `BACKUP_PASSPHRASE` and the copies off the laptop become `.locked` files. Only the passphrase opens them. This works the same way as Budget it.
- The owner can download a locked backup: with the passphrase set, "Download everything (locked)". Without it, "Download locked…" asks for a passphrase to lock that one download.
- New laptop command: `node server.js restore FILE`. It puts back a `.zip`, a `.locked` file or a daily `db-….json` from a file on the laptop, even while the app is running. Backups too big for the website (over 100 MB) no longer need it.
- New `TZ` setting, so reminders, bill dates and "today" follow the house's clock.
- The owner's page shows the server's time zone. It warns when the server runs on UTC, or on a different zone from the owner's phone.

## Improved
- Backup copies are taken every 6 hours and each time the app starts (so every update starts with a fresh copy). The last 12 are kept, plus the 30 daily copies and the Sunday copies kept for a year.
- The copy off the laptop holds the records and is refreshed every 6 hours (one file a day, 14 days kept). Each receipt photo goes into a `photos/` folder there once, instead of into every day's zip.
- Backups are written to disk as they are made, one photo at a time, instead of being built whole in memory.
- Expenses and payments are on the laptop's disk before your phone is told they were saved.
- Restoring from the website accepts locked backups and asks for the passphrase.
- The owner's page warns when the laptop's disk is 90% full.

## Fixed
- A full disk no longer crashes the app over and over. The app keeps showing everything it has, says plainly that new changes can't be saved, tries again by itself, and warns the owner with a banner. Changes refused this way are not shown as saved.
- If `db.json` is damaged when the app starts and it falls back to a backup copy, the owner now sees a banner naming the copy and when it was taken, until they tap "Got it". A file that reads as JSON but is the wrong shape (for example `{"docs":null}`) now counts as damaged too.
- A restore checks the whole file before it replaces anything. A wrong-shaped file (for example `{"docs":null}`) is refused with a clear message, and the app keeps working.
- Backup file names and "today" on the server used UTC dates in a few places (the daily backup name, the copy off the laptop, downloads). They now use the local date.

## Security
- Backups no longer hold sign-ins (session tokens), open invite links, one-time assistant sign-in codes, phone notification subscriptions or the notification sending key. A restore keeps the ones the laptop has now. After a move to a new laptop, everyone signs in again and turns phone notifications back on.
- Copies off the laptop can be locked (AES-256-GCM, with a key made from the passphrase by scrypt). Receipt photos in the copy folder are locked one by one too. If a passphrase is set later, the unlocked photo copies are replaced by locked ones.

## For the README

### Backups off the laptop
Set `BACKUP_COPY_DIR` to a folder that isn't on the laptop's disk: a USB drive, or a folder that Syncthing, Dropbox or Nextcloud sends somewhere else. In Docker, mount that folder into the container (see the lines marked `copy` in `compose.yaml`).

The records (`db.json`, people and their password checks, assistant connections) go there every 6 hours as `split-it-backup-YYYY-MM-DD.zip`. That is one file per day, refreshed during the day, with 14 days kept. Each receipt photo is copied into `photos/` in that folder once. On the laptop, `data/backups` also keeps a copy of the records from every start and every 6 hours (12 kept), one per day (30 kept) and one per Sunday (52 kept).

### BACKUP_PASSPHRASE
Set `BACKUP_PASSPHRASE` to a long phrase only you know, and the copies off the laptop are locked: `split-it-backup-YYYY-MM-DD.locked`, and `photos/*.jpg.locked`. Keep the passphrase somewhere that isn't the laptop, such as a password manager. Without it nobody can open these copies, you included. With the passphrase set, the owner's page also offers a locked download. Backups never hold sign-ins, so a backup can't be used to sign in as anyone. It does hold everyone's password checks and records, which is why locking it matters.

### Restoring
- From the laptop (best for big backups, and works while the app runs):
  `node server.js restore FILE`
  In Docker: `docker compose exec split-it node server.js restore /backup-copy/split-it-backup-2026-11-11.locked`. The file has to be inside the container, for example in the mounted backup folder.
  It accepts a `.zip`, a `.locked` file or a daily `db-….json`. For a locked file it uses `BACKUP_PASSPHRASE`, or asks for the passphrase if that isn't set. To type a different one: `BACKUP_PASSPHRASE= node server.js restore FILE`. Photos are brought back from the `photos/` folder next to the file.
- From the app: tap your picture, then People, backups and health, then Restore a backup. Cloudflare's free plan stops uploads over 100 MB, so use the laptop command for anything bigger.
- A restore checks the whole file first and refuses one that isn't Split it data. What was there before is kept in `data/backups/before-restore-…`, so a restore can be undone.
- Do one test restore into a spare copy of the app before you need a real one.

### TZ (time zone)
Containers run on UTC unless told otherwise, so a 9 am reminder arrives at 4 am in Toronto and "today" changes at 7 pm. Set `TZ` to the house's time zone, for example `TZ=America/Toronto` (names are listed at https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). Put it in `split-it.env`, or in the `environment:` list in `compose.yaml` (it defaults to `America/Toronto` there), or in your host's settings (Coolify: Environment variables). `REMIND_HOUR` is counted in that time zone. The owner's page shows the zone the server uses and warns when it's UTC.

### Full disk
If the laptop's disk fills up, Split it keeps running and showing everything. New changes are refused with a message until there is room again, and the owner sees a banner. The owner's page warns at 90% full.

## Not done
- **Zip64**: backups are plain zip files, so one download is limited to 4 GB and 65,535 files. Beyond that, writing a backup fails with a clear message instead of making a broken file. The daily copy off the laptop holds no photos, so it never gets near the limit.
- **Restore still reads each zip entry into memory one at a time** (db.json, then each photo). A locked upload is unlocked to a work file on disk first, so it is never held whole in memory. The website upload limit stays at 400 MB.
- **Photos removed from the laptop are not removed from the copy folder's `photos/`**. That is on purpose: a disk that lost photos must not delete their backups. Old ones can be cleared by hand.
- **Locked files use Budget it's layout with a Split it mark** (`SIBK1` instead of `BIBK1`), so each app can say plainly when it's given the other app's backup. It refuses that backup with "That's a Budget it backup".
- **The laptop restore command doesn't ask "type yes"**. The person typed the file name, and the restore can be undone from `before-restore-…`. Asking twice on one stdin was fragile.
- **A very slow restore through the laptop command**: the command waits up to 30 minutes, but Node's own fetch gives up after about 5 minutes with no answer. The restore then still finishes inside the app, and the command says to check the owner's page.
- **Dockerfile**: unchanged. Node's built-in time zone data makes `TZ` work on the Alpine image without installing tzdata (checked: setting `TZ` at run time changes local hours in Node).
- **Merge notes**: the integrity slice moves `/api/write` into `writeOps()`. It already calls `storageProblem()` and `commitDb()` behind `typeof` guards, which can be dropped once both branches are in. My branch makes the same two-line change inside the old inline `/api/write`, so expect a small conflict there: keep writeOps. Assistant (mcp.js) writes that go through writeOps also get the flush-before-OK for expenses. mcp.js itself was not touched.
