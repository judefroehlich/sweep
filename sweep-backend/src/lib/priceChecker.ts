// lib/priceChecker.ts
//
// The shared-cache principle: one Product row per unique item across the whole
// app, checked once, served to everyone tracking it. Cost scales with distinct
// products tracked, not with signups — which is the difference between a
// feature that survives growth and one that doesn't.

import { prisma } from "./prisma.js";
import { adapters } from "./scrapers/index.js";
import { type Retailer, type ScrapedProduct, isRetailer } from "./scrapers/types.js";
import { recordCheck } from "./health.js";
import { backoffMultiplier, effectiveIntervalMinutes } from "./backoff.js";
import { isDueAtFixedTimes, isDueAtInterval } from "./schedule.js";
import {
  TIER_LIMITS,
  WALLET_TIER_SELECT,
  type Tier,
} from "./tiers.js";

export interface CheckOutcome {
  productId: string;
  retailer: Retailer;
  status: "success" | "failed" | "blocked";
  previousPrice: number | null;
  newPrice: number | null;
  detail?: string;
}

/**
 * Re-check one product and persist the result.
 *
 * Writes a PriceHistory row only when the price actually changed. Storing an
 * identical point every 30 minutes would bloat the table and flatten the chart
 * without adding information — a price is a step function, so only the steps
 * are worth recording.
 */
/**
 * How long a steady price may go unrecorded.
 *
 * Twenty hours, not twenty-four: checks drift, and a strict day would skip
 * whole days whenever a sweep ran slightly earlier than the one before.
 */
export const HISTORY_HEARTBEAT_MS = 20 * 60 * 60 * 1000;

/**
 * Whether this reading is worth a row.
 *
 * Any change is. An unchanged price is worth one a day, which bounds the table
 * at roughly one row per product per day while still drawing a real line.
 */
export function shouldRecordHistory(
  newPrice: number,
  latest: { price: number; checkedAt: Date } | null,
  now = new Date(),
): boolean {
  if (!latest) return true;
  if (latest.price !== newPrice) return true;
  return now.getTime() - latest.checkedAt.getTime() >= HISTORY_HEARTBEAT_MS;
}

export async function checkProduct(productId: string): Promise<CheckOutcome> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    throw new Error(`checkProduct: no product ${productId}`);
  }

  if (!isRetailer(product.retailer)) {
    throw new Error(`checkProduct: unknown retailer ${product.retailer}`);
  }

  const retailer = product.retailer;
  const result = await adapters[retailer].scrapeProduct(product.url);

  await recordCheck({
    retailer,
    status: result.status,
    productId,
    detail: result.status === "success" ? null : result.detail,
    durationMs: result.durationMs,
  });

  if (result.status !== "success") {
    // Record that we tried and failed, but leave currentPrice alone — a stale
    // real price is more useful than a null, and blanking it would make the
    // product look free.
    await prisma.product.update({
      where: { id: productId },
      data: { lastCheckedAt: new Date(), lastStatus: result.status },
    });

    return {
      productId,
      retailer,
      status: result.status,
      previousPrice: product.currentPrice,
      newPrice: null,
      detail: result.detail,
    };
  }

  const scraped = result.data;
  const previousPrice = product.currentPrice;
  const newPrice = scraped.price;

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: productId },
      data: {
        title: scraped.title,
        imageUrl: scraped.imageUrl ?? product.imageUrl,
        currentPrice: newPrice,
        listPrice: scraped.listPrice,
        currency: scraped.currency,
        availability: scraped.availability,
        rating: scraped.rating,
        ratingCount: scraped.ratingCount,
        sellerRating: scraped.sellerRating,
        sellerRatingCount: scraped.sellerRatingCount,
        lastCheckedAt: new Date(),
        lastStatus: "success",
        // Any real movement resets the backoff immediately — the item is back
        // at full check rate on the very next sweep.
        unchangedChecks:
          newPrice !== null && newPrice === previousPrice
            ? { increment: 1 }
            : 0,
      },
    });

    if (newPrice !== null) {
      // A reading a day even when nothing moved. Recording only changes meant
      // a steady price left ONE row in the table forever: the detail chart drew
      // a single dot, the card had no line, and "a price history Sweep keeps
      // itself" was not true for any product that held its price. A flat line
      // is information — it is the difference between "it hasn't dropped" and
      // "we haven't looked".
      const latest = await tx.priceHistory.findFirst({
        where: { productId },
        orderBy: { checkedAt: "desc" },
        select: { price: true, checkedAt: true },
      });

      if (shouldRecordHistory(newPrice, latest)) {
        await tx.priceHistory.create({
          data: { productId, price: newPrice },
        });
      }
    }
  });

  return { productId, retailer, status: "success", previousPrice, newPrice };
}

/**
 * Find products due for a check.
 *
 * A product's due interval is the SHORTEST interval among the tiers of the
 * users tracking it — if one Ultimate user wants 30-minute checks, everyone
 * tracking that item gets the fresher data for free. That's a deliberate
 * consequence of the shared cache, and it costs nothing extra.
 *
 * Untracked products are skipped entirely: no user, no reason to spend a call.
 */
