# What's new in Split it

## v2.2.0 · Draft, not released yet

**Safe to host, and easier to live with.** The server now checks the money on every save, every change leaves a trail, nothing you do offline is lost without a word, sign-in gets a second step, and backups leave the laptop locked.

### Highlights
- **History on every expense.** Open an expense or payment to see who added it, who changed it and when, with the old and new values. The laptop writes it, so no phone can skip it. Each group also gets an Activity list.
- **Deletes always go to the bin, and people are told.** Removing an expense or payment sends it to Recently deleted, says who removed it, and notifies everyone in it. Anyone in it can put it back.
- **Offline changes are never lost silently.** If the laptop refuses something you did offline, the app tells you which change and why, and keeps it in a Not saved list with a Redo button.
- **No more shared lockout behind a proxy.** Behind Docker, Traefik, Coolify or Cloudflare, one person's wrong passwords no longer lock out the whole house.
- **Locked backups that survive the laptop.** Point Split it at a USB drive or a synced folder and the records go there every 6 hours. Set a passphrase and only it can open them.
- **The server checks the numbers.** Shares have to add up to the total, and only the person who was paid can say a payment arrived. Until now the page checked this and the server trusted it.
- **Sign-in code.** Add a 6-digit code from an authenticator app as a second step after your password, with backup codes for a lost phone.

### New
- History on every expense and payment: the last 20 changes, with who, when, and the old and new amount, title, date, shares and who paid.
- Activity for each group: a new Activity button on the group page lists recent adds, changes, removals and payments. Tap one to open it.
- "This changed since you opened it": if someone else saves an expense while you have it open, your save is stopped instead of overwriting theirs, and the app shows you the new version.
- Hand a group over: the person who made a group can pass it to someone else in it, from Group settings.
- Download my data and Delete my data, in your profile under Your data and privacy. Deleting needs your password. Expenses you share with others stay, shown as "Former member", so nobody's balance changes, and groups you made pass to someone still in them.
- Not saved list: changes the laptop couldn't save stay on Home and in the pill at the top until you tap Redo (the form opens again with what you typed) or dismiss them. The pill also says "Waiting to sync (N)" and when the phone last caught up.
- Bring old expenses along: invite someone you've been tracking by name (a private contact, or a name-only member of a group) and their invite link carries that history. After they join they see what's waiting, with every entry and their share, and tap "Yes, that's me" or "Not me". Someone already on Split it gets the same choice as a request. The server moves everything in one step and checks that every balance comes out the same; either of you can undo it for 7 days. Anyone in a group can hand over its name-only member, and the group gets a notification. Private expenses that also include other people not on the app stay with you, and the new person gets one "Carried over from before you joined" line for their part.
- @tags: everyone gets a unique tag (changeable in your profile). Add friend finds people by exact tag or checked email and sends a request they accept. No list of everyone once a Split it has more than 15 people.
- Friend link with a QR code in your profile: anyone on Split it who opens it becomes your friend. Make a new link any time and the old one stops working.
- "Is Mohit your Mohit?": when someone on the app shares a first name with a person you track by name, Home suggests sending them that history (never on its own).
- Add friend shows your open invite links, friend requests and hand-overs, with Cancel and Undo. The join page fills in the invited person's name and says how much is waiting for them, without showing amounts.
- Sign-in code (profile, Signing in). Works with any authenticator app. Eight backup codes, each good once. The owner can turn it off for someone who lost their phone, from the owner's page or with `node server.js code-off NAME`.
- A second place for backups: set `BACKUP_COPY_DIR` in `split-it.env`. The records go there every 6 hours (one file a day, 14 kept), and each receipt photo is copied there once. The owner's page has a "Copy off the laptop now" button.
- Locked backups: set `BACKUP_PASSPHRASE` and the copies off the laptop become `.locked` files that only the passphrase opens. The owner can also download a locked backup ("Download everything (locked)", or "Download locked…" to pick a passphrase for one download).
- Restore from the laptop: `node server.js restore FILE` puts back a `.zip`, a `.locked` file or a daily `db-….json`, even while the app is running. Use it for backups over 100 MB.
- Time zone: set `TZ` so reminders, bill dates and "today" follow the house's clock. The owner's page shows the server's zone and warns when it's UTC or differs from the owner's phone.
- Home currency: set `HOME_CURRENCY` (for example `USD` or `EUR`) and amounts, notifications, the calendar and the AI assistant all use it. It stays CAD unless you change it.
- Trip currency: in group settings, pick the currency you mostly pay in. New expenses there start in it and are turned into your home currency at the day's rate, plus a card fee (2.5% unless you change it, 0 for cash). The expense says "includes 2.5% card fee", and you can change the fee on any single expense.
- Who takes over a bill: if someone leaves a group while they're still in a bill, the bill pauses instead of charging them. The group page asks who takes over, with a button for each person or "Split it between the rest". Anything that came due while it was paused is added once someone picks.
- Make a new calendar link: shared it by mistake? Make a new one and the old one stops working.
- Two people paid: on a new expense, tap "Two people paid" and enter what the second person paid. It's saved as two entries, so the balances come out exactly right.
- Record a payment between two other people in the group. The settle-up list shows "Record it" on their transfer, and "waiting for … to confirm" once it's recorded.
- On a person's page in a group: the transfers that clear their balance, and "Who pays these bills now?" when they pay a bill.
- "Yes, got them all" when three or more payments are waiting for you to confirm.
- Swap a chore: open a chore and tap "Swap with …". They take this turn, you take theirs, and they get a notification.
- Share into Split it: with the app on your home screen (Android), share text from another app and it lands in quick add.
- Quick add understands money coming in: "refund 20 from costco" or "sold the couch 90" opens with Money coming in turned on.
- Connect your own AI assistant from the app: your profile has a new AI assistants section with your connector link, steps for Claude, a list of the assistants and keys that act as you (with when each was last used), and a Disconnect button for each. Anyone can make their own key for an assistant that asks for one, without the laptop command line.
- Your AI assistant can do more: split by shares or exact amounts, tell you who should pay whom, list the bills coming up, and sum up a month. After adding an expense it says what your own share is, which Budget it uses to count only your share in your budget.
- The owner's page says when a newer Split it is out, with a link to what changed. `UPDATE_CHECK=off` turns that off.
- A "What's new" card on Home after an update, shown once.

