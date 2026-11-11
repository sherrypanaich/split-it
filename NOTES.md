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


# Offline and syncing: release notes

## New
- When a change you made offline can't be saved, the app tells you which one and why, for example "Your expense ‘Pizza $24.00’ couldn’t be saved: The shares don’t add up to the total." Tap **Redo** to open the form again with what you typed.
- A **Not saved** list keeps those changes until you redo or dismiss them. It shows on Home and in the small pill at the top.
- The pill at the top says **Waiting to sync (N)** while changes are queued, and when the phone last caught up with the laptop.

## Improved
- Moving someone out, handing over their bills, "Yes, got them all", linking a guest to their account, making or editing a group, "Two people paid", pasting a list, removing a friend, adding a comment and the Splitwise import now save all at once. Either everything goes in or nothing does, so balances are never left half-updated. Offline, each of these waits as one change.
- A change that keeps failing no longer holds up everything behind it. After a few tries it is set aside, you're told, and the rest carry on. A change the laptop refuses is set aside straight away. Changes made with no connection at all just wait.
- Sending a change gives up after 20 seconds instead of hanging, and the phone retries with growing waits.

## Fixed
- Changes the laptop refused while you were offline used to disappear without a word, even though they had shown as saved.
- One stuck change could keep every later change from ever reaching the laptop.
- When the laptop came back, queued changes weren't sent until something else happened.

## Security
- Signing out now clears this phone's saved copy of your data, your waiting changes and your "not saved" list. If changes are still waiting, Sign out asks for a second tap first. "Sign out everywhere" clears this phone too.
- The phone's saved copy of your data, receipt photos included, now belongs to one person. When someone else signs in on the same phone, the last person's copy is deleted, so they never see it, even offline. Changes or "not saved" items another person left behind are never shown or sent as the new person.

## For the README
In the offline section ("Once a phone has opened Split it…"), add:

