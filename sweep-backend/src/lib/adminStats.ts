// lib/adminStats.ts
//
// The numbers behind the admin dashboard.
//
// Everything here is a read. Nothing in this file can change anything, which
// is deliberate — a dashboard that can only look is a dashboard that can't be
// the cause of an outage.
//
// The point of it is the questions that currently have no answer without
// opening a database client: how many people are using this, what is it
// costing, and is anything broken right now.

import { prisma } from "./prisma.js";
import { RETAILERS, RETAILER_LABELS, type Retailer } from "./scrapers/types.js";
import { cooldownRemaining } from "./scrapers/cooldown.js";
import { isRetailerEnabled } from "./scrapers/index.js";
import { WALLET_TIER_SELECT, effectiveTier } from "./tiers.js";
import { PRICING } from "./plans.js";
import { getProviderCredits, type ProviderCreditSummary } from "./providerCredits.js";

export interface AdminStats {
  users: { total: number; newToday: number; newThisWeek: number };
  /** Tier counts, using the effective tier so expired subscriptions read free. */
  tiers: { free: number; pro: number; ultimate: number };
  usage: {
    searchesToday: number;
    lookupsToday: number;
    tracked: number;
    /**
     * Amazon calls today, roughly — the only number here that maps to money.
     * A search and a lookup each cost at most one Bright Data record, and
     * caching means the real figure is lower. This is the ceiling.
     */
    meteredCeiling: number;
  };
  retailers: {
    retailer: Retailer;
    label: string;
    enabled: boolean;
    coolingSeconds: number | null;
    successRate: number | null;
    checks: number;
  }[];
  /**
   * Who used the most today.
   *
   * Not an abuse list — every allowance is capped, so nobody here has taken
   * more than they were given. It answers "who is driving the bill", which is
   * a different and more useful question.
   */
  heaviest: { email: string; tier: string; searches: number; lookups: number }[];
  notifications: { sentToday: number; unreadTotal: number };
  /**
   * What we are spending with the providers that charge, and how much is left.
   *
   * The number that was missing. Everything else here answers "is it working";
   * this answers "when does it stop working", which on a free tier is a
   * deadline rather than a gauge. Running out of Decodo credits takes Walmart
   * down, and the first sign of it today is the store failing.
   */
  providers: ProviderCreditSummary[];
  /**
   * Seven days of signups and checks, oldest first.
   *
   * Everything else on this page is "today", which cannot answer the only
   * question that matters in a launch week: is this going up.
   */
  trend: { date: string; signups: number; checks: number }[];
  /** Monthly recurring revenue, estimated from tier counts at list price. */
  revenue: { monthly: number; pro: number; ultimate: number };
  generatedAt: string;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function getAdminStats(): Promise<AdminStats> {
  const today = startOfToday();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // UTC midnight, not local. Postgres date_trunc buckets in UTC and the keys
  // below are built from toISOString, so anchoring this to local midnight put
  // the two a few hours apart — enough for the oldest day to fall outside the
  // window and render as an empty bar next to real data.
  const nowUtc = new Date();
  const sevenDaysAgo = new Date(
    Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()) -
      6 * 24 * 60 * 60 * 1000,
  );
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [
    total,
    newToday,
    newThisWeek,
    wallets,
    tracked,
    checks,
    heaviestRows,
    notificationsToday,
    unread,
    providers,
    signupRows,
    checkRows,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: today } } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.wallet.findMany({
      select: {
        ...WALLET_TIER_SELECT,
        searchesUsedToday: true,
        searchesResetAt: true,
        sweepsUsedToday: true,
        sweepsResetAt: true,
      },
    }),
    prisma.trackedProduct.count(),
    prisma.scrapeCheck.groupBy({
      by: ["retailer", "status"],
      where: { checkedAt: { gte: hourAgo } },
      _count: { _all: true },
    }),
    prisma.wallet.findMany({
      where: { OR: [{ searchesUsedToday: { gt: 0 } }, { sweepsUsedToday: { gt: 0 } }] },
      orderBy: [{ searchesUsedToday: "desc" }, { sweepsUsedToday: "desc" }],
      take: 8,
      select: {
        ...WALLET_TIER_SELECT,
        searchesUsedToday: true,
        sweepsUsedToday: true,
        user: { select: { email: true } },
      },
    }),
    prisma.notification.count({ where: { createdAt: { gte: today } } }),
    prisma.notification.count({ where: { readAt: null } }),

    // Counted where each billed request is made, not from ScrapeCheck, which
    // misses most of them. See lib/providerCredits.ts.
    getProviderCredits(),

    // Seven days of signups, one row per day.
    prisma.$queryRaw<{ day: Date; n: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS n
      FROM "User"
      WHERE "createdAt" >= ${sevenDaysAgo}
      GROUP BY 1 ORDER BY 1
    `,
    prisma.$queryRaw<{ day: Date; n: bigint }[]>`
      SELECT date_trunc('day', "checkedAt") AS day, COUNT(*) AS n
      FROM "ScrapeCheck"
      WHERE "checkedAt" >= ${sevenDaysAgo}
      GROUP BY 1 ORDER BY 1
    `,
  ]);

  const tiers = { free: 0, pro: 0, ultimate: 0 };
  let searchesToday = 0;
  let lookupsToday = 0;

  for (const wallet of wallets) {
    tiers[effectiveTier(wallet)] += 1;
    // Counters that haven't rolled over yet are from a previous day and would
    // otherwise inflate today's totals.
    if (wallet.searchesResetAt > today) searchesToday += wallet.searchesUsedToday;
    if (wallet.sweepsResetAt > today) lookupsToday += wallet.sweepsUsedToday;
  }

  return {
    users: { total, newToday, newThisWeek },
    tiers,
    usage: {
      searchesToday,
      lookupsToday,
      tracked,
      meteredCeiling: searchesToday + lookupsToday,
    },
    retailers: RETAILERS.map((retailer) => {
      const rows = checks.filter((c) => c.retailer === retailer);
      const totalChecks = rows.reduce((sum, r) => sum + r._count._all, 0);
      const ok = rows.find((r) => r.status === "success")?._count._all ?? 0;
      const cooling = cooldownRemaining(retailer);
      return {
        retailer,
        label: RETAILER_LABELS[retailer],
        enabled: isRetailerEnabled(retailer),
        coolingSeconds: cooling > 0 ? Math.ceil(cooling / 1000) : null,
        successRate: totalChecks === 0 ? null : ok / totalChecks,
        checks: totalChecks,
      };
    }),
    heaviest: heaviestRows.map((row) => ({
      email: row.user.email,
      tier: effectiveTier(row),
      searches: row.searchesUsedToday,
      lookups: row.sweepsUsedToday,
    })),
    notifications: { sentToday: notificationsToday, unreadTotal: unread },

    providers,

    trend: buildTrend(sevenDaysAgo, signupRows, checkRows),

    // List price times head count. Deliberately not net of Play's cut or of
    // anything granted by a promo code — it is a scale check, not accounting,
    // and labelling it as an estimate is cheaper than pretending otherwise.
    revenue: {
      monthly:
        tiers.pro * (PRICING.pro.monthly ?? 0) +
        tiers.ultimate * (PRICING.ultimate.monthly ?? 0),
      pro: PRICING.pro.monthly ?? 0,
      ultimate: PRICING.ultimate.monthly ?? 0,
    },

    generatedAt: new Date().toISOString(),
  };
}

/**
 * Seven dated buckets, including the days nothing happened.
 *
 * The zero days are the point: a gap in a series reads as "no data" when it
 * actually means "no signups", and those are opposite pieces of news.
 */
function buildTrend(
  from: Date,
  signups: { day: Date; n: bigint }[],
  checks: { day: Date; n: bigint }[],
): { date: string; signups: number; checks: number }[] {
  const key = (d: Date) => d.toISOString().slice(0, 10);
  const signupBy = new Map(signups.map((r) => [key(r.day), Number(r.n)]));
  const checkBy = new Map(checks.map((r) => [key(r.day), Number(r.n)]));

  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const k = key(day);
    return { date: k, signups: signupBy.get(k) ?? 0, checks: checkBy.get(k) ?? 0 };
  });
}