### Improved
- When someone removes an expense or payment you're in, you get a notification ("Ana removed Hydro") and a message in the app, with a link to it in Recently deleted.
- When the server refuses a change, the app gives the server's own reason in plain words, for example "Only Ana, who made this group, can rename it".
- Your profile says plainly who can see what: groups are private from housemates who aren't in them, but not from whoever runs the laptop.
- You stay signed in while you use Split it: each day you open it, your sign-in runs another 90 days.
- Too many wrong passwords for one account now slow its sign-in down for a short while instead of locking that person out. Five misses from one visitor still mean a 15 minute wait for that visitor.
- Connecting an assistant: if you're already signed in to Split it in that browser, one tap on Allow is enough. People who sign in only with Google can connect one too. The connect page shows, in large type, the address your key goes to, so a look-alike app is easy to spot.
- Moving someone out, handing over their bills, "Yes, got them all", linking a guest, making or editing a group, "Two people paid", pasting a list, removing a friend, adding a comment and the Splitwise import now save all at once: everything goes in or nothing does, so balances are never left half-updated.
- A change that keeps failing no longer holds up everything behind it: after a few tries it's set aside and you're told. Sending gives up after 20 seconds instead of hanging, and the phone retries with growing waits.
- Backups are taken every 6 hours and each time the app starts, so every update begins with a fresh copy. The last 12 are kept, plus 30 daily copies and the Sunday copies for a year.
- Backups are written to disk as they're made, one photo at a time, instead of built whole in memory. Restoring from the website accepts locked backups and asks for the passphrase.
- Expenses and payments are on the laptop's disk before your phone is told they were saved. The owner's page warns when the disk is 90% full.
- Exchange rates come from the laptop, once a day for the whole house. Each expense keeps the rate, its day and the card fee, and says plainly when an older rate is being used because the rate service isn't answering.
- Moving someone out takes them off the bills first, then out of the group.
- The AI assistant: in a trip group it asks which currency an amount is in and converts it like the app does (it never saves euros as dollars), it splits the odd cent the same way as the app, and it gives back the numbers as data next to its sentence for Budget it.
- Receipt reading no longer needs an outside website. The reader (about 11 MB) comes from your own Split it, so it works on a home network with no internet.
- Laptop commands (`add-user`, `set-password`, `remove-user`) now work while the app is running and take effect right away. No more restart.
- The app is now installed in `~/split-it` with a service called `split-it`. Running `install.sh` moves an older `~/house-split` over for you, data and settings included.
- Runs on Node.js 22 or newer. Node 18 and 20 no longer get security fixes, so the installer now sets up Node 24.
- In Docker the app runs as an ordinary user instead of root, with extra privileges dropped.
- "Last time" on a new expense only looks at entries of the same kind, so a refund never suggests a charge and the other way around.
- Bills split by percentage say so, with each person's %.
- Keyboard: sheets take focus when they open, keep Tab inside, and give focus back when they close. Your guide can be reached with Tab and opened with Enter.
- Better contrast for the green "owed" text in light mode and for initials on bright colours. Images are a little smaller.
- The group page's buttons wrap on very narrow phones instead of running off the edge.
- New tests start the real server and check who can see what, the money rules, sign-in (also behind Cloudflare and Traefik), backups and the assistant, and that text people type never runs as code. The release check also tests the Docker image: build, start, sign in, save, restart, and check nothing was lost.
- The website now says running Split it and Budget it together costs $70 a month, with bank linking in Budget it costing extra.