export async function findDueProducts(limit = 200): Promise<string[]> {
  const tracked = await prisma.trackedProduct.findMany({
    select: {
      productId: true,
      product: {
        select: {
          lastCheckedAt: true,
          retailer: true,
          unchangedChecks: true,
        },
      },
      user: {
        select: {
          wallet: {
            select: {
              ...WALLET_TIER_SELECT,
              checkHours: true,
              checkMinute: true,
              timezone: true,
            },
          },
        },
      },
    },
  });

  const nowDate = new Date();
  const now = nowDate.getTime();

  // A product is due if ANY of its trackers wants it checked now. Two kinds of
  // tracker want different things: free users have fixed times of day, paid
  // users have a rolling interval. Evaluating per-tracker and OR-ing means one
  // Ultimate user keeps an item fresh for everyone tracking it, which is the
  // shared cache working as intended.
  const dueProducts = new Map<string, { overdueBy: number; priority: boolean }>();

  for (const row of tracked) {
    const wallet = row.user.wallet;
    const tier = resolveTier(wallet);
    const limits = TIER_LIMITS[tier];
    const last = row.product.lastCheckedAt;

    // Adaptive backoff: a product that keeps coming back at the same price is
    // checked progressively less often, up to a hard ceiling.
    const multiplier = backoffMultiplier(row.product.unchangedChecks);

    let isDue: boolean;
    let overdueBy: number;

    if (limits.fixedCheckTimes) {
      isDue = isDueAtFixedTimes(
        last,
        wallet?.checkHours ?? [],
        wallet?.timezone ?? "UTC",
        nowDate,
      );

      // Fixed-time tiers back off by skipping scheduled slots rather than by
      // moving them, so "9am and 9pm" still means 9am and 9pm — a stable item
      // just doesn't get checked at every one of them.
      if (isDue && multiplier > 1 && last) {
        const minGapMs =
          effectiveIntervalMinutes(
            limits.checkIntervalMinutes,
            row.product.unchangedChecks,
          ) *
          60 *
          1000;
        if (now - last.getTime() < minGapMs) isDue = false;
      }
      // Fixed-time checks don't have a meaningful "how late" — order them by
      // staleness so the longest-neglected go first.
      overdueBy = last ? now - last.getTime() : Number.MAX_SAFE_INTEGER;
    } else {
      // Interval tiers check at fixed clock slots (every N minutes past local
      // midnight, offset by the user's chosen minute) rather than "N minutes
      // after the last run" — which would drift a little later every day.
      isDue = isDueAtInterval(
        last,
        effectiveIntervalMinutes(
          limits.checkIntervalMinutes,
          row.product.unchangedChecks,
        ),
        wallet?.checkMinute ?? 0,
        wallet?.timezone ?? "UTC",
        nowDate,
      );
      overdueBy = last ? now - last.getTime() : Number.MAX_SAFE_INTEGER;
    }

    if (!isDue) continue;

    const existing = dueProducts.get(row.productId);
    dueProducts.set(row.productId, {
      overdueBy: Math.max(existing?.overdueBy ?? -Infinity, overdueBy),
      priority: (existing?.priority ?? false) || limits.priorityQueue,
    });
  }

  const due = [...dueProducts.entries()].map(([productId, info]) => ({
    productId,
    ...info,
  }));

  // Ultimate's promised "priority queue": their items run before everyone
  // else's when the batch is larger than one run can absorb. Within the same
  // priority band, the most overdue goes first.
  due.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    return b.overdueBy - a.overdueBy;
  });

  return due.slice(0, limit).map((d) => d.productId);
}

function resolveTier(
  wallet: { tier: string; tierExpiresAt: Date | null } | null,
): Tier {
  if (!wallet) return "free";
  const claimed = wallet.tier as Tier;
  if (!(claimed in TIER_LIMITS)) return "free";
  if (claimed !== "free" && wallet.tierExpiresAt && wallet.tierExpiresAt < new Date()) {
    return "free";
  }
  return claimed;
}

/**
 * Check a batch of products with bounded concurrency.
 *
 * Concurrency is per-retailer, not global: hammering one retailer with 20
 * parallel requests is what gets an IP blocked, while 20 requests spread over
 * five retailers is fine. Metered retailers (Amazon) run at 1 to keep the
 * Bright Data spend predictable.
 */
export async function checkProducts(productIds: string[]): Promise<CheckOutcome[]> {
  if (productIds.length === 0) return [];

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, retailer: true },
  });

  const byRetailer = new Map<string, string[]>();
  for (const p of products) {
    const list = byRetailer.get(p.retailer) ?? [];
    list.push(p.id);
    byRetailer.set(p.retailer, list);
  }

  const results = await Promise.all(
    [...byRetailer.entries()].map(([retailer, ids]) => {
      // Pacing is a property of the retailer, not a guess made here — see the
      // notes on each adapter in lib/scrapers/index.ts.
      const adapter = isRetailer(retailer) ? adapters[retailer] : null;
      return runWithConcurrency(
        ids,
        adapter?.concurrency ?? 1,
        adapter?.minIntervalMs ?? 0,
      );
    }),
  );

  return results.flat();
}

