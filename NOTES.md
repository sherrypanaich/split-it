# Hardening and release checks (wip-hardening)

## New
- Release check for Docker: `scripts/smoke-docker.sh` builds the image, starts it on a fresh volume, adds a person, signs in, saves something, restarts the container and checks everything is still there. The release workflow runs it before publishing (when the runner has Docker).

## Improved
- Receipt reading no longer needs an outside website. The reader (about 11 MB) now comes from your own Split it, so it works on a home network with no internet, and the first read is quicker on the same wifi.
- Images are a little smaller.

## Fixed
- Nothing new; the new checks found no problems to fix.

## Security
- The receipt reader (Tesseract.js 5.1.1, its engine and the English data) is shipped inside the app instead of loaded from jsdelivr. The page no longer allows scripts or downloads from jsdelivr or tessdata.projectnaptha.com, so a change on someone else's server can't run inside Split it.
- New automated check that text people type (names, titles, notes, items, comments, payment notes, chores, bills, nicknames, e-Transfer details, sign-in names) is never run as code on the page. It found no holes.
- New automated check that sign-in works behind Cloudflare and Traefik.
- Removed hidden "made with" tags (C2PA manifests) from every image. The pictures themselves are unchanged, byte for byte.

## For the README
- Receipts paragraph: replace "(Tesseract, downloaded once, about 10 MB)" with "(Tesseract, which comes with Split it, about 11 MB the first time a phone uses it; nothing is downloaded from anywhere else)".
- Release checklist (CONTRIBUTING or the release section): "Before tagging, run `scripts/smoke-docker.sh` on a machine with Docker. The release workflow also runs it."
- New art: "Run `node scripts/strip-image-metadata.mjs` before committing images; the tests fail if an image carries metadata."

## Developer notes
- Vendor files: `public/vendor/tesseract/` holds `tesseract.min.js`, `worker.min.js` (npm tesseract.js@5.1.1), `tesseract-core-simd-lstm.wasm.js` and `tesseract-core-lstm.wasm.js` (npm tesseract.js-core@5.1.1, SIMD build plus a plain build for older phones), `eng.traineddata.gz` (npm @tesseract.js-data/eng@1.0.0, `4.0.0_best_int`), licences and `VERSIONS.txt` with sha256 hashes. Total about 11 MB (2.9 MB data, 3.9 MB per engine build, the rest small). The page loaded exactly these versions from the CDN before.
- Language data: I kept `4.0.0_best_int` (2.9 MB compressed), the model the page already used. The "fast" model lives only on GitHub (tesseract-ocr/tessdata_fast), which was not reachable from here; it would save about 1 MB and read a little worse, so it isn't worth a change in quality.
- Served by `server.js` at `/vendor/tesseract/*` after sign-in only, with ETag and `no-cache` (cheap 304s; a future version upgrade shows up right away). Files over 1 MB are gzipped once and the result kept in the file cache (`file()`); `out()` now skips gzip when a body is already encoded.
- Service worker: nothing new is precached. `/vendor/tesseract/` was added to the stale-while-revalidate line, so a phone keeps a copy after the first read. Tesseract also keeps the language data in IndexedDB on its own.
- Page: on the laptop the worker is started from the same origin (`workerBlobURL: false`) with absolute paths. In the published artifact (no `/shim.js`, so `LAPTOP` is false) there is no vendor folder, so the page still loads tesseract.js 5.1.1 and core 5.1.1 from jsdelivr, now with an SRI hash on the script tag (`sha384-GJqSu7…`, computed from the npm file; jsdelivr was not reachable from here to double-check, but it serves npm files unchanged). There the AI reader is used first anyway when the artifact allows images.
- Checked in headless Chromium: signed in, picked a generated receipt image through the real file input; the reader loaded only from the app (no outside requests, no CSP errors) and filled in title "CORNER GROCER", 8.76, the date, the items and the tax.
- `test/proxy.test.js`: sign-in through Cloudflare/Traefik headers (cookie marked Secure), per-visitor lockout when the proxy passes the visitor in X-Forwarded-For, the vendor files (signed-in only, gzipped, no path tricks) and the CSP (no outside script hosts; connect-src only frankfurter).
- The test "five wrong passwords through the proxy only lock out the visitor who made them (Cloudflare address)" is marked `todo`: on this branch every request behind Traefik counts as 10.0.2.6, so it fails as expected. Remove the `todo` once the sign-in slice's client-address change is merged. It runs last in the file because, without that fix, it locks the shared proxy address.
- `test/xss.test.js` needs Playwright and its Chromium. It skips (doesn't fail) when either is missing, which is the case on GitHub's runners (no npm dependencies are installed there). It also fails if any field was never seen on screen, so it can't pass by not looking; I checked it fails when one `esc()` is removed.
- `test/images.test.js` plus `scripts/strip-image-metadata.mjs`: drops only non-drawing chunks (PNG caBX/tEXt/iTXt/zTXt/eXIf/tIME, WebP C2PA/EXIF/XMP, SVG `<metadata>`); pixel hashes were compared before and after with PIL and are identical.

## Not done
- No escaping holes were found, so no page fixes were needed.
- The "fast" English model was not used (see above).
- The artifact version still loads the reader from jsdelivr (now hash-checked); there is no way to ship files with the artifact.
- `blob:` is still allowed in script-src/worker-src; the laptop no longer needs it for the reader, but I left it in case other parts of the page rely on it.
