// Reads the lifetime total from GitHub Sponsors and writes funding.json for the landing page.
// Needs SPONSORS_TOKEN (a GitHub token that can read sponsorship data) and SPONSORS_LOGIN (the user or org being sponsored).
// Optional START_MONTH (YYYY-MM): the month the hosted server started, shown first on the 12-month strip.
import { readFile, writeFile } from 'node:fs/promises';

const token = process.env.SPONSORS_TOKEN, login = process.env.SPONSORS_LOGIN;
if (!token || !login) { console.error('Set SPONSORS_TOKEN and SPONSORS_LOGIN.'); process.exit(1); }

const query = `query($login: String!, $after: String) {
  repositoryOwner(login: $login) {
    ... on Sponsorable {
      lifetimeReceivedSponsorshipValues(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { amountInCents }
      }
    }
  }
}`;

let cents = 0, after = null;
do {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'split-it-funding' },
    body: JSON.stringify({ query, variables: { login, after } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) { console.error('GitHub said:', JSON.stringify(json.errors || json)); process.exit(1); }
  const page = json.data?.repositoryOwner?.lifetimeReceivedSponsorshipValues;
  if (!page) { console.error(`No sponsorship data for "${login}". Check the login and the token's access.`); process.exit(1); }
  for (const n of page.nodes) cents += n.amountInCents || 0;
  after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (after);

const file = new URL('../docs/funding.json', import.meta.url);
let old = {};
try { old = JSON.parse(await readFile(file, 'utf8')); } catch {}
const raised = Math.round(cents) / 100;
const startMonth = process.env.START_MONTH || old.startMonth || null;
if (old.raised === raised && old.startMonth === startMonth) { console.log(`No change: $${raised}`); process.exit(0); }
await writeFile(file, JSON.stringify({ raised, currency: 'USD', startMonth, updatedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`Updated: $${raised}`);
