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
