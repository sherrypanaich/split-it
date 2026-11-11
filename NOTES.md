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
