# Contributing to Split it

Split it is a small, dependency-free app: one Node server and one HTML page. Keep it that way.

## Ground rules

- **No npm packages.** The server runs on plain Node 22 or newer. The page uses only what the browser gives it, plus Google Fonts. The receipt reader (Tesseract.js 5.1.1) is a vendored copy in `public/vendor/tesseract/` (versions and sha256 hashes in its `VERSIONS.txt`), served by the laptop after sign-in; only the Claude artifact still loads it from jsdelivr, with an SRI hash. If a feature needs a library, it probably doesn't belong.
- **One page, two homes.** `public/index.html` runs both as a published Claude artifact (where it started) and on the laptop server. Anything that needs the server is wrapped in `if(LAPTOP)`. Don't fork the page.
- **Money is integer cents.** Always. Split rules live in `server.js` (`splitEqual`, `splitShares`, `itemsSplit`, `computeSplit`) and are copied into the page; the tests check they match.
- **The server doesn't trust the page.** Every expense and payment goes through `entryProblem` in `server.js` before it is saved. If the page learns to save a new shape of entry, teach `entryProblem` and add a case to `test/server.test.js`.
- **Every write goes through `writeOps(uid, ops)`** in `server.js`: `/api/write`, `/api/batch` and the assistant (`mcp.js`, via `h.writeOps`). It is all or nothing, so every rule, the version number, the change log and the "removed" notifications apply everywhere. Don't add a write path around it.
- **Batches.** `POST /api/batch` with `{ ops: [...], label? }` applies up to 100 writes together or not at all, then one save and one live update. In the page, use `writeAll(b => { b.set(ref, data); b.update(ref, data); b.delete(ref); }, label)`. Every op is checked against the data as it was before the batch, so a batch can't update a document it creates itself. In the Claude artifact there is no batch and the writes go one after another.
- **Versions and history.** Expenses and payments carry `v` (version) and `changes` (the last 20 changes), both set by the server. A client may send the `v` it opened inside `op.data`; if someone changed the entry since, the answer is HTTP 409 `{ error, code: 'stale' }`. A write without `v` isn't checked, and deletes always go to the bin.
- **Known collections only.** `people`, `groups` (+ `members`), `expenses` (+ `comments`), `recurring`, `chores`, `data/users/{uid}/…`, and the old `house`/`members`, which only the owner can write. Anything else is refused. `MAX_DOCS_PER_PERSON` (default 20000) caps records per person per collection; the tests set it low.
- **Dates are the laptop's day.** Anything that shows or names a date (claims, export file names, backups) uses `localDay`, which follows `TZ`, never a UTC slice of `toISOString()`.
- **Lookups by name use `Object.hasOwn`.** Person ids, tags and client ids come from outside; `users[to]` or `clients[id]` on a plain object matches `__proto__` and friends.
- **Request bodies.** `readBody` answers 400 for bad JSON and reads a non-object body (`null`, a number) as `{}`, so handlers can destructure safely. The assistant's `rpc` and the OAuth `readForm` do the same.
- **A failing side file doesn't block saves.** `rates.json` is written with a plain atomic write and logged on failure; only `save()` of the records marks the disk as failing.
- **No AI inside the app.** Reading receipts and quick add happen on the phone with plain code. Assistants connect from outside through `mcp.js`.
- **Plain language in the UI.** Short sentences, no jargon, no exclamation marks except from the guides. Errors say what to do next.
- **Characters are hand-made art, not code.** Never draw characters in code. Add a guide by dropping four images in `public/art/<id>-{happy,calm,worried,celebrate}.webp` and one line in `ART`. Run `node scripts/strip-image-metadata.mjs` before committing images; `test/images.test.js` fails if an image carries metadata.
- **Light mode is the reference.** Dark mode must look as good, but don't change light mode to get there.

## Running it

```
node server.js add-user You
node server.js
node --test test/*.test.js
```


## Layout

- `server.js`: HTTP, storage (`data/db.json`), sessions, live updates (SSE), bills, notifications, backups, admin, zip.
- `accounts.js`: invites, email codes (Resend), Google sign-in, password reset, sign-in codes. Shared word for word with Budget it; what differs between the two apps is passed in from `server.js`. Its exports are listed in its header; a change there needs the same change in Budget it.
- `mcp.js`: the AI-assistant connector (MCP over HTTP, OAuth).
- `push.js`: Web Push without a library.
- `public/shim.js`: makes the page's `claude.use('db')` talk to this server, patches live updates in place, queues writes made offline.
- `public/sw.js`: installable app, offline cache, notifications.
- `public/index.html`: everything the person sees.

## Before you open a pull request

1. `node --test test/*.test.js` passes (Node 22 or newer). `test/server.test.js` starts the real server on a spare port with an empty data folder. `test/xss.test.js`, `test/pwa.test.js` (update from the last release, offline sync, two people on one phone, the artifact preview) and `test/e2e-flows.test.js` (a household on three phones, about 2 minutes) need Playwright and its Chromium, and skip when they're missing (as on GitHub's runners). The update test also needs `v2.1.0` (or commit `e2639cb`) in the checkout. The server's stale-edit text (`STALE` in `server.js`) is pinned by the tests; the page shows its own wording in the toast.
2. You opened every screen you touched on a phone-sized window, light and dark.
3. `CHANGELOG.md` has a line for people, not for developers.

## Releases

Versions follow `vMAJOR.MINOR.PATCH`: a patch for fixes only, a minor for new features, a major for changes that need people to do something when they update.

1. Add a section to the top of `CHANGELOG.md`, headed `## vX.Y.Z · Month D, YYYY`, with a bold one-line headline, then Highlights, New, Improved, Fixed, Security and Known issues (leave out any that are empty).
2. Set `VERSION` in `server.js` to the same number.
3. Before tagging, run `scripts/smoke-docker.sh` on a machine with Docker. It builds the image, starts it on a fresh volume, adds a person, signs in, saves something, restarts and checks it's all still there. The release workflow also runs it.
4. After the pull request is merged, tag main (`git tag vX.Y.Z && git push origin vX.Y.Z`), or run the Release workflow from the Actions tab with the version. It publishes a GitHub Release from that changelog section.
