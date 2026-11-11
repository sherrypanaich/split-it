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
