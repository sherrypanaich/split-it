# What's new in Split it

## v2.2.0 · Draft, not released yet

**Safe to host, and easier to live with.** The server now checks the money on every save, sign-in gets a second step, backups leave the laptop on their own, and moving out, trips and shared bills take fewer taps.

### Highlights
- **The server checks the numbers.** Shares have to add up to the total, and only the person who was paid can say a payment arrived. Until now the page checked this and the server trusted it.
- **Sign-in code.** Add a 6-digit code from an authenticator app as a second step after your password, with backup codes for a lost phone.
- **Backups that survive the laptop.** Point Split it at a USB drive or a synced folder and a full copy goes there every day. The owner's page warns you when there isn't one.
- **Move-out helper.** Moving someone out lists the payments that clear their balance, each with a Record button, then lets you pick who takes over the bills they paid.

### New
- Bring old expenses along: invite someone you've been tracking by name (a private contact, or a name-only member of a group) and their invite link carries that history. After they join they see what's waiting, with every entry and their share, and tap "Yes, that's me" or "Not me". Someone already on Split it gets the same choice as a request. The server moves everything in one step and checks that every balance comes out the same; either of you can undo it for 7 days. Anyone in a group can hand over its name-only member, and the group gets a notification. Private expenses that also include other people not on the app stay with you, and the new person gets one "Carried over from before you joined" line for their part.
- @tags: everyone gets a unique tag (changeable in your profile). Add friend finds people by exact tag or checked email and sends a request they accept. No list of everyone once a Split it has more than 15 people.
- Friend link with a QR code in your profile: anyone on Split it who opens it becomes your friend. Make a new link any time and the old one stops working.
- "Is Mohit your Mohit?": when someone on the app shares a first name with a person you track by name, Home suggests sending them that history (never on its own).
- Add friend shows your open invite links, friend requests and hand-overs, with Cancel and Undo. The join page fills in the invited person's name and says how much is waiting for them, without showing amounts.
- Connect your own AI assistant from the app: your profile has a new AI assistants section with your connector link, steps for Claude, a list of the assistants and keys that act as you (with when each was last used), and a Disconnect button for each. Anyone can make their own key for an assistant that asks for one, without the laptop command line.
- Sign-in code (profile, Signing in). Works with any authenticator app. Eight backup codes, each good once. The owner can turn it off for someone who lost their phone, from the owner's page or with `node server.js code-off NAME`.
- A second place for backups: set `BACKUP_COPY_DIR` in `split-it.env`. One full zip a day, 14 kept, with a "Copy off the laptop now" button on the owner's page.
- The owner's page says when a newer Split it is out, with a link to what changed. `UPDATE_CHECK=off` turns that off.
- Two people paid: on a new expense, tap "Two people paid" and enter what the second person paid. It's saved as two entries, so the balances come out exactly right.
- Trip currency: in group settings, pick the currency you mostly pay in. New expenses there start in it and are turned into CAD at the day's rate.
- Swap a chore: open a chore and tap "Swap with …". They take this turn, you take theirs, and they get a notification.
- Share into Split it: with the app on your home screen (Android), share text from another app and it lands in quick add.
- Record a payment between two other people in the group. The settle-up list shows "Record it" on their transfer, and "waiting for … to confirm" once it's recorded.
- On a person's page in a group: the transfers that clear their balance, and "Who pays these bills now?" when they pay a bill.
- "Yes, got them all" when three or more payments are waiting for you to confirm.
- A "What's new" card on Home after an update, shown once.
- Quick add understands money coming in: "refund 20 from costco" or "sold the couch 90" opens with Money coming in turned on.
- Your AI assistant can do more: split by shares or exact amounts, tell you who should pay whom, list the bills coming up, and sum up a month. After adding an expense it says what your own share is, which Budget it uses to count only your share in your budget.

### Improved
- Laptop commands (`add-user`, `set-password`, `remove-user`) now work while the app is running and take effect right away. No more restart.
- The app is now installed in `~/split-it` with a service called `split-it`. Running `install.sh` moves an older `~/house-split` over for you, data and settings included.
- Runs on Node.js 22 or newer. Node 18 and 20 no longer get security fixes, so the installer now sets up Node 24.
- In Docker the app runs as an ordinary user instead of root, with extra privileges dropped.
- Wrong passwords are limited per account as well as per address: 10 misses for one person from anywhere means a 15 minute wait.
- When the server refuses a change, the app says why in plain words.
- Amounts with a decimal comma ("12,50") are read as $12.50. A thousands comma ("1,250.00") still works.
- "Last time" on a new expense only looks at entries of the same kind, so a refund never suggests a charge and the other way around.
- Bills split by percentage say so, with each person's %.
- Keyboard: sheets take focus when they open, keep Tab inside, and give focus back when they close. Your guide can be reached with Tab and opened with Enter.
- Better contrast for the green "owed" text in light mode and for initials on bright colours.
- The group page's buttons wrap on very narrow phones instead of running off the edge.
- 22 new tests start the real server and check who can see what, the money rules, sign-in, backups and the assistant. They run on GitHub for every pull request.

### Fixed
- AI assistants now see your one-on-one balances with friends who aren't on the app (and carried-over balances). Before, they only saw groups. They can also add expenses and record payments with those friends, which stay private to you.
- Changes made offline could be lost if you added another one while the first was still sending.
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
- Assistants and keys are only ever listed and removed by the person they belong to. The list never shows a key itself.
- Assistants and keys are only ever listed and removed by the person they belong to. The list never shows a key itself.
- Every expense and payment is checked on the server: whole cents, shares that add up to the total, only people in the group, and logged under the person who added it.
- A payment only counts once the person who was paid confirms it. Nobody else can mark it received, even by talking to the server directly.
- With a sign-in code on, a password reset link or an email sign-in link no longer signs you in by itself, and an AI assistant has to give the code to connect.
- Password reset, "Sign out everywhere" and the owner's "Sign out" now close that person's open live-update streams and revoke their AI assistant access.
- Restoring a backup brings back the notification keys too, so phones keep getting notifications on a new laptop.
- Restoring a backup no longer brings back sign-ins that were signed out after the backup was made.
- Changes queued offline remember who made them, so on a shared phone they're never sent as the next person who signs in.
- A restore file with empty data is refused instead of crashing the server.

### Known issues
- Updating a Docker install from v2.1: the data volume still belongs to root. Hand it over once with `docker compose run --rm --user root split-it chown -R node:node /data`.
- The sign-in code needs the key typed or opened on the same phone. There is no QR code to scan yet.
- The server checks, sign-in code, backups and laptop commands only apply to the laptop app, not the Claude artifact preview.

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
