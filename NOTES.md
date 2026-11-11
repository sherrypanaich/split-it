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