### Fixed
- Behind a proxy (Docker, Coolify, Traefik, Cloudflare), five wrong passwords from one person locked everyone out for 15 minutes. Split it now counts tries per real visitor.
- New assistants couldn't always connect. Apps that signed up but never finished are now cleared after a day, and when the list is full the oldest unused ones make room.
- Deleting an expense by talking to the server directly deleted it for good, skipped the bin and told nobody. Now every delete goes to the bin.
- The bin always shows who really removed an entry. A phone can't put someone else's name on it.
- Changes the laptop refused while you were offline disappeared without a word, even though they had shown as saved.
- One stuck change could keep every later change from reaching the laptop, and when the laptop came back, queued changes weren't sent until something else happened.
- Changes made offline could be lost if you added another one while the first was still sending.
- A full disk crashed the app over and over. Now it keeps showing everything, says plainly that new changes can't be saved, tries again by itself and warns the owner. Refused changes are never shown as saved.
- If `db.json` was damaged and the app started from a backup copy, nobody was told. The owner now sees a banner naming the copy and when it was taken. A file of the wrong shape (like `{"docs":null}`) now counts as damaged too.
- A restore checks the whole file before replacing anything, and refuses one that isn't Split it data (empty or the wrong shape) with a clear message.
- Backup names and "today" used UTC dates in a few places. They now use the local date.
- Amount boxes no longer guess. "12,50" is $12.50 and "1,234.56" still works, but "1.234,56" (which became $1.23) or "10-15" (which became $1015) gets a short note and can't be saved. Quick add leaves an unclear amount empty and says why.
- An AI assistant that tried again after a slow answer could add the same expense or payment twice. A repeat within 2 minutes now gets "Already added".
- A bill kept charging someone who had left if the move-out helper wasn't used.
- A reminder could be sent to any account, for any amount. Now it only goes to someone who really owes you, and never for more than they owe.
- Odd names like "constructor" could pass as a real person in a one-on-one split, and showed up as "Object" in notifications.
- AI assistants now see your one-on-one balances with friends who aren't on the app (and carried-over balances). Before, they only saw groups. They can also add expenses and record payments with those friends, which stay private to you.
- Moving a bill's next due date later (say Dec 1 to Jan 1) still charged the month in between.
- Filling in an older variable bill used the bill's current split instead of the one it was posted with.
- A month where refunds beat spending drew its bar and category rows below zero. It now shows as zero.
- New profiles start with a guide picked in the picker, not a random one.
- Someone taken off an expense, or whose expense moved to another group, now sees it disappear right away instead of after a reload.
- The AI assistant could create a person called "me" when asked to split or pay "with me".
- One badly encoded cookie from another app on the same laptop could stop every page from loading.
- The only owner could remove their own owner status, leaving nobody able to open the owner tools.
- A Splitwise import marked every payment as received. Payments to someone who uses Split it now wait for them to confirm, like any other.

