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
