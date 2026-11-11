# Server review (v2.2.0 round 2): release notes

## Fixed
- When someone deletes their own data, the bills they pay or share in a group are now paused and the group is asked who takes over, the same as when someone leaves. Before, those bills kept charging a "Former member".
- A request the app can't read (not JSON, or empty) now gets a clear "wasn't readable" answer instead of a server error. This covers every endpoint, and the assistant connector and the assistant sign-in pages too.
- If the exchange-rate file can't be written, everything else still saves. Before, one failed rates save made the app refuse every change as if the disk were full.
- Expenses and payments an assistant adds to a private one-on-one now go through the same checks as the app. On a full disk the assistant hears "Nothing was added" instead of being told it worked while nothing was saved. The same goes for "undo my last entry" on a private one.
- Taking over history (claims): on a full disk the app says so before anything moves, and a hand-over is written to disk straight away, like any other expense.
- The "Carried over from before you joined" line and the file name of "Download my data" now use the laptop's own day (the TZ setting), not UTC.
- A full disk no longer turns opening the app, or signing out, into an error page.
- The list of hand-overs still shows when its file can't be tidied up on a full disk.
- Friend notifications aren't sent over and over: asking, taking it back and asking again buzzes the other person once an hour at most, and using someone's friend link again when you're already friends sends nothing.

## Security
- Putting a backup back no longer brings back an assistant that was disconnected after that backup was made (for example after "sign out everywhere" or a password reset). Assistants connected now stay connected, the same way people's sign-ins already did. A laptop with no assistants yet (a move to a new laptop) still takes them from the backup.
- Friend requests and hand-overs can't be sent to built-in names like `__proto__`, and the assistant sign-in pages no longer crash on them.

## For the README
- Restoring a backup keeps the people and assistants who are signed in now. Assistants that were connected only in the backup have to connect again; on a new laptop, the assistants from the backup are kept.

## Findings (what, impact, fixed or not)
| What | Impact | Status |
| --- | --- | --- |
| `forgetPerson` replaced the member with an inactive "Former member" before `removeUser` looked for active memberships to pause bills | Bills kept posting, charging someone who deleted their account | Fixed (bills paused first), test |
| `readBody` rejected bad JSON with a plain error, and `null` bodies crashed destructuring | 500 on ~30 endpoints with junk input | Fixed (400, non-objects read as `{}`), test |
| MCP `rpc` with `params: null`, OAuth `readForm` with JSON `null`, `store.clients['__proto__']`, a bad `%` in a Basic header | 500s on the assistant endpoints | Fixed, test |
| `refreshRates` saved through `save()`, which marks the disk as failing | An unwritable `rates.json` blocked every save with 507 | Fixed (plain atomic write, logged), test |
| MCP private one-on-ones wrote `db.docs` directly | No disk, size or count checks; "added" on a full disk though nothing was saved | Fixed (through `writeOps`), test |
| Claims `apply` bypassed the disk check and used the delayed save | A hand-over accepted on a full disk; money not on disk before the answer | Fixed (`storageProblem` check, `commitDb`), test |
| Restore wrote the backup's `oauth.json` over the current one | Revoked assistant tokens came back; current ones signed out | Fixed (current tokens kept, clients merged), test |
| Claims `today()` and the export file name used UTC | Wrong date for part of each day outside UTC | Fixed (`localDay`), test |
| `keepSession` and `/api/logout` let a failed `users.json` save throw | One page load a day (or sign-out) became a 507 page on a full disk | Fixed (caught; saved with the next change) |
| Claims `prune()` save throwing on GET | Hand-over list failed on a full disk | Fixed, test |
| `U().users[to]` in friend requests and claims hit prototype names | Junk requests stored for "__proto__" | Fixed (`Object.hasOwn`), test |
| `/api/me/delete` changed records before `users.json` was saved | On a full disk, half a deletion with the account still there | Fixed (users.json saved first) |
| Friend request / cancel / request again, and reusing a friend link, each sent a push (from Budget it) | Notification spam | Fixed (`tellOnce`, one per pair an hour; link only tells when not already friends), test |
| `tooManyLookups` kept adding timestamps after the limit (from Budget it) | Memory grew for someone hammering find | Fixed (only counted under the limit); the test checks the limit still holds, memory isn't observable from outside |
| accounts.js exports weren't listed in its header | Budget it copies it; hard to see the contract | Documented in the header (comment only) |

