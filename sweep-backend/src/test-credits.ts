// src/test-credits.ts — counting paid scraping credits, and alerting before they run out.
//   npm run test:credits
//
// What this has to get right: each threshold emails once, not on every request
// past it; a new month resets Bright Data but never Decodo; and a correction
// typed in from the provider's dashboard doesn't email about where it landed.
import "./testEnv.js";
import { levelFor, periodFor, composeAlert, type ProviderCreditSummary } from "./lib/providerCredits.js";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok && detail !== undefined) console.log("     ", JSON.stringify(detail));
};

console.log("\n— thresholds —");
check("under half is no alert", levelFor(999, 2000) === 0);
check("exactly half is 50", levelFor(1000, 2000) === 50);
check("69.9% is still 50", levelFor(1398, 2000) === 50);
check("70% is 70", levelFor(1400, 2000) === 70);
check("90% is 90", levelFor(4500, 5000) === 90);
check("all of it is 100", levelFor(5000, 5000) === 100);
check("past all of it is 100", levelFor(5200, 5000) === 100);
check("a zero allowance can't divide by zero", levelFor(10, 0) === 0);

console.log("\n— periods —");
const sept = new Date("2026-09-30T23:59:00Z");
const oct = new Date("2026-10-01T00:01:00Z");
check("Decodo never rolls over", periodFor("decodo", sept) === "total" && periodFor("decodo", oct) === "total");
check("Bright Data is per month", periodFor("brightdata", sept) === "2026-09");
check("and rolls at UTC midnight on the 1st", periodFor("brightdata", oct) === "2026-10");

console.log("\n— the email —");
const sample: ProviderCreditSummary = {
  provider: "decodo", label: "Decodo", serves: "Walmart", window: "total",
  used: 1400, allowance: 2000, remaining: 600, percent: 70, perDay: 300, daysLeft: 2, syncedAt: null,
};
const warn = composeAlert(sample, 70);
check("the subject says how much is left", warn.subject.includes("70%") && warn.subject.includes("600"), warn.subject);
check("the body says how long that lasts", warn.body.includes("2 days"), warn.body);
check("and that it never refills", warn.body.includes("one-time"));
const gone = composeAlert({ ...sample, used: 2000, remaining: 0, percent: 100, daysLeft: 0 }, 100);
check("at 100% it says the store is down", gone.subject.includes("Walmart is down"), gone.subject);
const fast = composeAlert({ ...sample, daysLeft: 0.25 }, 70);
check("a fast burn is said in hours", fast.body.includes("6 hours"), fast.body);

// ---- the round trip, against the dev database ----
const { prisma } = await import("./lib/prisma.js");
const { recordProviderUse, syncProviderCredits, getProviderCredits } = await import("./lib/providerCredits.js");

// Every alert goes through sendAdminAlert, which logs "[alert]" whether or not
// SMTP is configured. Counting those lines counts the emails.
let alerts: string[] = [];
const realError = console.error, realLog = console.log;
const capture = (fn: typeof console.log) => (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (text.includes("[alert]")) alerts.push(text);
  else fn(...args);
};

const saved = await prisma.providerCredit.findMany();
const savedDays = await prisma.providerCreditDay.findMany();
try {
  await prisma.providerCredit.deleteMany();
  await prisma.providerCreditDay.deleteMany();
  console.error = capture(realError);
  console.log = capture(realLog);

  console.log("\n— counting —");
  await recordProviderUse("decodo");
  await recordProviderUse("decodo");
  let [decodo] = (await getProviderCredits()).filter((p) => p.provider === "decodo");
  check("two requests count two", decodo.used === 2, decodo.used);
  check("against the free allowance", decodo.allowance === 2000, decodo.allowance);
  check("and today's pace is recorded", decodo.perDay > 0, decodo.perDay);

  await Promise.all(Array.from({ length: 25 }, () => recordProviderUse("decodo")));
  [decodo] = (await getProviderCredits()).filter((p) => p.provider === "decodo");
  check("25 at once lose none", decodo.used === 27, decodo.used);

  await recordProviderUse("brightdata", 4);
  const [bd] = (await getProviderCredits()).filter((p) => p.provider === "brightdata");
  check("a four-result search is four records", bd.used === 4, bd.used);
  check("nothing has alerted yet", alerts.length === 0, alerts);

  console.log("\n— syncing from the provider's number —");
  const synced = await syncProviderCredits("brightdata", { remaining: 4867 });
  check("4,867 left of 5,000 is 133 used", synced.used === 133 && synced.remaining === 4867, synced);
  check("and it's marked synced", synced.syncedAt !== null);
  await syncProviderCredits("decodo", { used: 1390 });
  check("syncing just under 70% sends nothing", alerts.length === 0, alerts);
  let threw = false;
  try { await syncProviderCredits("decodo", { remaining: 5000 }); } catch { threw = true; }
  check("more left than the allowance is refused", threw);

  console.log("\n— alerting —");
  // 1390 + 10 = 1400, exactly 70%. Crossed by several requests at once.
  await Promise.all(Array.from({ length: 10 }, () => recordProviderUse("decodo")));
  const at70 = alerts.filter((a) => a.includes("Decodo")).length;
  check("crossing 70% emails once, even when ten requests cross it together", at70 === 1, alerts);
  await recordProviderUse("decodo", 5);
  check("and the next request past it doesn't email again", alerts.filter((a) => a.includes("Decodo")).length === 1, alerts);
  await recordProviderUse("decodo", 400);
  check("90% is its own email", alerts.filter((a) => a.includes("Decodo")).length === 2, alerts);

  console.log("\n— a new month —");
  // Pretend Bright Data's row is from last month, already alerted at 90.
  await prisma.providerCredit.update({ where: { provider: "brightdata" }, data: { period: "2026-08", used: 4800, alertedLevel: 90 } });
  const before = (await getProviderCredits()).find((p) => p.provider === "brightdata")!;
  check("last month's count doesn't show as this month's", before.used === 0, before.used);
  await recordProviderUse("brightdata", 1);
  const row = await prisma.providerCredit.findUnique({ where: { provider: "brightdata" } });
  check("the first request of the month starts from zero", row?.used === 1 && row.period === periodFor("brightdata"), row);
  check("and the alerts are armed again", row?.alertedLevel === 0, row?.alertedLevel);
  check("and the allowance set earlier is kept", (await getProviderCredits()).find((p) => p.provider === "brightdata")!.allowance === 5000);
} finally {
  console.error = realError;
  console.log = realLog;
  await prisma.providerCredit.deleteMany();
  await prisma.providerCreditDay.deleteMany();
  if (saved.length) await prisma.providerCredit.createMany({ data: saved });
  if (savedDays.length) await prisma.providerCreditDay.createMany({ data: savedDays });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
