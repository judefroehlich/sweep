// src/test-reauth.ts — who is allowed to delete an account.
//   npm run test:reauth
//
// Deletion is irreversible, so it asks for proof the person holding the phone
// is the account holder: a password, or a sign-in from the last ten minutes.
// The second route exists because Google accounts have no password, and
// without it they could not delete their account at all — which Google Play
// requires to be possible.
//
// The dangerous direction is letting something through, so most of this file
// is the refusals.
import "./testEnv.js";
import { secondsSinceSignIn } from "./lib/auth.js";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok && detail !== undefined) console.log("     ", JSON.stringify(detail));
};

/** A JWT-shaped string. Signature is junk on purpose: the helper must not be the thing checking it. */
function token(payload: object): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signature`;
}
const now = () => Math.floor(Date.now() / 1000);

console.log("\n— a recent sign-in counts —");
const fresh = secondsSinceSignIn(token({ amr: [{ method: "oauth", timestamp: now() - 30 }] }));
check("google, thirty seconds ago", fresh !== null && fresh >= 29 && fresh <= 32, fresh);

const pw = secondsSinceSignIn(token({ amr: [{ method: "password", timestamp: now() - 120 }] }));
check("password, two minutes ago", pw !== null && pw >= 119 && pw <= 122, pw);

console.log("\n— the newest authentication is the one that counts —");
// An account can carry several entries, e.g. an old password sign-in and a
// fresh Google one. Taking the oldest would lock out someone who did just
// sign in; taking the newest is the honest reading.
const mixed = secondsSinceSignIn(token({
  amr: [
    { method: "password", timestamp: now() - 60 * 60 * 24 * 30 },
    { method: "oauth", timestamp: now() - 45 },
  ],
}));
check("uses the most recent entry", mixed !== null && mixed < 60, mixed);

console.log("\n— anything unclear is not recent —");
// Null has to mean "refuse". A helper that returned 0 for a missing claim
// would read as "signed in this instant" and wave everything through.
check("no amr claim", secondsSinceSignIn(token({ sub: "x" })) === null);
check("empty amr", secondsSinceSignIn(token({ amr: [] })) === null);
check("amr with no timestamps", secondsSinceSignIn(token({ amr: [{ method: "oauth" }] })) === null);
check("a string where a number goes", secondsSinceSignIn(token({ amr: [{ timestamp: "now" }] })) === null);
check("not a jwt at all", secondsSinceSignIn("nope") === null);
check("empty string", secondsSinceSignIn("") === null);
check("garbage payload", secondsSinceSignIn("a.!!!notbase64!!!.c") === null);

console.log("\n— old sessions are old —");
const stale = secondsSinceSignIn(token({ amr: [{ method: "oauth", timestamp: now() - 60 * 60 * 24 * 7 }] }));
check("a week ago is a week ago", stale !== null && stale > 60 * 60 * 24 * 6, stale);

// A clock skewed into the future must not produce a negative age that then
// sails under any threshold.
const future = secondsSinceSignIn(token({ amr: [{ method: "oauth", timestamp: now() + 3600 }] }));
check("a timestamp in the future is not negative", future === 0, future);

console.log("\n— the route —");
const route = (await import("node:fs")).readFileSync(new URL("./routes/auth.ts", import.meta.url), "utf8");
check("refuses without a password or a recent sign-in", /REAUTH_REQUIRED/.test(route));
check("treats an unreadable claim as a refusal", /age === null \|\| age > RECENT_SIGN_IN_SECONDS/.test(route));
check("still verifies a password when one is given", /hasPassword\s*\?\s*await verifyPassword/.test(route));
check("the window is ten minutes", /RECENT_SIGN_IN_SECONDS = 10 \* 60/.test(route));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
