// lib/siteVisits.ts
//
// Counting visits to the public site.
//
// ---- what this deliberately does not know ----
//
// No IP, no cookie, no session, no fingerprint. A visit becomes a +1 on a row
// keyed by (day, path, referrer host) and nothing else is kept.
//
// That is a real limitation and worth stating plainly: this counts VISITS, not
// visitors. It cannot tell one person visiting ten times from ten people
// visiting once, and it never will without storing something that identifies
// somebody. The landing page it counts says the app has no data to sell, and
// the honest version of that claim is having none to sell.
//
// It also means the table grows with days and pages rather than with traffic.
// A good month is a few hundred rows.

import { prisma } from "./prisma.js";

/**
 * Obvious non-humans.
 *
 * Most raw hits on a public site are crawlers, and counting them turns the
 * number into noise — a quiet week with a Googlebot sweep looks like a good
 * one. This is the cheap half of the problem: a substring match on the user
 * agent catches everything that identifies itself honestly, which is most
 * bots, because crawlers generally want to be recognised.
 *
 * It will not catch anything pretending to be a browser. Nothing short of
 * fingerprinting does, and fingerprinting is the thing this file exists to
 * avoid.
 */
const BOT_MARKERS = [
  "bot", "crawl", "spider", "slurp", "facebookexternalhit", "embedly",
  "quora link preview", "pinterest", "vkshare", "w3c_validator", "whatsapp",
  "flipboard", "tumblr", "bitlybot", "skypeuripreview", "nuzzel", "discord",
  "google-inspectiontool", "chrome-lighthouse", "headlesschrome", "phantomjs",
  "curl/", "wget/", "python-requests", "go-http-client", "axios/", "node-fetch",
  "postman", "insomnia", "monitoring", "uptime", "pingdom", "statuscake",
];

export function looksLikeABot(userAgent: string | undefined): boolean {
  if (!userAgent) return true; // A browser always sends one.
  const ua = userAgent.toLowerCase();
  return BOT_MARKERS.some((marker) => ua.includes(marker));
}

/**
 * The referring site, reduced to a host.
 *
 * Never the full url: referrers carry search terms, campaign tags and
 * occasionally a path somebody should not have shared. The host answers the
 * only question worth asking — did this come from Reddit — and nothing else.
 */
export function referrerHost(referer: string | undefined): string {
  if (!referer) return "direct";
  try {
    const host = new URL(referer).hostname.replace(/^www\./, "");
    // Our own pages linking to each other are not a referral.
    if (host.endsWith("sweepshopping.com")) return "direct";
    return host.slice(0, 120);
  } catch {
    return "direct";
  }
}

/** Midnight UTC, so a day is the same day everywhere. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Record one visit.
 *
 * Never throws and never blocks the response. A page that fails to load
 * because the counter had a bad day would be a poor trade for knowing how many
 * people loaded it.
 */
export async function recordVisit(
  rawPath: string,
  userAgent: string | undefined,
  referer: string | undefined,
): Promise<void> {
  if (looksLikeABot(userAgent)) return;

  // Query string dropped: it carries campaign tags, and on a link somebody
  // pasted, occasionally more than that.
  const path = (rawPath.split("?")[0] || "/").slice(0, 120);
  const referrer = referrerHost(referer);

  try {
    await prisma.siteVisit.upsert({
      where: { day_path_referrer: { day: today(), path, referrer } },
      create: { day: today(), path, referrer, count: 1 },
      update: { count: { increment: 1 } },
    });
  } catch {
    // Counting is not worth an error path. A lost visit is a lost visit.
  }
}

export interface VisitSummary {
  today: number;
  last7: number;
  last30: number;
  /** Newest first, for a small chart. */
  daily: { day: string; count: number }[];
  topPages: { path: string; count: number }[];
  topReferrers: { referrer: string; count: number }[];
}

export async function getVisitSummary(): Promise<VisitSummary> {
  const since = new Date(today());
  since.setUTCDate(since.getUTCDate() - 29);

  const rows = await prisma.siteVisit.findMany({
    where: { day: { gte: since } },
    orderBy: { day: "desc" },
  });

  const dayTotals = new Map<string, number>();
  const pageTotals = new Map<string, number>();
  const refTotals = new Map<string, number>();

  for (const row of rows) {
    const key = row.day.toISOString().slice(0, 10);
    dayTotals.set(key, (dayTotals.get(key) ?? 0) + row.count);
    pageTotals.set(row.path, (pageTotals.get(row.path) ?? 0) + row.count);
    refTotals.set(row.referrer, (refTotals.get(row.referrer) ?? 0) + row.count);
  }

  const todayKey = today().toISOString().slice(0, 10);
  const sevenAgo = new Date(today());
  sevenAgo.setUTCDate(sevenAgo.getUTCDate() - 6);

  let last7 = 0;
  for (const [key, count] of dayTotals) {
    if (new Date(key) >= sevenAgo) last7 += count;
  }

  const top = (map: Map<string, number>, limit: number) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));

  return {
    today: dayTotals.get(todayKey) ?? 0,
    last7,
    last30: [...dayTotals.values()].reduce((a, b) => a + b, 0),
    daily: [...dayTotals.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, count]) => ({ day, count })),
    topPages: top(pageTotals, 8).map(({ name, count }) => ({ path: name, count })),
    topReferrers: top(refTotals, 8).map(({ name, count }) => ({ referrer: name, count })),
  };
}
