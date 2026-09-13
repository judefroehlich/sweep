// src/test-visits.ts — counting visits to the public site.
//   npm run test:visits
//
// The bot filter and the referrer handling, which are the two places this can
// quietly go wrong: a crawler sweep turns a quiet week into a good one, and a
// referrer stored whole carries whatever someone typed into a search box.
import "./testEnv.js";
import { looksLikeABot, referrerHost } from "./lib/siteVisits.js";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok && detail !== undefined) console.log("     ", JSON.stringify(detail));
};

console.log("\n— real browsers count —");
for (const [name, ua] of [
  ["chrome on windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"],
  ["safari on iphone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"],
  ["chrome on android", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"],
  ["firefox", "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"],
] as const) check(name, !looksLikeABot(ua));

console.log("\n— crawlers and tools do not —");
for (const [name, ua] of [
  ["googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
  ["bingbot", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"],
  ["facebook preview", "facebookexternalhit/1.1"],
  ["curl", "curl/8.4.0"],
  ["python", "python-requests/2.31.0"],
  ["headless chrome", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0"],
  ["uptime monitor", "Mozilla/5.0 (compatible; UptimeRobot/2.0)"],
] as const) check(name, looksLikeABot(ua));

// A browser always sends one. Something that does not is not a person.
check("a missing user agent", looksLikeABot(undefined));

console.log("\n— a referrer reduces to a host, and nothing more —");
check("reddit", referrerHost("https://www.reddit.com/r/SideProject/comments/abc/") === "reddit.com");
check("www is dropped", referrerHost("https://www.google.com/search?q=anything") === "google.com");
// The point of storing the host alone: a search term must not end up in the
// database because somebody arrived from Google.
check(
  "and the query goes with it",
  !referrerHost("https://www.google.com/search?q=my-private-search").includes("private"),
);
check("our own pages are not referrals", referrerHost("https://sweepshopping.com/#pricing") === "direct");
check("nor our subdomains", referrerHost("https://api.sweepshopping.com/health") === "direct");
check("no referrer is direct", referrerHost(undefined) === "direct");
check("junk is direct, not a crash", referrerHost("not a url") === "direct");

// ---- the round trip, against the dev database ----
//
// The filter and the parser are pure functions and easy to be confident about.
// The part worth actually running is the upsert: a second visit to the same
// page on the same day must increment a row rather than insert another.
const { prisma } = await import("./lib/prisma.js");
const { recordVisit, getVisitSummary } = await import("./lib/siteVisits.js");

const PATH = `/__test-${Date.now()}`;
try {
  await recordVisit(PATH, "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36", "https://www.reddit.com/r/x/");
  await recordVisit(PATH, "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36", "https://www.reddit.com/r/y/");
  await recordVisit(PATH, "Googlebot/2.1", "https://www.reddit.com/r/x/");

  const rows = await prisma.siteVisit.findMany({ where: { path: PATH } });
  console.log("\n— recording —");
  check("two visits from one referrer make one row", rows.length === 1, rows.length);
  check("and that row counts two", rows[0]?.count === 2, rows[0]?.count);
  check("the crawler was not counted", (rows[0]?.count ?? 0) === 2);
  check("the day is stored, not the time", rows[0]?.day.toISOString().endsWith("T00:00:00.000Z") === true);
  check("nothing identifying is stored", Object.keys(rows[0] ?? {}).sort().join(",") === "count,day,id,path,referrer");

  await recordVisit(PATH, "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36", undefined);
  const both = await prisma.siteVisit.findMany({ where: { path: PATH } });
  check("a different referrer makes a second row", both.length === 2, both.length);

  const summary = await getVisitSummary();
  console.log("\n— reading it back —");
  check("the summary counts today", summary.today >= 3, summary.today);
  check("and lists the page", summary.topPages.some((p) => p.path === PATH));
  check("and where it came from", summary.topReferrers.some((r) => r.referrer === "reddit.com"));
} finally {
  await prisma.siteVisit.deleteMany({ where: { path: PATH } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
