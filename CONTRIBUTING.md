# Contributing to Split it

Split it is a small, dependency-free app: one Node server and one HTML page. Keep it that way.

## Ground rules

- **No npm packages.** The server runs on plain Node 18+. The page uses only what the browser gives it, plus two optional CDN scripts (Tesseract.js for receipts, Google Fonts). If a feature needs a library, it probably doesn't belong.
- **One page, two homes.** `public/index.html` runs both as a published Claude artifact (where it started) and on the laptop server. Anything that needs the server is wrapped in `if(LAPTOP)`. Don't fork the page.
- **Money is integer cents.** Always. Split rules live in `server.js` (`splitEqual`, `splitShares`, `itemsSplit`, `computeSplit`) and are copied into the page; the tests check they match.
- **Plain language in the UI.** Short sentences, no jargon, no exclamation marks except from the guides. Errors say what to do next.
- **Characters are hand-made art, not code.** Never draw characters in code. Add a guide by dropping four images in `public/art/<id>-{happy,calm,worried,celebrate}.webp` and one line in `ART`.
- **Light mode is the reference.** Dark mode must look as good, but don't change light mode to get there.

## Running it

```
node server.js add-user You
node server.js
node --test test/*.test.js
```


## Layout

- `server.js`: HTTP, storage (`data/db.json`), sessions, live updates (SSE), bills, notifications, backups, admin, zip.
- `accounts.js`: invites, email codes (Resend), Google sign-in, password reset.
- `mcp.js`: the AI-assistant connector (MCP over HTTP, OAuth).
- `push.js`: Web Push without a library.
- `public/shim.js`: makes the page's `claude.use('db')` talk to this server, patches live updates in place, queues writes made offline.
- `public/sw.js`: installable app, offline cache, notifications.
- `public/index.html`: everything the person sees.

## Before you open a pull request

1. `node --test test/*.test.js` passes.
2. You opened every screen you touched on a phone-sized window, light and dark.
3. `CHANGELOG.md` has a line for people, not for developers.

## Releases

Versions follow `vMAJOR.MINOR.PATCH`: a patch for fixes only, a minor for new features, a major for changes that need people to do something when they update.

1. Add a section to the top of `CHANGELOG.md`, headed `## vX.Y.Z · Month D, YYYY`, with a bold one-line headline, then Highlights, New, Improved, Fixed, Security and Known issues (leave out any that are empty).
2. Set `VERSION` in `server.js` to the same number.
3. After the pull request is merged, tag main: `git tag vX.Y.Z && git push origin vX.Y.Z`. The Release workflow publishes a GitHub Release from that changelog section.