Checked and fine: session hashing in the stream map, `endSessions` keep, restore, CLI and MCP one-tap Allow all use the hashed key; the origin check covers the login, join, OAuth form and sign-in endpoints and leaves `/mcp` and `/oauth/token` alone; bills posted by `postDueBills` use fixed ids, so the batch path, the page and the hourly runner can't double-post; `leaversIn` sees the whole batch, so the move-out helper's own bill edits win; no remaining hard-coded CAD or `$` in server or assistant text (only the `CAD` default).

## Not done
- Bills the laptop posts (`postDueBills`) still have no version or "added" line in their history, and use the delayed save. A version starts at the first edit, the ids are fixed so a crash can't double-post, and there's no person to name as the one who added it, so I left it.
- The assistant's currency name is made plural by adding "s" ("Japanese yens" for JPY). Cosmetic and only for a few currencies; a proper fix needs a list of plurals.
- Other places a full disk can still give a plain server error rather than the disk message: claims.json and oauth.json saves (assistant sign-in) on their first failure. They don't lose data; they just say "server error".
- `/api/logout` works with GET, so another site could sign you out with a link. Low impact; changing it touches the page's sign-out link.


# Polish and accessibility pass (v2.2.0 screens)

Checked on a seeded house (four people, a house group with a guest and a paused bill, a trip in euros, edits with history, waiting payments, a friend request, a history request, an invite link, an assistant key, an off-laptop backup), at 390×844 and 1280×800, light and dark. Before/after screenshots are in `split-it-v2.2.0/screens/polish-*`.

