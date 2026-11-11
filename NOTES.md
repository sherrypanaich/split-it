# Release notes: sign-in and request safety

## Improved
- You stay signed in while you use Split it: each day you open it, your sign-in runs another 90 days. Nobody is signed out by the update.
- Connecting an assistant: if you're already signed in to Split it in that browser, one tap on "Allow" is enough. No password to type.
- People who sign in only with Google can now connect an assistant (sign in to Split it first from the connect page, then tap Allow).
- The connect page shows the address your key will be sent to, in large type, so a look-alike app is easy to spot.
- Too many wrong passwords for one person now slows sign-in down for a short while instead of locking that person out.

## Fixed
- Behind a proxy (Docker, Coolify, Traefik, Cloudflare), five wrong passwords from one person no longer lock everyone out for 15 minutes. Split it now counts tries per real visitor.
- New assistants can always connect: apps that signed up but never finished connecting are cleared after a day, and when the list is full the oldest unused ones make room.

## Security
- Sign-in tokens are stored hashed, so a copy of a backup can't be used to sign in as anyone.
- Changing your email asks for your current password (or a code from your authenticator app). If you sign in only with Google, it works within 10 minutes of signing in.
- Requests that change things are refused when they come from another website's page.
- Each address can sign up at most 20 assistant apps an hour.
- Assistant keys and connections nobody used for 90 days stop working. The profile already shows when each was last used.
- A request passed on by a proxy is never treated as coming from the laptop itself.

## For the README