### Security
- Every expense and payment is checked on the server, including ones an AI assistant adds: whole cents, shares that add up to the total, only people in the group, and logged under the person who added it.
- A payment only counts once the person who was paid confirms it. Nobody else can mark it received, even by talking to the server directly.
- Only the person who made a group can rename it, delete it, hand it over or take someone else out. Anyone can leave by themselves, and whoever added a name-only guest can take that guest out.
- "Edited by" and the change history are set by the laptop, not the phone, so they can't be faked.
- Only the app's own kinds of data can be stored or read. One record can be up to 256 KB, and one person can keep up to 20,000 records of a kind.
- Sign-in tokens are stored hashed, so a copy of a backup can't be used to sign in as anyone.
- Backups no longer hold sign-ins, open invite links, one-time assistant codes, phone notification subscriptions or the notification sending key. A restore keeps the ones the laptop has now, so after a move to a new laptop everyone signs in again and turns notifications back on.
- Locked backups use AES-256-GCM with a key made from your passphrase. Receipt photos in the copy folder are locked one by one too.
- Download my data never includes password hashes, sign-in code secrets or the calendar link. Delete my data needs your password, and wrong tries count toward the sign-in limit.
- Changing your email asks for your current password or a sign-in code. If you sign in only with Google, it works within 10 minutes of signing in.
- With a sign-in code on, a password reset link or an email sign-in link no longer signs you in by itself, and an AI assistant has to give the code to connect.
- Requests that change things are refused when they come from another website's page. A request passed on by a proxy is never treated as coming from the laptop itself.
- Password reset, "Sign out everywhere" and the owner's "Sign out" now close that person's open live-update streams and revoke their AI assistant access.
- Assistants and keys are only ever listed and removed by the person they belong to. The list never shows a key itself. Keys and connections nobody used for 90 days stop working, and each address can sign up at most 20 assistant apps an hour.
- Text written by housemates (titles, notes, group and bill names) reaches the assistant quoted and escaped, marked as data, not instructions. Every assistant tool that changes something asks you to confirm first.
- Signing out clears this phone's saved copy of your data, your waiting changes and your Not saved list. If changes are still waiting, Sign out asks for a second tap first.
- On a shared phone, each person's saved copy is kept apart: when someone else signs in, the last person's copy is deleted, and their waiting changes are never shown or sent as the new person.
- The receipt reader is shipped inside the app instead of loaded from another website, so a change on someone else's server can't run inside Split it.
- Spreadsheet export: a cell that starts with =, +, -, @ gets a ' in front, so a title can't run as a formula. Plain numbers like -12.50 stay numbers.
- Hidden "made with" tags (C2PA) were removed from every image. The pictures themselves are unchanged.

### Known issues
- Updating a Docker install from v2.1: the data volume still belongs to root. Hand it over once with `docker compose run --rm --user root split-it chown -R node:node /data`.
- Delete my data doesn't reach backups already made. They keep a copy until they roll off (daily copies 30 days, weekly copies a year).
- Set `HOME_CURRENCY` once, at the start. Changing it later doesn't convert expenses already saved. Bills and payments are always in the home currency.
- Deleting a comment is still permanent, and nobody is told.
- Older groups that never recorded who made them keep the old rule: anyone in them can rename them or move people out.
- Photos removed from the laptop stay in the backup folder's `photos/` (on purpose); clear old ones by hand.
- The sign-in code needs the key typed or opened on the same phone. There is no QR code to scan yet.
- The server checks, history, sign-in code, backups and laptop commands only apply to the laptop app, not the Claude artifact preview.

## v2.1.0 · November 9, 2026

**Safer by default, plus money coming in.** Groups are now private to the people in them, your data survives a bad shutdown, and you can record refunds and deposits coming back.