async function runWithConcurrency(
  productIds: string[],
  concurrency: number,
  minIntervalMs = 0,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  const queue = [...productIds];

  // Shared across workers so the gap is between requests to the retailer, not
  // between requests from one worker.
  let nextAllowedAt = 0;

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) return;

      if (minIntervalMs > 0) {
        const wait = nextAllowedAt - Date.now();
        nextAllowedAt = Math.max(Date.now(), nextAllowedAt) + minIntervalMs;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

      try {
        outcomes.push(await checkProduct(id));
      } catch (err) {
        console.error(`[priceChecker] ${id} threw:`, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );

  return outcomes;
}

/**
 * Upsert a scraped product into the shared cache, seeding its first price
 * point. Used when a user tracks something we've never seen before.
 */
export async function upsertScrapedProduct(scraped: ScrapedProduct) {
  const product = await prisma.product.upsert({
    where: {
      retailer_retailerId: {
        retailer: scraped.retailer,
        retailerId: scraped.retailerId,
      },
    },
    create: {
      retailer: scraped.retailer,
      retailerId: scraped.retailerId,
      url: scraped.url,
      title: scraped.title,
      imageUrl: scraped.imageUrl,
      currentPrice: scraped.price,
      listPrice: scraped.listPrice,
      currency: scraped.currency,
      availability: scraped.availability,
      rating: scraped.rating,
      ratingCount: scraped.ratingCount,
      sellerRating: scraped.sellerRating,
      sellerRatingCount: scraped.sellerRatingCount,
      lastCheckedAt: new Date(),
      lastStatus: "success",
    },
    update: {
      title: scraped.title,
      imageUrl: scraped.imageUrl,
      currentPrice: scraped.price,
      listPrice: scraped.listPrice,
      availability: scraped.availability,
      rating: scraped.rating,
      ratingCount: scraped.ratingCount,
      sellerRating: scraped.sellerRating,
      sellerRatingCount: scraped.sellerRatingCount,
      lastCheckedAt: new Date(),
      lastStatus: "success",
    },
  });

  // Seed history so a brand-new product charts a point immediately rather than
  // waiting for its first scheduled change.
  if (scraped.price !== null) {
    const latest = await prisma.priceHistory.findFirst({
      where: { productId: product.id },
      orderBy: { checkedAt: "desc" },
    });
    if (!latest || latest.price !== scraped.price) {
      await prisma.priceHistory.create({
        data: { productId: product.id, price: scraped.price },
      });
    }
  }

  return product;
}

/**
 * Write search results into the shared Product cache.
 *
 * Search hands back fully-scraped products that we then threw away, which had
 * two costs. The obvious one: adding a search result to a list re-scraped a
 * page we'd just read. The sharper one: some retailers can't be re-read on
 * demand at all. Best Buy's product pages don't load from datacenter IPs, so
 * its scraper falls back to searching for the name in the url slug — and a
 * long slug makes a bad query, so the item you were looking at a second ago
 * comes back "couldn't reach it".
 *
 * Caching the results makes add-to-list and track resolve straight out of the
 * database with no scrape at all, which is both more reliable and faster.
 *
 * Deliberately does NOT seed price history. History exists to chart products
 * someone is tracking; writing a row for every result of every search would
 * fill that table with items nobody ever looks at again.
 */
export async function cacheSearchResults(products: ScrapedProduct[]) {
  await Promise.all(
    products.map((scraped) =>
      prisma.product
        .upsert({
          where: {
            retailer_retailerId: {
              retailer: scraped.retailer,
              retailerId: scraped.retailerId,
            },
          },
          create: {
            retailer: scraped.retailer,
            retailerId: scraped.retailerId,
            url: scraped.url,
            title: scraped.title,
            imageUrl: scraped.imageUrl,
            currentPrice: scraped.price,
            listPrice: scraped.listPrice,
            currency: scraped.currency,
            availability: scraped.availability,
            rating: scraped.rating,
            ratingCount: scraped.ratingCount,
            sellerRating: scraped.sellerRating,
            sellerRatingCount: scraped.sellerRatingCount,
            lastCheckedAt: new Date(),
            lastStatus: "success",
          },
          update: {
            // Refresh the url too: retailers change their slugs, and a stale
            // one is exactly what breaks the scrapers that read them.
            url: scraped.url,
            title: scraped.title,
            imageUrl: scraped.imageUrl,
            currentPrice: scraped.price,
            listPrice: scraped.listPrice,
            availability: scraped.availability,
            rating: scraped.rating,
            ratingCount: scraped.ratingCount,
            sellerRating: scraped.sellerRating,
            sellerRatingCount: scraped.sellerRatingCount,
            lastCheckedAt: new Date(),
            lastStatus: "success",
          },
        })
        // One bad row shouldn't fail a search that otherwise worked.
        .catch(() => null),
    ),
  );
}
