# What's new in Split it

## 2.1 (November 2026)

**Safer**
- Groups are private: people only see the groups they're in, and expenses they're part of. A friend you split one dinner with no longer sees the house.
- A damaged data file (say the laptop lost power mid-save) no longer starts an empty house. Split it restores the newest backup, or refuses to start so nothing gets overwritten.
- Changes made offline wait if your sign-in expired, and new changes queue behind them so everything arrives in order.
- Emails with sign-in and reset links only go out once `PUBLIC_URL` is set.
- A phone with an old copy can't overwrite a bill amount someone already filled in. New bills due today post right away.
- Reminders don't nag you about a payment you've marked paid that's waiting to be confirmed.

**New**
- Money coming in: refunds, a deposit back or something sold. It comes off everyone's share.
- Payments get a date (for ones you record late) and a note, like an e-Transfer reference.
- The phone's Back button closes the open sheet, then goes back a page, instead of closing the app.
- A number on the Home tab, and on the app icon where the phone supports it, for things that need you.
- Search finds amounts: "54" or "54.20".
- Editing an expense someone else just changed warns you before you overwrite their change.
- Your guide shows up on empty screens, cheers when your payment gets confirmed, when you clear everything that needs you, and at 7, 30 and 100 days even. A coin hops across when you pay.
- Weekly and yearly bills say "this week's" or "this year's" amount.

## 2.0 (November 2026)

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
