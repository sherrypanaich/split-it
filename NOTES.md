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
