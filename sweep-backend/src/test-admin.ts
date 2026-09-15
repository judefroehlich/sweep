// test-admin.ts — the admin portal's guards and numbers.
//   npm run test:admin
//
// The portal can only read, so the risk isn't corruption — it's exposure. Every
// number here is about the business, and the heaviest-use table has real email
// addresses in it, so the auth checks matter more than the arithmetic.
import "./testEnv.js";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { prisma } from "./lib/prisma.js";
import { adminRoutes } from "./routes/admin.js";
import { getAdminStats } from "./lib/adminStats.js";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok && detail !== undefined) console.log("     ", JSON.stringify(detail).slice(0, 300));
};

const KEY = "test-admin-key-0123456789";
process.env.ADMIN_API_KEY = KEY;

const app = Fastify();
await app.register(adminRoutes);

try {
  console.log("\n— the page itself —");
  const page = await app.inject({ method: "GET", url: "/admin" });
  check("serves without a key", page.statusCode === 200, page.statusCode);
  check("contains no data, only the login form", !page.body.includes("heaviest\":"), "leaked data");
  check("asks search engines not to index it", page.body.includes("noindex"));

  console.log("\n— the page's own JavaScript parses —");
  // This page is built inside a TypeScript template literal, so every
  // backslash has to be doubled. Getting one wrong drops a real line break
  // into a JS string and kills the WHOLE script — the sign-in button stops
  // working because of a typo in an announcement template hundreds of lines
  // away, with nothing on screen to say so. It happened twice.
  //
  // node --check on the extracted script is the only thing that catches it
  // without opening a browser.
  const script = page.body.slice(
    page.body.indexOf("<script>") + 8,
    page.body.lastIndexOf("</script>"),
  );
  check("there is a script to check", script.length > 500, script.length);

  const tmp = `${tmpdir()}/sweep-admin-page-${Date.now()}.js`;
  writeFileSync(tmp, script);
  let syntaxError: string | null = null;
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (err) {
    syntaxError = String((err as { stderr?: Buffer }).stderr ?? err).slice(0, 400);
  } finally {
    rmSync(tmp, { force: true });
  }
  check("it parses as valid JavaScript", syntaxError === null, syntaxError);

  // The handlers wired to onclick must actually exist, or the buttons are
  // decoration. A parse error is one way to lose them; a rename is another.
  for (const fn of ["signIn", "signOut", "announce", "useTemplate", "counts", "load", "makeCode", "loadPromo", "dropCode", "runProbe"]) {
    check(`${fn}() is defined`, new RegExp(`function ${fn}\\s*\\(`).test(script));
  }

  console.log("\n— stats are guarded —");
  const noKey = await app.inject({ method: "GET", url: "/admin/stats" });
  check("no key is refused", noKey.statusCode === 401, noKey.statusCode);

  const wrong = await app.inject({
    method: "GET", url: "/admin/stats", headers: { "x-admin-key": "wrong-key-same-length!!" },
  });
  check("wrong key is refused", wrong.statusCode === 401, wrong.statusCode);

  const shortKey = await app.inject({
    method: "GET", url: "/admin/stats", headers: { "x-admin-key": "x" },
  });
  check("a short key doesn't crash the comparison", shortKey.statusCode === 401, shortKey.statusCode);

  const right = await app.inject({
    method: "GET", url: "/admin/stats", headers: { "x-admin-key": KEY },
  });
  check("the right key is accepted", right.statusCode === 200, right.statusCode);

  console.log("\n— promo codes are guarded —");
  const promoNoKey = await app.inject({ method: "GET", url: "/admin/promo" });
  check("listing needs the key", promoNoKey.statusCode === 401, promoNoKey.statusCode);

  const makeNoKey = await app.inject({
    method: "POST", url: "/admin/promo", payload: { tier: "pro", days: 14 },
  });
  check("creating needs the key", makeNoKey.statusCode === 401, makeNoKey.statusCode);

  const made = await app.inject({
    method: "POST",
    url: "/admin/promo",
    headers: { "x-admin-key": KEY },
    payload: { tier: "pro", days: 14, maxRedemptions: 5 },
  });
  check("creating works with the key", made.statusCode === 200, made.statusCode);
  const createdCode: string | undefined = made.json().code;
  check("and returns the code", typeof createdCode === "string" && createdCode.length >= 4, createdCode);

  const bad = await app.inject({
    method: "POST",
    url: "/admin/promo",
    headers: { "x-admin-key": KEY },
    payload: { tier: "free", days: 14 },
  });
  check("a free-tier code is rejected", bad.statusCode === 400, bad.statusCode);

  const listed = await app.inject({
    method: "GET", url: "/admin/promo", headers: { "x-admin-key": KEY },
  });
  check("listing works with the key", listed.statusCode === 200, listed.statusCode);
  check("the new code is in the list",
    listed.json().codes.some((c: { code: string }) => c.code === createdCode));

  console.log("\n— deleting a code —");
  const delNoKey = await app.inject({ method: "DELETE", url: `/admin/promo/${createdCode}` });
  check("deleting needs the key", delNoKey.statusCode === 401, delNoKey.statusCode);

  const delMissing = await app.inject({
    method: "DELETE", url: "/admin/promo/NOSUCHCODE", headers: { "x-admin-key": KEY },
  });
  check("deleting something that isn't there is a 404", delMissing.statusCode === 404, delMissing.statusCode);

  const deleted = await app.inject({
    method: "DELETE", url: `/admin/promo/${createdCode}`, headers: { "x-admin-key": KEY },
  });
  check("deleting works with the key", deleted.statusCode === 200, deleted.statusCode);

  const afterDelete = await app.inject({
    method: "GET", url: "/admin/promo", headers: { "x-admin-key": KEY },
  });
  check("and it's gone from the list",
    !afterDelete.json().codes.some((c: { code: string }) => c.code === createdCode));

  if (createdCode) {
    await prisma.promoCode.deleteMany({ where: { code: createdCode } });
  }

  console.log("\n— the probe is guarded —");
  const probeNoKey = await app.inject({
    method: "POST", url: "/admin/probe", payload: { url: "https://example.com/" },
  });
  check("needs the key", probeNoKey.statusCode === 401, probeNoKey.statusCode);

  const probeNoUrl = await app.inject({
    method: "POST", url: "/admin/probe", headers: { "x-admin-key": KEY }, payload: {},
  });
  check("needs a url", probeNoUrl.statusCode === 400, probeNoUrl.statusCode);

  // The one that matters. Behind the admin key sits the cloud metadata service,
  // which hands credentials to anything that can reach it.
  const probeMeta = await app.inject({
    method: "POST",
    url: "/admin/probe",
    headers: { "x-admin-key": KEY },
    payload: { url: "http://169.254.169.254/latest/meta-data/" },
  });
  check("refuses the metadata service even WITH the key", probeMeta.json().refused !== null, probeMeta.json());
  check("and never sends the request", probeMeta.json().status === null);

  console.log("\n— refuses when unconfigured —");
  delete process.env.ADMIN_API_KEY;
  const unset = await app.inject({
    method: "GET", url: "/admin/stats", headers: { "x-admin-key": KEY },
  });
  // Defaulting open would expose every user's email to anyone who guessed the
  // path, on a deploy where someone forgot one environment variable.
  check("no key configured means 503, not open", unset.statusCode === 503, unset.statusCode);
  process.env.ADMIN_API_KEY = KEY;

  console.log("\n— the numbers hold together —");
  const stats = await getAdminStats();
  check("every field is present", Boolean(stats.users && stats.tiers && stats.usage && stats.retailers));
  check(
    "tier counts sum to the number of wallets",
    stats.tiers.free + stats.tiers.pro + stats.tiers.ultimate === (await prisma.wallet.count()),
    stats.tiers,
  );
  check("new today never exceeds the total", stats.users.newToday <= stats.users.total);
  check("new today never exceeds new this week", stats.users.newToday <= stats.users.newThisWeek);
  check("every retailer appears", stats.retailers.length >= 5, stats.retailers.length);
  check(
    "success rates are a fraction or null",
    stats.retailers.every((r) => r.successRate === null || (r.successRate >= 0 && r.successRate <= 1)),
  );
  check(
    "the metered ceiling is searches plus lookups",
    stats.usage.meteredCeiling === stats.usage.searchesToday + stats.usage.lookupsToday,
  );
  console.log("\n— provider credits —");
  check("every metered provider is reported", stats.providers.length >= 2, stats.providers.length);
  for (const p of stats.providers) {
    check(`${p.label} names the store it serves`, Boolean(p.serves));
    check(`${p.label} usage is a real count`, Number.isInteger(p.used) && p.used >= 0, p.used);
    check(`${p.label} has an allowance`, p.allowance > 0, p.allowance);
    check(`${p.label} percent is 0-100`, p.percent >= 0 && p.percent <= 100, p.percent);
    check(`${p.label} remaining is allowance minus used`, p.remaining === Math.max(0, p.allowance - p.used));
  }

  console.log("\n— the week —");
  check("seven days, always", stats.trend.length === 7, stats.trend.length);
  check("oldest first", stats.trend[0].date < stats.trend[6].date, stats.trend.map((d) => d.date));
  // Quiet days must be zeroes rather than gaps: a missing bar reads as "no
  // data", which is the opposite news from "no signups".
  check("no gaps", stats.trend.every((d) => Number.isInteger(d.signups) && Number.isInteger(d.checks)));
  const days = new Set(stats.trend.map((d) => d.date));
  check("no duplicate days", days.size === 7, [...days]);

  console.log("\n— the probe verdict needs prices, not markers —");
// Target's search page carries __NEXT_DATA__ and zero prices: 224 bytes of
// pageProps, everything real fetched client-side from an API that 403s. The
// verdict accepted markers OR prices and called that "with product data",
// which is the one wrong answer that costs a day rather than a minute.
const probeView = (await import("node:fs")).readFileSync(
  new URL("./routes/admin.ts", import.meta.url), "utf8");
check("a green verdict needs a price",
  /d\.priceish > 0\) \{ headline = "Reachable, with product data"/.test(probeView));
check("markers alone are only amber",
  /d\.markers\.length\) \{ headline = "Reachable, but the prices are not in the HTML"/.test(probeView));
check("and it says what to do about it",
  /renders its products in the browser/.test(probeView));

console.log("\n— revenue —");
  check("MRR is tiers times list price",
    Math.abs(stats.revenue.monthly - (stats.tiers.pro * stats.revenue.pro + stats.tiers.ultimate * stats.revenue.ultimate)) < 0.001,
    stats.revenue);
  check("prices match the pricing table", stats.revenue.pro === 5.99 && stats.revenue.ultimate === 11.99, stats.revenue);

  check("heaviest list is bounded", stats.heaviest.length <= 8, stats.heaviest.length);
} finally {
  await app.close();
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
