# Split it

**Split bills with housemates, on a laptop you already own.** A free, open source [Budget It](https://sherrypanaich.github.io/split-it/) project.

Split it tracks who paid for what in a shared home: rent, hydro, groceries, the Netflix nobody admits to using. Housemates sign in from their phones, anywhere. Everything is stored on your own machine, with no ads and no tracking.

- Website: https://sherrypanaich.github.io/split-it/
- Support it: https://github.com/sponsors/sherrypanaich (running Split it and Budget it together costs $70 a month; Budget it's bank linking costs extra on top of that)
- Licence: MIT (see `LICENSE`). Character art is not covered by the licence, see "Character art" below.

What's in this repo:

- `server.js` runs the app. No npm packages to install, just Node.js 22 or newer.
- `public/` is the app page and sign-in pages.
- `data/` is created on first run and never committed. It holds everything: `db.json` (groups and expenses), `users.json` (sign-ins), `photos/` (receipt photos), `push.json` and `push-keys.json` (phone notifications), and `backups/` (a copy of the records at every start and every 6 hours, one a day for 30 days, and one every Sunday for a year).
- `test/` checks the split rules and the whole server (who can see what, the money rules, sign-in, backups). `node --test test/*.test.js` runs it. `scripts/smoke-docker.sh` checks the Docker image before a release.
- `Dockerfile` and `compose.yaml` if you'd rather run it in a container (`docker compose up -d`, then `docker compose exec split-it node server.js add-user YOU`). Inside the container the app runs as an ordinary user, not root.
- `docs/` is the website, served by GitHub Pages.

## Quick install

On a Linux machine (Ubuntu, Mint, Debian and similar):

```
git clone https://github.com/sherrypanaich/split-it
cd split-it
bash install.sh
```

It does steps 1, 2 and 5 below for you (installs Node.js if needed, copies the app to `~/split-it`, and starts it on boot). Then do step 3 to add people, and step 6 for access from phones. Running it again later (after `git pull`) updates the app and keeps your data and settings.

**Coming from v2.1 or older?** The app used to live in `~/house-split` with a service called `house-split`. Run `bash install.sh` from the new download and it moves the folder to `~/split-it` (data and settings included) and swaps the service for `split-it`. Nothing else to do.

## 1. Install Node.js (once)

Open a terminal and check the version:

```
node -v
```

You need version 22 or newer (older ones no longer get security fixes). If it's missing or older:

```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

(That's for Ubuntu, Mint, Debian and similar. On other systems, install Node.js 22 or newer with your package manager.)

## 2. Put the app in your home folder

Copy this whole folder to `~/split-it` on the laptop, so you end up with `~/split-it/server.js`.

## 3. Add yourself, then invite everyone else

```
cd ~/split-it
node server.js add-user Sam
```

It asks for a password (8 characters or more). The first person added is the owner.

To bring in friends, open the app, go to **Friends**, tap **Add friend**, then **Make an invite link**. Send them the link. They pick their own name and password, and you're friends right away. Each link works once and lasts 7 days. Anyone signed in can make invite links. You can still add people by hand with `node server.js add-user NAME`.

**Someone you've been tracking by name?** Open their page (a contact in Friends, or a name-only member of a group) and tap **Invite … to Split it** or **Hand over …'s history**. Their invite link carries that history: once they've joined, they see what's waiting and tap **Yes, that's me**. Already on Split it? Send it to them instead, and they get the same choice. Nothing moves until they say yes. Every balance stays exactly the same, and either of you can undo it for 7 days. Anyone in a group can hand over that group's name-only member, and the group is told.

**Finding people already on Split it.** Everyone has a unique tag, like `@sam`, in their profile under Signing in. In **Add friend**, type someone's tag (or the email they checked on their account) and they get a friend request to accept. Your profile also has a friend link with a QR code: anyone who opens it becomes your friend right away. Split it doesn't use phone numbers, because there's no free way to check that a number is really yours. With more than 15 people on one Split it, Add friend stops listing everyone and you search by tag instead.
Forgot a password? `node server.js set-password Alex`. See everyone: `node server.js list-users`. Someone moved out? `node server.js remove-user Alex` signs them out everywhere and turns off their notifications; their past expenses stay. `node server.js code-off Alex` turns off their sign-in code if they lost their phone. These all work while the app is running and take effect right away, no restart needed.

## 4. Try it

```
node server.js
```

Open http://localhost:8080 on the laptop and sign in. Press Ctrl+C to stop it.

## 5. Start it automatically when the laptop turns on

```
mkdir -p ~/.config/systemd/user
cp ~/split-it/split-it.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now split-it
sudo loginctl enable-linger $USER
```

The last line keeps it running even when nobody is logged in on the laptop.
Check on it with `systemctl --user status split-it`, and restart it with `systemctl --user restart split-it` after changing `split-it.env`.

## 6. Reach it from anywhere (free)

This uses Tailscale Funnel, which gives the app a private https web address without opening anything on your router.

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale funnel --bg 8080
```

`tailscale up` shows a link to sign in to a free Tailscale account. The last command prints your address, something like `https://old-laptop.tail1234.ts.net`. Send that to housemates. They just open it in their phone browser and sign in. On iPhone, Share then "Add to Home Screen" makes it feel like an app.

If Funnel asks you to turn it on for your account, follow the link it prints, then run the command again.

## 7. Keep the laptop awake

In the laptop's power settings, set it to never sleep when plugged in. To keep it running with the lid closed:

```
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
```

## Settings

Settings go in a file called `split-it.env` next to `server.js` (copy `split-it.env.example`, which explains each one). Restart after a change: `systemctl --user restart split-it`. In Docker, use the `environment:` list in `compose.yaml` or your host's settings (Coolify: Environment variables). Leave a line empty to keep that feature off.

| Setting | What it does |
|---|---|
| `PUBLIC_URL` | The address people open, like `https://laptop.tail1234.ts.net`. Needed for emails, Google and assistants. |
| `RESEND_API_KEY`, `MAIL_FROM` | Emails: checking your email, "Forgot password?" and sign-in links. See "Sign-in options" below. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Continue with Google". |
| `BACKUP_COPY_DIR` | A second place for backups, off the laptop's disk. See "Backups". |
| `BACKUP_PASSPHRASE` | Locks the copies off the laptop. See "Backups". |
| `TZ` | The house's time zone, like `America/Toronto`. See "Time zone". |
| `REMIND_HOUR` | The hour (0 to 23, in `TZ`) after which bill reminders go out. 9 unless you change it. |
| `HOME_CURRENCY` | The currency balances, bills and notifications are kept in: `CAD`, `USD`, `EUR`, `GBP`… CAD unless you change it. Set it once, before you add expenses; changing it later doesn't convert anything already saved. |
| `RATES_URL` | Exchange rates for trip groups come from frankfurter.app (European Central Bank rates, free, no key) once a day, into `data/rates.json`. Write `off` to stop that; people then type the rate themselves. |
| `TRUSTED_PROXY` | Addresses or ranges of your proxies, comma separated (like `10.0.2.6,172.18.0.0/16`). Empty: this computer and private network addresses. `none`: never believe forwarded headers. See "Running behind a proxy". |
| `UPDATE_CHECK` | Write `off` to stop the owner's page asking GitHub whether a newer Split it is out. |

Split it is built for Canada first: e-Transfer and hydro wording, and HST 13% on the receipt splitter, stay as they are whatever `HOME_CURRENCY` says.

## Time zone

Containers run on UTC unless told otherwise, so a 9 am reminder arrives at 4 am in Toronto and "today" changes at 7 pm. Set `TZ` to the house's time zone, for example `TZ=America/Toronto` (names are listed at https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). Put it in `split-it.env`, or in the `environment:` list in `compose.yaml` (it defaults to `America/Toronto` there), or in your host's settings. `REMIND_HOUR` is counted in that time zone. The owner's page shows the zone the server uses and warns when it's UTC.

## Running behind a proxy

If Split it runs behind Docker, Traefik, Coolify, Caddy, nginx or a Cloudflare tunnel, every request reaches it from the proxy's address. Split it then reads the visitor's real address from the proxy's headers (`CF-Connecting-IP` from Cloudflare, otherwise the right-most outside address in `X-Forwarded-For`), and uses it for the wrong-password limits, so one person's typos don't lock out the whole house.

It believes those headers only when the request comes from this computer or a private network address (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, loopback). If your proxy has a fixed address, set `TRUSTED_PROXY` to it so nothing else is believed. Make sure the app's own port can't be reached from outside without the proxy (for example bind it, or the proxy's ports, to 127.0.0.1 when a tunnel is the only way in), since anyone who can reach a trusted address directly can claim any visitor address.

Set `PUBLIC_URL` to the address people open. Changes sent from a browser are accepted only from that address or from the address the request was sent to.

## Sign-in options: email and Google (optional)

Everyone can always sign in with their name (or checked email) and password. Two extras need a little setup, both free for a group of friends. Put the settings in `split-it.env` (see "Settings" above), then restart: `systemctl --user restart split-it`.

Split it stays private either way: nobody can make an account without an invite link from someone already in. Google and email only sign in people who already have an account.

**Your address.** Set `PUBLIC_URL` to the address you open on your phone (your Tailscale Funnel address from step 6, like `https://laptop.tail1234.ts.net`). Email links and Google use it. Emails stay off until it is set.

**Emails (Resend).** This turns on: adding an email to your account, "Forgot password?", and "Email me a sign-in link".
1. Make a free account at resend.com and create an API key. Put it in `RESEND_API_KEY`.
2. Resend only sends to other people once you add a domain you own (Domains, then follow the steps). Then set `MAIL_FROM`, like `Split it <hello@yourdomain.com>`. Without a domain, it can only email the address you signed up to Resend with, which is fine for trying it.
3. Each person opens their profile, then **Signing in**, adds their email and taps the link it sends.

**Google.** This adds "Continue with Google".
1. Go to console.cloud.google.com, make a project, then APIs & Services, then OAuth consent screen. Pick External, fill in the app name (Split it) and your email. Add your friends' Gmail addresses as test users, or publish the app.
2. Credentials, then Create credentials, then OAuth client ID, type Web application. Under Authorised redirect URIs add your `PUBLIC_URL` followed by `/auth/google/callback`.
3. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. People connect Google from their profile, or join with Google from an invite link. If someone's checked email matches their Google email, it connects by itself the first time.

In your profile you can also change your password and email, and sign out on all devices. Changing your email asks for your current password (or a sign-in code). You stay signed in while you use Split it: each day you open it, your sign-in runs another 90 days.

## Sign-in code (optional, recommended for the owner)

A second step after your password: a 6-digit code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Aegis, any of them). Someone who learns your password still can't get in without your phone.

Turn it on in your profile under **Signing in**, then **Sign-in code**. The app gives you a key to add to your authenticator app and asks for one code to prove it works. It then shows 8 backup codes, each good once, for the day your phone is lost. Keep them somewhere safe.

- An AI assistant connecting to your account is asked for the code too.
- A password reset link changes the password but doesn't skip the code.
- Lost the phone and the backup codes? The owner can turn the code off for you from **People, backups and health**, or on the laptop: `node server.js code-off NAME`.

Wrong passwords and codes are limited: 5 misses from one visitor mean a 15 minute wait for that visitor. After 10 misses for one account from anywhere, each try on that account waits a few seconds, so guessing stays slow but nobody can lock a housemate out by typing their name.

## Running it from the app (owner)

Tap your picture, then **People, backups and health**. That page shows whether the laptop is healthy (disk, last backup, bills), everyone who's signed up (last seen, notifications on), and lets you:

- make a **reset link** for someone who's locked out (no email needed; send it to them yourself),
- rename, sign out everywhere, make an owner, or remove someone,
- turn off someone's sign-in code if they lost their phone,
- **download a full backup** as one zip (records, people and their password checks, photos), locked with a passphrase if you like, and **restore** one later,
- see when the last copy went to your second backup place, and make one now,
- send a test notification to everyone.

It also tells you when a newer Split it is out. For that it asks GitHub for the latest release when you open the page (at most twice a day) and sends nothing about your house. `UPDATE_CHECK=off` in `split-it.env` stops it. It shows the server's time zone too, and warns when the disk is 90% full.

If the laptop's disk fills up, Split it keeps running and showing everything. New changes are refused with a message until there is room again, and the owner sees a banner.

## Who can see what

**Housemates** only see the groups they're in and the expenses they're part of. Private one-on-ones with friends who aren't on the app are seen only by you. Your profile says this too.

**The person who runs the laptop** can see everything. The owner's "Download everything" zip, the backups and the `data/` folder hold everyone's data, including private one-on-ones and groups the owner isn't in. Choose someone you trust to run it.

**Your own data.** Anyone can download their own data (profile, then **Your data and privacy**, then **Download my data**) or delete it (**Delete my data**, confirmed with your password). Deleting keeps the expenses you share with others, shown as "Former member", so nobody's balance changes, and groups you made pass to someone still in them. The laptop's backups still hold a copy until they roll off (daily copies 30 days, weekly copies a year). The owner can still remove anyone from **People, backups and health**.

**History and the bin.** Every expense and payment keeps its last 20 changes (who, when, old and new values), written by the laptop, and each group has an **Activity** list. Deleting never removes an entry for good: it goes to **Recently deleted**, where anyone in it can put it back, and everyone in it is told. If someone else saves an expense while you have it open, your save is stopped so you can have another look instead of overwriting theirs.

**Groups.** Only the person who made a group can rename it, delete it, hand it over (Group settings) or take someone else out. Anyone can leave by themselves.

## Backups

On the laptop, `data/backups/` keeps a copy of the records at every start and every 6 hours (12 kept), one per day (30 kept) and one per Sunday (52 kept). `node server.js backup my-backup.zip` writes a full zip from the terminal. Backups never hold sign-ins, so a backup can't be used to sign in as anyone. They do hold everyone's password checks and records, so keep them somewhere only you can read.

**A copy that survives the laptop.** Those copies sit on the same disk as the app, so a dead disk takes them too. Set `BACKUP_COPY_DIR` to a folder that isn't on the laptop's disk: a USB drive, or a folder that Syncthing, Dropbox or Nextcloud sends somewhere else. In Docker, mount that folder into the container (see the lines marked `copy` in `compose.yaml`). The records (`db.json`, people and their password checks, assistant connections) go there every 6 hours as `split-it-backup-YYYY-MM-DD.zip`: one file per day, refreshed during the day, with 14 days kept. Each receipt photo is copied into `photos/` in that folder once. The owner's page warns you when no second place is set, when a copy fails (drive unplugged), and when the newest copy is more than 3 days old.

**Lock it with a passphrase.** Set `BACKUP_PASSPHRASE` to a long phrase only you know, and the copies off the laptop are locked: `split-it-backup-YYYY-MM-DD.locked`, and `photos/*.jpg.locked`. Keep the passphrase somewhere that isn't the laptop, such as a password manager. Without it nobody can open these copies, you included. With the passphrase set, the owner's page also offers a locked download.

**Restoring**
- From the laptop (best for big backups, and works while the app runs): `node server.js restore FILE`. In Docker: `docker compose exec split-it node server.js restore /backup-copy/split-it-backup-2026-11-11.locked` (the file has to be inside the container, for example in the mounted backup folder). It accepts a `.zip`, a `.locked` file or a daily `db-….json`. For a locked file it uses `BACKUP_PASSPHRASE`, or asks for the passphrase if that isn't set. To type a different one: `BACKUP_PASSPHRASE= node server.js restore FILE`. Photos are brought back from the `photos/` folder next to the file.
- From the app: tap your picture, then **People, backups and health**, then **Restore a backup**. It takes a zip, a locked file (it asks for the passphrase) or any of the daily files. Cloudflare's free plan stops uploads over 100 MB, so use the laptop command for anything bigger.
- A restore checks the whole file first and refuses one that isn't Split it data. What was there before is kept in `data/backups/before-restore-…`, so a restore can be undone.
- A restore keeps the sign-ins and phone notification settings the laptop has now. After a move to a new laptop, everyone signs in again and turns phone notifications back on.
- Do one test restore into a spare copy of the app before you need a real one.

## Away from wifi

Once a phone has opened Split it, it opens without a connection too: it shows what it last had, and anything added while offline waits in a queue and is sent when the laptop is reachable again. A small pill at the top says when that's happening ("Waiting to sync (N)") and when the phone last caught up.

If the laptop refuses a change you made offline (say the shares don't add up, or someone changed that expense in the meantime), the app tells you which change it was and offers **Redo**. Changes that keep failing are set aside after a few tries, so the rest still get through. Set-aside changes stay in a **Not saved** list (on Home and in the pill at the top) until you redo or dismiss them. Signing out clears this phone's saved copy of your data. Each person's copy is kept apart, so on a shared phone nobody sees the last person's numbers.

## On your phone

Open your Split it address on the phone and sign in, then:

- **iPhone:** tap Share, then "Add to Home Screen".
- **Android (Chrome):** tap the "Add" button on the Home screen card, or the browser menu, then "Install app".

It then opens like a normal app.

## Phone notifications

Each person turns them on for their own phone: tap your picture at the top of Home, then "Turn on" under Phone notifications. On iPhone this only works from the home screen app (iOS 16.4 or newer).

You get a notification for:

- bills due today or tomorrow (sent once a day after 9am laptop time),
- new expenses someone else adds that include you, changes to their amount or split, and someone removing one,
- a budget reaching 80% or being used up,
- payments someone says they sent you, so you can confirm,
- comments on expenses you're in,
- "Remind" from a housemate you owe,
- chores on the day it's your turn,
- a summary on the 1st of each month (your share last month and where you stand),
- a friendly nudge on the 1st and 15th if you owe someone $5 or more. Each person can stop these nudges going to people who owe them, under "Remind people who owe me" in their profile.

Notifications need the https address from step 6. They don't work on plain http://localhost, except on the laptop itself.
Nothing to set up on the laptop: the app makes its own notification keys in `data/push-keys.json` on first run.
To send bill reminders at a different hour, set `REMIND_HOUR=8` in `split-it.env` and restart. The hour follows `TZ` (see "Time zone").

## Quick add

Type an expense like a text on the Home screen, for example "groceries 54.20", "pizza with Aman 30 yesterday", "Aman owes me 20 for uber", "hydro 120 except Priya" or "netflix 16.99 monthly". It's read on the phone itself, with no AI and no cost, and fills in the form for you to check before saving.

You can also **say it**: the microphone button uses the phone's own speech recognition. And **Paste a list** turns several lines into several expenses at once.

**Receipts:** the camera button reads the receipt on the phone itself (Tesseract, which comes with Split it, about 11 MB the first time a phone uses it; nothing is downloaded from anywhere else), no AI and no account. It finds the store, total, date and items for you to check.

## Other handy bits

- **Favourites:** open any expense and tap the star. It shows up on Home for one-tap adding, with the same split.
- **Last time it cost:** when you type a title you've used before, the form shows what it cost last time and flags big jumps.
- **Whose turn to pay:** each group page shows who's furthest behind, so they can pay for the next thing.
- **Chores:** add them on a group page. They rotate between the people you pick, weekly, every 2 weeks or monthly.
- **Light or dark:** pick it in your profile. It's remembered on each phone.
- **Trips:** in group settings, pick the currency you mostly pay in. New expenses there start in it and are turned into your home currency at the day's rate plus the card fee (2.5% unless you change it; 0 for cash). Each expense keeps the rate, fee and day it used.
- **Moving out:** move someone out from their page in the group. If they're still in a bill when they leave (for example someone was taken off the laptop), that bill pauses and the group page asks who takes over.
- **Bills:** monthly, weekly or yearly. The **Calendar** link on a group page shows what's coming and gives you a file or a private link for your phone's calendar. Shared the link by mistake? Make a new one and the old one stops working.
- **Budgets:** in group settings, optional monthly caps per category. Everyone gets a quiet nudge at 80% and when it's used up.
- **Default split:** in group settings, give each person a weight (rooms, couples) and new expenses start that way.
- **Wanted poster:** the group page puts a bounty on whoever owes the most. Tap it to share the picture.
- **Summary:** from Stats or group settings, a trip or month summary to copy or share as a picture.
- **Import from Splitwise:** group settings, then pick the CSV that Splitwise exports.
- **Keyboard:** N adds an expense, / jumps to search or quick add.

## Receipt photos

When adding an expense, tap "Add a photo" to keep a picture of the receipt with it. Photos are shrunk on the phone and saved in `data/photos/` on the laptop, so they're included when you back up `data/`. Anyone signed in to your Split it can open them.

## Use it from Muse (or another AI assistant)

Split it has a connector (`mcp.js`) so Meta's Muse, Claude or ChatGPT can check balances and add expenses for you by chat. It needs the https address from step 6. It costs nothing on the laptop: the assistant does the thinking, the laptop just answers.

**The easy way:** everyone opens their profile in Split it and scrolls to **AI assistants**. It shows their own connector link, steps for Claude, every assistant connected as them, and buttons to make a key or disconnect one. Nobody needs the laptop for this.

**Connect Claude:** in Claude, open Settings, then Connectors, tap **Add custom connector**, name it Split it and paste `https://YOUR-ADDRESS/mcp`. Tap Connect, sign in with your Split it name and password (or with Google), and tap Allow. If you're already signed in to Split it in that browser, just tap Allow. The page shows the address your key is going to in large type, so check it's your own Split it. Then turn it on in a chat's tools menu.

**Connect Muse:** start a chat in Muse and send:

> Add a custom connector called Split it. It's a remote MCP server (streamable HTTP) at https://YOUR-ADDRESS/mcp and it signs in with OAuth.

Use your real address, for example `https://old-laptop.tail1234.ts.net/mcp`. Muse sends you a sign-in link. Open it and sign in with your Split it name and password. Muse then acts as you. Each housemate connects their own Muse the same way.

Then just ask: "what do I owe?", "who owes me in House?", "show my last 5 expenses", "add groceries 54.20 to House", "add pizza 30 with Alex", "I paid Alex 20", or "undo that" within 10 minutes. It asks you to check before adding anything. It can also split by shares ("hydro 120, Alex pays double") or exact amounts, tell you who should pay whom to settle a group, list the bills coming up, and sum up a month. One-on-one expenses also work with friends who aren't on the app, and stay private to you. In a trip group it asks which currency an amount is in. If you turned on a sign-in code, the sign-in page asks for it too. Things it adds show up in the app straight away, and housemates get the usual notifications.

**If Muse asks for an API key or token instead of a sign-in:** tap **Make a key** under AI assistants in your profile. Or, on the laptop, run

```
cd ~/split-it
node server.js mcp-key Sam
```

and give Muse the key it prints (it's a "Bearer" token). If there's only a box for the link, use `https://YOUR-ADDRESS/mcp?key=THE-KEY`. Keep the key private: anyone with it can act as you.

**Disconnect:** tap Disconnect next to it under AI assistants in your profile. On the laptop, `node server.js mcp-revoke Sam` signs out every assistant and key for that person. You can also remove the connector in Muse. Keys and assistant connections that nobody uses for 90 days stop working; make a new one in your profile if that happens.

**For Budget it and other apps using the connector:** `add_expense` returns `structuredContent` `{ id, title, date, group, total, totalCents, yourShare, yourShareCents, currency, paidByYou, duplicate, original }` (amounts in currency units and in cents; `currency` is always the home currency; `original` is the foreign amount, rate and card fee, or null). `record_payment` returns `{ id, amount, amountCents, currency, to, date, group, waitingToConfirm, duplicate }`, and `get_balances` returns `{ currency, net, netCents, people: [{ name, owesYou, owesYouCents }] }`. Read `yourShare` from there instead of the sentence.

If the sign-in link points at the wrong address, set `PUBLIC_URL=https://YOUR-ADDRESS` in `split-it.env` and restart the app.

## Character art

The guide characters in `public/art/` and `docs/images/` are not covered by the MIT licence and may not be reused. If you own something shown here and want it removed, [open an issue](https://github.com/sherrypanaich/split-it/issues/new) and we'll take it down.

Adding art? Run `node scripts/strip-image-metadata.mjs` before committing images; the tests fail if an image carries metadata.

## Made with AI

AI tools were used to help build this project, including its code and artwork.
