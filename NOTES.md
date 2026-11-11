# Release notes: sign-in and request safety

## Improved
- You stay signed in while you use Split it: each day you open it, your sign-in runs another 90 days. Nobody is signed out by the update.
- Connecting an assistant: if you're already signed in to Split it in that browser, one tap on "Allow" is enough. No password to type.
- People who sign in only with Google can now connect an assistant (sign in to Split it first from the connect page, then tap Allow).
- The connect page shows the address your key will be sent to, in large type, so a look-alike app is easy to spot.
- Too many wrong passwords for one person now slows sign-in down for a short while instead of locking that person out.

## Fixed
- Behind a proxy (Docker, Coolify, Traefik, Cloudflare), five wrong passwords from one person no longer lock everyone out for 15 minutes. Split it now counts tries per real visitor.
- New assistants can always connect: apps that signed up but never finished connecting are cleared after a day, and when the list is full the oldest unused ones make room.

## Security
- Sign-in tokens are stored hashed, so a copy of a backup can't be used to sign in as anyone.
- Changing your email asks for your current password (or a code from your authenticator app). If you sign in only with Google, it works within 10 minutes of signing in.
- Requests that change things are refused when they come from another website's page.
- Each address can sign up at most 20 assistant apps an hour.
- Assistant keys and connections nobody used for 90 days stop working. The profile already shows when each was last used.
- A request passed on by a proxy is never treated as coming from the laptop itself.

## For the README

### Running behind a proxy
If Split it runs behind Docker, Traefik, Coolify, Caddy, nginx or a Cloudflare tunnel, every request reaches it from the proxy's address. Split it then reads the visitor's real address from the proxy's headers (`CF-Connecting-IP` from Cloudflare, otherwise the right-most outside address in `X-Forwarded-For`), and uses it for the wrong-password limits. It believes those headers only when the request comes from this computer or a private network address (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, loopback). If your proxy has a fixed address, set `TRUSTED_PROXY` to it so nothing else is believed. Make sure the app's own port is not reachable from outside without the proxy (for example bind it, or the proxy's ports, to 127.0.0.1 when a tunnel is the only way in), since anyone who can reach a trusted address directly can claim any visitor address.

Set `PUBLIC_URL` to the address people open. Writes from a browser are accepted only from that address or from the address the request was sent to.

Setting: `TRUSTED_PROXY` — addresses or ranges of your proxies, comma separated (e.g. `10.0.2.6,172.18.0.0/16`). Empty: this computer and private network addresses. `none`: never believe forwarded headers.

### Assistant keys
Keys and assistant connections that nobody uses for 90 days stop working; make a new one in your profile if that happens.

## For Budget it (copying accounts.js)
accounts.js now also exports, next to the factory function: `sessionKey(token)` (sha256 hex), `sessionGet(store, token)`, `sessionPut(store, token, rec)`, `sessionDrop(store, token)`, `migrateSessions(store)` (hashes plain keys once and sets `store.sessionsHashed`; returns true when the store must be saved) and `slideSession(rec, days)` (pushes `exp` at most once a day; true when the cookie should be sent again). The handle now also exposes `startSession(req, res, uid)`. Budget it's server.js needs to: call `migrateSessions(users)` after loading users.json and save if it returns true; look sessions up with `sessionGet`; pass a hashed key (`sessionKey(cookie)`) as `keep` to `endSessions` and in its stream map; drop on sign-out with `sessionDrop`; set `users.sessionsHashed = true` after a restore that keeps current sessions; make `tooManyTries(req)` address-only and pass `slowDown(uid)` (a promise that waits, or null) in `h`; and make its `setCookie` append rather than replace other Set-Cookie headers. accounts.js accepts `?next=/path` on `/auth/google` and returns there after a Google sign-in.

## Not done
- Linking a Google account from the profile (`/auth/google?mode=link`) still needs only a signed-in session, so an unlocked borrowed phone could link someone else's Google. Out of this slice; worth the same "fresh sign-in" rule later.
- `CF-Connecting-IP` is believed whenever the direct peer is a trusted (private) address. If Traefik's ports are open on the home wifi, someone there could send their own `CF-Connecting-IP`. The per-account slow-down still limits guessing; binding Traefik to 127.0.0.1 (from the review) closes it fully.
- The 20-per-hour assistant sign-up limit is kept in memory, so it resets on restart.