### Highlights
- **Private groups.** You only see the groups you're in and the expenses you're part of. A friend you split one dinner with no longer sees the house.
- **Money coming in.** Record a refund, a deposit back or something you sold. It comes off everyone's share.
- **Payment notes.** Payments get a date (for ones you record late) and a note, like an e-Transfer reference.

### New
- Money coming in: a toggle on any expense for refunds, deposits back and things sold.
- Payment date and note. The note shows in the list, the details and the "Did you get it?" prompt.
- A number on the Home tab, and on the app icon where the phone supports it, for things waiting on you.
- Search finds amounts: "54" or "54.20".
- Your guide shows up on empty screens, cheers when your payment is confirmed, when you clear everything that needs you, and at 7, 30 and 100 days even. A coin hops across when you pay.

### Improved
- The phone's Back button closes the open sheet, then goes back a page, instead of closing the app (laptop app).
- New bills due today show up right away instead of within 10 minutes.
- Weekly and yearly bills say "this week's" or "this year's" amount.

### Fixed
- Editing an expense someone else just changed now warns you before you overwrite their change.
- A phone with an old copy can no longer overwrite a bill amount someone already filled in.
- Reminders don't nag you about a payment you've marked paid that is waiting to be confirmed.
- Two comments at the same time no longer throw off the comment count.

### Security
- Group privacy is enforced by the laptop server, for reading, changing and live updates.
- A damaged data file (say the laptop lost power mid-save) no longer starts an empty house. Split it restores the newest backup, or refuses to start so nothing is overwritten. Saves are flushed to disk first.
- Changes made offline are kept if your sign-in expired, and new changes wait behind them so everything arrives in order.
- Emails with sign-in and reset links only go out once `PUBLIC_URL` is set.

### Known issues
- The Back button, private groups and the damaged-file restore only apply to the laptop app, not the Claude artifact preview.
- "Money coming in" can make a month's spending total negative when a refund is bigger than that month's spending.
- Houses past about 1,000 expenses still download the full history on each open. A faster path is planned.

## v2.0.0 · November 7, 2026

**Faster**
- The page is a third of the size and the laptop sends it compressed. Opening it on a phone is noticeably quicker, and repeat opens use what the phone already has.
- Live updates now send just what changed, so a busy house doesn't re-download everything after every expense.
- Works away from wifi: you see what you last had, and anything you add waits in a queue and goes through when the laptop is reachable again.

**Your guide**
- All four poses are in use. Happy when things are about even, worried only when you owe more than about $100, calm (and a little smug) when you're owed a lot, and a celebration pose for the rest of the day you hit zero.
- Luffy and Hancock talk in their own voices. They say hello once a day, react when a housemate adds something, lean in when you start typing, and drift as you scroll.
- "Even for 12 days" shows up once everyone has stayed square for a while.
- Wanted posters: the group page puts a bounty on whoever owes the most. Tap to share it as a picture.

**Bills**
- Bills can repeat weekly or yearly, not just monthly.
- A bills calendar, with a file for your phone's calendar app or a private link it keeps up to date.
- Budgets per category per group, with a quiet nudge at 80% and when they're used up.

**Adding things**
- Scan a receipt without any AI: the phone reads the text itself (Tesseract), fills in the store, total, date and items for you to check.
- Say it instead of typing it (on phones with speech recognition).
- Paste a list: several expenses in one go.
- A default split per group (by shares), so rooms and couples don't have to set it every time.
- Live exchange rates when you pick another currency.
- Undo right after adding. Categories show the five you actually use, with the rest behind More.

**Finding things**
- Activity shows each month's total and your share, folds old months, and filters by person and category.
- A dot marks comments you haven't read, and new comments show under Needs you.
- Expenses keep a short history of edits.
- Trip or month summary you can copy as text or share as a picture.

**Running it**
- Owners get a "Run Split it" page: health, people (reset links, rename, sign out, remove, make owner), a one-tap full backup (zip with photos) and restore.
- Weekly backups are kept for a year on top of the daily ones.
- Import a Splitwise group from its CSV export.
- Tests, a Dockerfile and a CONTRIBUTING guide.
- Assistants (Muse, Claude) can undo their last entry.
- Home-screen shortcuts: add an expense or settle up straight from the app icon.