> If the laptop refuses a change you made offline (say the shares don't add up, or someone changed that expense in the meantime), the app tells you which change it was and offers **Redo**. Changes that keep failing are set aside after a few tries, so the rest still get through. Set-aside changes stay in a **Not saved** list (on Home and in the pill at the top) until you redo or dismiss them. Signing out clears this phone's saved copy of your data. Each person's copy is kept apart, so on a shared phone nobody sees the last person's numbers.

For developers (CONTRIBUTING or the API notes):

> `POST /api/batch` with `{ ops: [...], label? }` applies up to 100 writes all together or not at all. It runs the same checks as `/api/write`, and both go through `writeOps(uid, ops)` in server.js, followed by one save and one live update. In the page, use `writeAll(b => { b.set(ref, data); b.update(ref, data); b.delete(ref); }, label)`. In the Claude artifact, where there is no batch, the writes are sent one after another.

## Not done
- `/api/batch` checks every change against the data as it is before the batch, just like `/api/write`. A batch can't update a document that an earlier part of the same batch creates, and it can't add people to a group the same batch creates. So making a new group saves the group first and then everyone in it as one batch. Checking each part against the result of the earlier parts would mean changing `writeOps`, which the version-number work also changes, so I left it.
- Batches larger than 100 changes (a big Splitwise import, or linking a guest with a long history) go in parts of 100, in order. Each part is all or nothing. Running it again finishes the job: the import skips rows already in, and linking moves only what still points at the guest.
- The old house-to-group upgrade (`migrate`) and the artifact-only bill posting still send one change at a time. Both run rarely, and the second never runs on the laptop.


# Hardening and release checks (wip-hardening)

## New
- Release check for Docker: `scripts/smoke-docker.sh` builds the image, starts it on a fresh volume, adds a person, signs in, saves something, restarts the container and checks everything is still there. The release workflow runs it before publishing (when the runner has Docker).

## Improved
- Receipt reading no longer needs an outside website. The reader (about 11 MB) now comes from your own Split it, so it works on a home network with no internet, and the first read is quicker on the same wifi.
- Images are a little smaller.

## Fixed
- Nothing new; the new checks found no problems to fix.

## Security
- The receipt reader (Tesseract.js 5.1.1, its engine and the English data) is shipped inside the app instead of loaded from jsdelivr. The page no longer allows scripts or downloads from jsdelivr or tessdata.projectnaptha.com, so a change on someone else's server can't run inside Split it.
- New automated check that text people type (names, titles, notes, items, comments, payment notes, chores, bills, nicknames, e-Transfer details, sign-in names) is never run as code on the page. It found no holes.
- New automated check that sign-in works behind Cloudflare and Traefik.
- Removed hidden "made with" tags (C2PA manifests) from every image. The pictures themselves are unchanged, byte for byte.

## For the README
- Receipts paragraph: replace "(Tesseract, downloaded once, about 10 MB)" with "(Tesseract, which comes with Split it, about 11 MB the first time a phone uses it; nothing is downloaded from anywhere else)".
- Release checklist (CONTRIBUTING or the release section): "Before tagging, run `scripts/smoke-docker.sh` on a machine with Docker. The release workflow also runs it."
- New art: "Run `node scripts/strip-image-metadata.mjs` before committing images; the tests fail if an image carries metadata."

## Developer notes
- Vendor files: `public/vendor/tesseract/` holds `tesseract.min.js`, `worker.min.js` (npm tesseract.js@5.1.1), `tesseract-core-simd-lstm.wasm.js` and `tesseract-core-lstm.wasm.js` (npm tesseract.js-core@5.1.1, SIMD build plus a plain build for older phones), `eng.traineddata.gz` (npm @tesseract.js-data/eng@1.0.0, `4.0.0_best_int`), licences and `VERSIONS.txt` with sha256 hashes. Total about 11 MB (2.9 MB data, 3.9 MB per engine build, the rest small). The page loaded exactly these versions from the CDN before.
- Language data: I kept `4.0.0_best_int` (2.9 MB compressed), the model the page already used. The "fast" model lives only on GitHub (tesseract-ocr/tessdata_fast), which was not reachable from here; it would save about 1 MB and read a little worse, so it isn't worth a change in quality.
- Served by `server.js` at `/vendor/tesseract/*` after sign-in only, with ETag and `no-cache` (cheap 304s; a future version upgrade shows up right away). Files over 1 MB are gzipped once and the result kept in the file cache (`file()`); `out()` now skips gzip when a body is already encoded.
- Service worker: nothing new is precached. `/vendor/tesseract/` was added to the stale-while-revalidate line, so a phone keeps a copy after the first read. Tesseract also keeps the language data in IndexedDB on its own.
- Page: on the laptop the worker is started from the same origin (`workerBlobURL: false`) with absolute paths. In the published artifact (no `/shim.js`, so `LAPTOP` is false) there is no vendor folder, so the page still loads tesseract.js 5.1.1 and core 5.1.1 from jsdelivr, now with an SRI hash on the script tag (`sha384-GJqSu7…`, computed from the npm file; jsdelivr was not reachable from here to double-check, but it serves npm files unchanged). There the AI reader is used first anyway when the artifact allows images.
- Checked in headless Chromium: signed in, picked a generated receipt image through the real file input; the reader loaded only from the app (no outside requests, no CSP errors) and filled in title "CORNER GROCER", 8.76, the date, the items and the tax.
- `test/proxy.test.js`: sign-in through Cloudflare/Traefik headers (cookie marked Secure), per-visitor lockout when the proxy passes the visitor in X-Forwarded-For, the vendor files (signed-in only, gzipped, no path tricks) and the CSP (no outside script hosts; connect-src only frankfurter).
- The test "five wrong passwords through the proxy only lock out the visitor who made them (Cloudflare address)" is marked `todo`: on this branch every request behind Traefik counts as 10.0.2.6, so it fails as expected. Remove the `todo` once the sign-in slice's client-address change is merged. It runs last in the file because, without that fix, it locks the shared proxy address.
- `test/xss.test.js` needs Playwright and its Chromium. It skips (doesn't fail) when either is missing, which is the case on GitHub's runners (no npm dependencies are installed there). It also fails if any field was never seen on screen, so it can't pass by not looking; I checked it fails when one `esc()` is removed.
- `test/images.test.js` plus `scripts/strip-image-metadata.mjs`: drops only non-drawing chunks (PNG caBX/tEXt/iTXt/zTXt/eXIf/tIME, WebP C2PA/EXIF/XMP, SVG `<metadata>`); pixel hashes were compared before and after with PIL and are identical.

## Not done
- No escaping holes were found, so no page fixes were needed.
- The "fast" English model was not used (see above).
- The artifact version still loads the reader from jsdelivr (now hash-checked); there is no way to ship files with the artifact.
- `blob:` is still allowed in script-src/worker-src; the laptop no longer needs it for the reader, but I left it in case other parts of the page rely on it.


# Release notes: money (amounts, currency, rates, bills, assistant)

## New
- **Home currency.** Set `HOME_CURRENCY` (for example `USD` or `EUR`) and the whole app uses it: amounts on the page, notifications, the calendar and the AI assistant. It stays CAD unless you change it. The owner's page shows which one is set.
- **Card fee on trips.** A trip group (one that pays in another currency) has a "Card fee %" box in its settings, 2.5 unless you change it, 0 for cash. It's added when a foreign amount is turned into your home currency, and the expense says so: "includes 2.5% card fee". You can change it on any single expense too.
- **Who takes over a bill.** If someone leaves a group while they're still in a bill (or pay it), the bill pauses instead of charging them. Everyone else gets a notification, and the group page shows "Dee left, so Rent is paused. Who takes over?" with a button for each person, or "Split it between the rest". Anything that came due while it was paused is added once someone picks.

## Improved
- Exchange rates come from the laptop, once a day for the whole house, instead of each phone asking on its own. The expense shows which day the rate is from, and says so plainly when the rate service isn't answering and an older rate is being used.
- The rate an expense was converted at is still saved on it, now with the card fee and the rate's day.
- Moving someone out takes them off the bills first, then out of the group.
- The AI assistant gives back the numbers (your share, the total, the currency) as data next to its sentence, so Budget it no longer has to read them out of "Your share: $30.00." The sentence is still there.
- In a trip group the assistant asks which currency an amount is in, converts it with the same rates and card fee as the app, and refuses (saying why) when there's no rate. It never saves euros as dollars.
- The assistant splits the odd cent the same way the app does, so editing an expense it added never moves a cent.

## Fixed
- Amount boxes no longer guess. "1.234,56" used to become $1.23 and "10-15" became $1015. Now anything that isn't a plain amount (like 12, 12.5, $12, 1,234.56 or 12,50) gets a short note under the box and can't be saved. Quick add leaves an unclear amount empty and says why.
- An AI assistant that tries again after a slow answer no longer adds the same expense or payment twice. The same title, amount, date and group from the same assistant within 2 minutes gets "Already added" with the first one's id.
- A bill kept charging someone who had left if the move-out helper wasn't used (or their account was removed on the laptop).

## Security
- Spreadsheet export: a cell that starts with =, +, -, @ (or a tab or return) gets a ' in front, so a title can't run as a formula when the file is opened. Plain numbers like -12.50 stay numbers.
- Expenses and payments added by an AI assistant go through the same server checks as the app (who can write where, shares add up, whole cents, only the person paid confirms).
- Titles, notes, group and bill names written by housemates are sent to the assistant in quotes, escaped so they can't start a line of their own, and every tool says this text is data, not instructions. Every tool that changes something says to confirm with the user first (Undo my last entry now does too).

## For the README
Settings (`split-it.env`):

```
# The currency balances, bills and notifications are kept in (a 3-letter code: CAD, USD, EUR, GBP...).
# Set it once, before you add expenses; changing it later doesn't convert anything already saved.
HOME_CURRENCY=CAD

# Exchange rates for trip groups come from frankfurter.app (European Central Bank rates, free, no key),
# once a day, into data/rates.json. Write off to stop that; people then type the rate themselves.
RATES_URL=
```

Trips: "In group settings, pick the currency you mostly pay in. New expenses there start in it and are turned into your home currency at the day's rate plus the card fee (2.5% unless you change it; 0 for cash). Each expense keeps the rate, fee and day it used."

Moving out: "Move someone out from their page in the group. If they're still in a bill when they leave (for example someone was taken off the laptop), that bill pauses and the group page asks who takes over."

For Budget it / other apps using the connector: `add_expense` returns `structuredContent` `{ id, title, date, group, total, totalCents, yourShare, yourShareCents, currency, paidByYou, duplicate, original }` (amounts in currency units and in cents; `currency` is always the home currency; `original` is the foreign amount, rate and card fee, or null). `record_payment` returns `{ id, amount, amountCents, currency, to, date, group, waitingToConfirm, duplicate }`, and `get_balances` returns `{ currency, net, netCents, people: [{ name, owesYou, owesYouCents }] }`. Read `yourShare` from there instead of the sentence.

Also worth saying: "Built for Canada first: e-Transfer and hydro wording, and HST 13% on the receipt splitter, stay as they are."

## Not done
- Wording stays Canadian ("e-Transfer", "hydro", the HST 13% chip, en-CA dates). The task said that's fine; only the currency follows the setting.
- Changing `HOME_CURRENCY` on an install that already has expenses doesn't convert them; it's meant to be set once at the start. Old expenses keep their numbers.
- Bills stay in the home currency (as before); only one-off expenses can be in a trip currency. Payments are also home currency only, and the assistant refuses a payment in another currency rather than converting it.
- The page shows the rate to 4 decimals (as before) while the assistant uses the server's 6-figure rate, so the same euro amount can differ by a cent between them. Each expense stores the rate it used, so balances are always consistent.
- CSV: plain numbers that start with "-" (money in) are left as numbers rather than given a ', so spreadsheets can still add them up. Anything else starting with -, like "-2+3", gets the '.
- When someone leaves, the takeover choice replaces the person in the bill's split (or gives two shares to someone already in it), or splits it between the rest. There's no free-form re-split from the banner; Edit on the bill still does that.
- The assistant's server checks: entryProblem only covers shared entries (expenses/...). Private one-on-ones with friends not on the app get a smaller check (whole cents, shares add up), the same as before for the app.
- No test drives the notification itself (tests have no phones subscribed); the pause and the banner data are tested.

## Expected merge conflicts
- `server.js`: `removeUser()` (one added loop), `/api/write` (one added line after `broadcast`), the admin overview `health` object (three added fields), `staticFile()` (index.html home-currency tag), the mcp `require(...)` helpers list, and the startup timers.
- `mcp.js`: the tools section and `rpc()`/`mcp()` (now async, with a `caller`). Nothing in the OAuth/keys part changed except a new `callerOf()` helper next to `whoIs()`.
- `public/index.html`: `toCents` line and new `plainCents/amtBad/amtMsg` lines near the top, the expense sheet (rate/fee rows, `cadAmt`, `origOf`), `openMember()` move-out button, `viewGroup()` (one line for the takeover banner), `bind()` (one line), the expense detail "Paid … at 1 EUR = …" line, the admin health note, `exportCsv()`.
- `test/server.test.js`: one assertion (recent_expenses titles are now quoted).