### Running behind a proxy
If Split it runs behind Docker, Traefik, Coolify, Caddy, nginx or a Cloudflare tunnel, every request reaches it from the proxy's address. Split it then reads the visitor's real address from the proxy's headers (`CF-Connecting-IP` from Cloudflare, otherwise the right-most outside address in `X-Forwarded-For`), and uses it for the wrong-password limits. It believes those headers only when the request comes from this computer or a private network address (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, loopback). If your proxy has a fixed address, set `TRUSTED_PROXY` to it so nothing else is believed. Make sure the app's own port is not reachable from outside without the proxy (for example bind it, or the proxy's ports, to 127.0.0.1 when a tunnel is the only way in), since anyone who can reach a trusted address directly can claim any visitor address.

Set `PUBLIC_URL` to the address people open. Writes from a browser are accepted only from that address or from the address the request was sent to.

Setting: `TRUSTED_PROXY` — addresses or ranges of your proxies, comma separated (e.g. `10.0.2.6,172.18.0.0/16`). Empty: this computer and private network addresses. `none`: never believe forwarded headers.

### Assistant keys
Keys and assistant connections that nobody uses for 90 days stop working; make a new one in your profile if that happens.

## For Budget it (copying accounts.js)
accounts.js now also exports, next to the factory function: `sessionKey(token)` (sha256 hex), `sessionGet(store, token)`, `sessionPut(store, token, rec)`, `sessionDrop(store, token)`, `migrateSessions(store)` (hashes plain keys once and sets `store.sessionsHashed`; returns true when the store must be saved) and `slideSession(rec, days)` (pushes `exp` at most once a day; true when the cookie should be sent again). The handle now also exposes `startSession(req, res, uid)`. Budget it's server.js needs to: call `migrateSessions(users)` after loading users.json and save if it returns true; look sessions up with `sessionGet`; pass a hashed key (`sessionKey(cookie)`) as `keep` to `endSessions` and in its stream map; drop on sign-out with `sessionDrop`; set `users.sessionsHashed = true` after a restore that keeps current sessions; make `tooManyTries(req)` address-only and pass `slowDown(uid)` (a promise that waits, or null) in `h`; and make its `setCookie` append rather than replace other Set-Cookie headers. accounts.js accepts `?next=/path` on `/auth/google` and returns there after a Google sign-in.

## Not done
- Linking a Google account from the profile (`/auth/google?mode=link`) still needs only a signed-in session, so an unlocked borrowed phone could link someone else's Google. Out of this slice; worth the same "fresh sign-in" rule later.
- `CF-Connecting-IP` is believed whenever the direct peer is a trusted (private) address. If Traefik's ports are open on the home wifi, someone there could send their own `CF-Connecting-IP`. The per-account slow-down still limits guessing; binding Traefik to 127.0.0.1 (from the review) closes it fully.
- The 20-per-hour assistant sign-up limit is kept in memory, so it resets on restart.


# Release notes: who changed what, deletes, group rules, your data

## New
- **History on every expense and payment.** Open an entry to see who added it, who changed it and when, with the old and new amount, title, date, shares and who paid. The laptop writes this on every save (the last 20 changes), so no phone can skip it.
- **Activity for each group.** A new Activity button on the group page lists recent adds, changes, removals and payments, who did them and when. Tap one to open it.
- **"This changed since you opened it."** If someone else saves an expense while you have it open, your save is stopped instead of overwriting theirs. The app tells you and shows the entry again so you can have another look.
- **Hand a group over.** The person who made a group can pass it to someone else in it from Group settings.
- **Make a new calendar link.** Shared your calendar link by mistake? Make a new one, and the old one stops working.
- **Download my data.** In your profile, under Your data and privacy: one file with your profile, your private one-on-ones, your groups and the entries you're in.
- **Delete my data.** Removes your profile, friends list, private one-on-ones and favourites, and signs you out for good. You confirm with your password. Expenses you share with others stay, so nobody's balance changes, and they show you as "Former member". Groups you made pass to someone still in them.

## Improved
- When someone removes an expense or payment you're in, you get a phone notification ("Ana removed Hydro") and a message in the app, with a link to it in Recently deleted.
- When the laptop refuses a change, the app shows the laptop's own reason (for example "Only Ana, who made this group, can rename it") instead of a general "no permission".
- Your profile says plainly who can see what. Groups are private from housemates who aren't in them, but not from whoever runs the laptop.

## Fixed
- Deleting an expense by talking to the server directly deleted it for good, skipped the bin and told nobody. Every delete of an expense or payment now goes to the bin, says who removed it, and notifies everyone in it.
- The bin always shows who really removed an entry. A phone can't put someone else's name on it.
- A reminder could be sent to any account, for any amount. Now it only goes to someone who really owes you, and never asks for more than they owe.
- Odd names like "constructor" could pass as a real person in a one-on-one split, and showed up as "Object" in notifications. People are now looked up safely everywhere.

## Security
- Only the person who made a group can rename it, delete it, hand it over, or take someone else out. Anyone can leave by themselves, and whoever added a name-only guest can take that guest out. The laptop checks this. The buttons are hidden for everyone else.
- Only the app's own kinds of data can be stored or read. Anything else is refused. One record can be up to 256 KB, and one person can keep up to 20,000 records of a kind.
- "Edited by" and the change history are set by the laptop, not the phone, so they can't be faked.
- Download my data never includes password hashes, sign-in code secrets or the calendar link. Delete my data needs your password, and wrong tries count toward the sign-in limit.

## For the README
Under "Running it from the app (owner)", or in a new "Privacy" section:

> **Who can see what.** Housemates only see the groups they're in and the expenses they're part of. Private one-on-ones with friends who aren't on the app are seen only by you. None of this is private from the person who runs the laptop: the owner's "Download everything" zip, the daily backups and the `data/` folder hold everyone's data, including private one-on-ones and groups the owner isn't in. Choose someone you trust to run it.

> **Your own data.** Anyone can download their own data (profile, then Your data and privacy, then Download my data) or delete it (Delete my data, confirmed with your password). Deleting keeps the expenses you share with others, shown as "Former member", so nobody's balance changes. The laptop's backups still hold a copy until they roll off (daily copies 30 days, weekly copies a year). The owner can still remove anyone from People, backups and health.

> **History and the bin.** Every expense and payment keeps its last 20 changes (who, when, old and new values), written by the laptop. Deleting never removes an entry for good: it goes to Recently deleted, where anyone in it can put it back, and everyone in it is told.

For developers (CONTRIBUTING or a code comment is enough):
- Every write from a phone goes through `writeOps(uid, ops)` in server.js. It is all or nothing, and the batch endpoint and the assistant should call it too, so every rule applies.
- Expenses and payments carry `v` (version) and `changes` (log), both set by the server. A client may send `v` inside `op.data` for the version it opened. If someone else changed the entry since then, the answer is HTTP 409 `{ error, code: 'stale' }`. A write without `v` is not checked.
- Known collections: `people`, `groups` (+ `members`), `expenses` (+ `comments`), `recurring`, `chores`, `data/users/{uid}/…`, and the old `house`/`members`, which only the owner can write. `MAX_DOCS_PER_PERSON` (default 20000) sets the per-person, per-collection limit; the tests set it low.

## Not done
- **Assistant writes (mcp.js) don't go through `writeOps` yet**, so an expense added or removed by an assistant gets no change log line, no version bump and no "removed" notification. mcp.js belongs to the money/MCP slice. `writeOps` is now passed to mcp.js as `h.writeOps`, so it only needs a call there.
- **Deleting a comment is still a real delete.** Comments are the commenter's own words, so they're not sent to the bin, and nobody is notified.
- **Removing an entry doesn't check its version.** If one person changes an entry and another removes it a moment later, the removal goes through. It can be put back from the bin and everyone is told, so this seemed safer than refusing it.
- **Private one-on-ones (friends not on the app) have no server-side history.** Only you can see them, so the older history the app keeps for them stays as it was.
- **Delete my data doesn't reach old backups.** Daily and weekly copies keep the data until they roll off. The app says so before you confirm.
- **Groups made before creators were recorded** (no `createdBy`) keep the old rule: anyone in them can rename them or move people out.


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
