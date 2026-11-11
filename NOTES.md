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