## Improved
- Buttons are easier to tap on a phone: small buttons, chips, the Light/Dark style switches, colour dots, the close (×) button, "Not saved" in the pill at the top, "All friends"/"Add chore"-style links and the calendar's month arrows are all at least 40px tall now.
- An expense's buttons (Edit, Copy, Favourite, Delete) fit on a phone. Delete used to run off the edge.
- Long sheet titles ("Groceries at No Frills + bread", "Maple St house calendar") wrap to a second line instead of being cut off.
- Labels that used to be cut off now wrap: "Equal between everyone" in group settings, "Your tag" and "Sign-in code" in your profile, and the server time zone on the owner's page.
- The owner's page lists its warnings one under the other, instead of one long paragraph.
- A typed amount the app can't read ("1.234,56") is explained right under the amount box, not only at the bottom of the form.
- When the laptop refuses a change, the app now shows its reason ("Only Ana, who made this group, can rename it", "That's too big to save…") instead of a general "You don't have permission".
- "Someone else changed this while you had it open. Have a look and try again." replaces the shorter message when two people edit the same expense.
- Not saved: "Your expense 'Pizza' wasn't saved. The shares add up to…" reads as two sentences, and its times look like the rest of the app ("6:43 a.m.").
- History someone hands you shows dates like "Jul 14" (with the year when it isn't this year) instead of 2026-07-14. A trip expense says "rate from Nov 8".
- Bills calendar: "Download a copy" instead of "Download .ics". The note now comes before "Make a new link", like the friend link, and the second tap resets after a few seconds like everywhere else.
- Join page shows which box you're typing in. On the sign-in page, "Forgot password?" is easier to tap, and so is "Not you? Sign in as someone else" on the page where you connect an assistant.
- Assistant keys: "Paste it where your assistant asks for an API key or token" (no more "bearer").
- Screen readers: the calendar link box has a label, the amount box says when its amount is wrong, and handing a group over reads out the "Tap again" step.

## Fixed
- In a Split it that keeps money in another currency (`HOME_CURRENCY`), Redo on a change that wasn't saved treated a home-currency expense as a foreign one.
- A member with a zero balance showed "$0" in group settings even when the home currency isn't dollars.

## For the README
Nothing new to add.

## Not done
- The Luffy and Boa Hancock guides are untouched.
- The connect-an-assistant page keeps its own system font and plain card. Restyling it in the comic look would be a redesign, not a polish.
- The owner's page still names settings like `TZ`, `BACKUP_PASSPHRASE` and `HOME_CURRENCY`. Only the owner sees that page, and they need the exact names to set them.
- The "Today", "Nov 18" and "Paused" pills look a little like buttons next to "Done". They're older than v2.2.0, so I left them alone.
- Colour dots still wrap one dot onto a second row at phone width, as they did before.
- Inline text links inside notes ("Paste a list", "copy the link with the key in it") stay the height of the text, like any link in a sentence.
- The server's stale-edit message (`STALE` in server.js) still says "This changed since you opened it. Have a look again." The tests pin that wording. The app shows its own clearer text in the toast. The Not saved list shows the server's text.


# Phone, offline and preview (wip2-pwa)

Tested in a real (headless) Chromium with the service worker on: updating a phone from v2.1.0, offline
add/edit/delete, two people on one phone, the Claude artifact preview build, and push subscriptions.

## Fixed
- Changes you made offline before updating to this version are now sent once. The first one could be sent twice.
- Signing out while away from wifi no longer half signs you out. Before, the phone forgot its copy but stayed
  signed in, so the next person to open it was still in as you. Now it says you're offline and to sign out once
  the laptop can be reached.
- Right after an update (and on the very first visit), the app now opens away from wifi straight away. Before, it
  showed "Can't reach Split it" until you had opened it once more on wifi.
- Opening the app offline no longer throws an error in the background when your own profile wasn't saved yet.
- In the Claude preview: Add friend no longer asks the (missing) laptop for invite links, and the group's
  Activity list no longer says "the laptop keeps the record".

## Security
- Signing out, and "Sign out everywhere", now turn this phone's notifications off first. Before, the next
  person signing in on a shared phone kept getting the last person's notifications (who added what, how much).
- If someone signs in on a phone where the last person didn't sign out, that person's notifications on this
  phone are ended.

## Checked, works
- Update from v2.1.0: the new service worker takes over without a second reload, the old caches
  (`split-it-shell-v3`, `split-it-data-v3`) are deleted, old-format queued changes (one change per item) are
  converted and sent in order, sign-ins and push subscriptions from before the session hashing still work, and
  the saved copy is the signed-in person's only.
- Offline: add, edit and delete wait in order, the pill says "Waiting to sync (N)" and "Offline", the app reopens
  offline with the changes shown, each change reaches the laptop exactly once, a refused one shows a toast with
  Redo, stays in "N not saved" in the pill and on Home, and Redo opens the form again with what was typed.
- Two people on one phone: a change Ana left waiting is dropped (never sent as Ben) when Ben signs in, Ben's
  offline copy holds only his data, Ana's private entries never show for Ben.
- Preview build (index.html minus the manifest/icon links and `<script src="/shim.js">`): boots, makes a group
  through the one-by-one writeAll fallback, adds/edits/deletes, Activity, Stats, Group settings, Add friend,
  profile without laptop-only sections, trip currency falls back to asking frankfurter.app directly and says so
  when it doesn't answer, and the receipt reader loads from jsdelivr (hash checked) and reads a receipt. No page
  errors and no requests to `/api/…`.
- Push: subscribe/unsubscribe/test are keyed by person, not by session, so hashing sessions didn't change them;
  test/integrity.test.js still delivers through its fake push service.

## Tests added
- test/pwa.test.js (Playwright + Chromium, skipped without them): update from the previous release (needs
  `v2.1.0` or commit `e2639cb` in the checkout, else skipped), offline sync and Redo, two people on one phone with
  push, and the artifact preview build including the receipt reader.
- test/shim.test.js: old-format queue items are sent once; sign-out offline throws and keeps everything.

## For the README
- Shared phone: "Sign out (in your profile) needs the laptop to be reachable. It also turns that phone's
  notifications off, so the next person doesn't get yours."

## Not done
- Changes queued by v2.1.0 have no owner recorded. If someone else signs in on that phone before the person who
  made them, they're sent under the new person's sign-in (as v2.1.0 itself did). Telling whose they were would
  mean reading the old cache, which the new service worker deletes on takeover; too fiddly for the gain.
- A change someone left waiting on a shared phone is dropped silently when another person signs in. It can't be
  sent as them, and showing it to the other person would leak it. The sign-out warning already says changes
  will be lost.
- "Sign out everywhere" only turns notifications off on the phone you tap it on. Other phones keep their
  subscription until they're turned off there, or the person is removed. Fixing that means a server change in
  accounts.js, which is shared with Budget it.
- Phones subscribed before this version have no record of who turned notifications on, so the "someone else
  signed in here" check only covers subscriptions made from now on (and every sign-out covers all of them).
- The "not saved" toast can briefly show an expense's previous title when an edit to it was saved a moment
  earlier in the same sync. Cosmetic.


# Release notes: whole-household walk-through (wip2-flows)

Three people (an owner and two housemates, one in dark mode) used the real app side by side on phone-sized
screens, plus two people who joined later through invite links. Every flow in the task was tried: friends and
@tags, a group with a name-only member, every kind of split, trip currency with a card fee, two people paying,
editing at the same time, the bin, comments, payments and "Yes, got them all", bills and chores, moving out,
handing over history, Download my data, Delete my data, and signing out and back in.

## New
- A test that walks a whole household through the app on three phones (`test/e2e-flows.test.js`). It is skipped where Chromium isn't installed.

## Improved
- Friend requests and history hand-overs now show up on the other person's open page right away, instead of after up to a minute or a reload.
- Deleting one part of a "Two people paid" expense moves both parts to Recently deleted, and putting one back puts both back. The toast says "Both parts moved to Recently deleted".
- After someone takes over history logged under their name, the expense history says "Mohit took over the share logged before they joined" instead of listing the same name twice.
- Group messages say who *runs* the group ("Only Ana, who runs this group, can rename it"), which stays true after the group is handed over.
- Tapping Done on a chore that comes back to you says "Your turn next" instead of just "Done".

## Fixed
- "Two people paid" in a trip currency: both entries could never be edited again (Save stayed off with "US$4.35 more than the total").
- Someone who moved out stayed in chore rotations: it still became their turn, and they still got "Your turn" reminders.
- Delete my data didn't pause the bills that person was in, so the group was never asked who takes over.
- A friend's page you had open turned into an empty "Former member, all square" page when that contact took over their history. It now goes back to the friends list.
- Taking over history showed the "PAID!" celebration, though nobody paid anything. It's a plain note now.
- A former member was called "Former" ("Former left, so Gas bill is paused. Who takes over Former's share?").
- Remind copied "You owe $12" to someone who had already marked those $12 as paid. Now it says they already marked it paid.

## Security
- Nothing new.

## For the README
- CHANGELOG v2.2.0 quotes the old message "Only Ana, who made this group, can rename it". It now reads "Only Ana, who runs this group, can rename it".
- `test/` now also has `e2e-flows.test.js`: the whole app on three phones (needs Playwright with Chromium, otherwise skipped). It takes about 2 minutes.

## Bugs found (what, where, status)
| # | What | Where | Status |
|---|------|-------|--------|
| 1 | Two people paid in a trip currency stored the exact shares in the home currency while the amount was in the trip currency, so the form could never save the entries again | `public/index.html`, openExpense save (`part()`) | Fixed |
| 2 | Moving someone out left them in chore rotations | `server.js`, new `dropFromChores()` / `leftGroup()` called from `leaversIn`, `removeUser`, `forgetPerson` | Fixed, test in `test/money.test.js` |
| 3 | Delete my data marked the person as a former member before the bill check ran, so their bills never paused | `server.js`, `forgetPerson` (now pauses and leaves chores first) | Fixed, test in `test/integrity.test.js` |
| 4 | Friend requests and hand-overs only appeared on the next 60-second check | `server.js` `inboxFor` (an `inbox` event on the live stream), `public/shim.js` (one listener), `public/index.html` (reloads what's waiting) | Fixed, test in `test/server.test.js` |
| 5 | An open friend page became a ghost "Former member" page after the contact took over their history | `public/index.html`, `render()` | Fixed |
| 6 | "PAID!" celebration after "Yes, that's me" | `public/index.html`, `openClaim` | Fixed |
| 7 | "Former member" shortened to "Former" by `firstName` | `public/index.html`, `firstName` | Fixed |
| 8 | Remind asked for money already marked as paid (the laptop refuses the phone reminder for it, the copied text didn't) | `public/index.html`, `#fRemind` | Fixed |
| 9 | Deleting one half of a two-payer expense left the other half counting toward balances | `public/index.html`, `bindDelete` | Fixed |
| 10 | "who made this group" after the group was handed over | `server.js` group rules, `public/index.html` group settings and member page | Fixed |
| 11 | Hand-over history line listed the same name twice ("Mohit $5.65 → $0.00, Mohit $0.00 → $5.65") | `public/index.html`, `changeLines` | Fixed |
| 12 | Chore Done toast said "Done" when the turn came back to you | `public/index.html`, `choreDone` | Fixed |
| 13 | Quick add "uber with Ben and Ana 18" with two friends who share no group opens "Who's it with?" without ticking them | `public/index.html`, `localParse` | Not done (see below) |
| 14 | The group summary counts the two parts of a two-payer expense as two expenses | `public/index.html`, `openSummary` | Not done |
| 15 | After a hand-over, a payment's history says "(was Former member → Ben)" for the name-only record | `public/index.html`, `changeLines` | Not done |

Checked and fine: balances matched on all three phones and the laptop after every step (equal, shares, exact, items with tax,
two payers, trip currency with fee, part payments, confirm all, bills, take-over). "This changed since you opened it" stopped
the older save and showed the new version. Deletes told the others live, the bin restored them. Comments arrived live.
Calendar links worked and "Make a new link" killed the old one. Download my data and Delete my data (wrong password refused)
worked. Sign out and back in worked. No page errors, and no screen scrolled sideways at 390 px in light or dark mode.

## Not done
- Quick add with two or more friends and no shared group (13): it would need a new kind of context from the parser; it's a feature, not a regression.
- Summary counting two-payer parts (14) and the payment hand-over history wording (15): cosmetic, left alone.
- Entries saved with "Two people paid" in a trip currency before this fix (only possible in the unreleased v2.2.0 draft) still can't be edited; no migration, since no released version made them.
- Bringing someone back into a group doesn't put them back into chores; edit the chore to add them.
- Tapping Done on someone else's chore passes it to the person after them, not after you. Left as is: it's a choice, not a bug.

## Likely merge conflicts
- `server.js`: `leaversIn`, `removeUser` and `forgetPerson` (integrity/data slices); the "who runs this group" messages in the group rules (hardening/integrity); the accounts/claims `notify` hooks.
- `public/shim.js`: one added line next to the `refresh` listener (offline slice).
- `public/index.html`: `bindDelete`, `changeLines`, `firstName`, `render`, `openClaim`, `#fRemind`, `choreDone`, the two-payer save.
- `test/server.test.js`: `listen()` got an optional event-kind argument.
