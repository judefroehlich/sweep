// routes/products.ts
//
// Tracking endpoints. Every one of these is behind requireAuth — tracking
// requires an account, guests only get search and the deals feed.
//
// Tier caps are checked here against the wallet in the database, never against
// anything the client sends.

import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/auth.js";
import { checkProduct } from "../lib/priceChecker.js";
import { resolveProduct } from "../lib/resolveProduct.js";
import { SCRAPE_LIMIT } from "../lib/rateLimit.js";
import { prisma } from "../lib/prisma.js";
import { consumeManualCheck, getManualCheckState } from "../lib/quota.js";
import {
  isValidTimezone,
  nextCheckAt,
  nextIntervalCheckAt,
  normalizeCheckHours,
  normalizeCheckMinute,
} from "../lib/schedule.js";
import {
  type Tier,
  effectiveTier,
  historyCutoff,
  limitsFor,
  maxCheckMinute,
} from "../lib/tiers.js";
import { awardFirstTrack } from "../lib/xp.js";

/** Days of history behind the card sparkline. */
const TREND_DAYS = 30;
/** Points per card. A 120px line can't show more, and thinning happens here. */
const TREND_POINTS = 24;

export interface Trend {
  points: { checkedAt: string; price: number }[];
  low: number;
  high: number;
  days: number;
}

/**
 * Recent history for many products at once.
 *
 * One query for the whole list rather than one per card: a list of twenty is
 * twenty round trips otherwise, on the screen that opens first.
 *
 * Thinned evenly to TREND_POINTS. A tracked item checked every 30 minutes for
 * a month is ~1,400 readings, and sending those to draw a line 120 pixels wide
 * is most of the response for none of the picture.
 */
export async function recentTrends(productIds: string[], tier: Tier): Promise<Map<string, Trend>> {
  if (productIds.length === 0) return new Map();

  // Never further back than the tier allows, so this can't become a way to
  // read history the detail screen would hide.
  const tierCutoff = historyCutoff(tier);
  const windowStart = new Date(Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000);
  const since = tierCutoff && tierCutoff > windowStart ? tierCutoff : windowStart;

  const rows = await prisma.priceHistory.findMany({
    where: { productId: { in: productIds }, checkedAt: { gte: since } },
    orderBy: { checkedAt: "asc" },
    select: { productId: true, price: true, checkedAt: true },
  });

  const byProduct = new Map<string, { checkedAt: string; price: number }[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push({ checkedAt: row.checkedAt.toISOString(), price: row.price });
    byProduct.set(row.productId, list);
  }

  const out = new Map<string, Trend>();
  for (const [productId, points] of byProduct) {
    // One reading is a dot, not a trend, and drawing it as a flat line would
    // claim the price held steady for a month.
    if (points.length < 2) continue;
    const prices = points.map((p) => p.price);
    out.set(productId, {
      points: thin(points, TREND_POINTS),
      low: Math.min(...prices),
      high: Math.max(...prices),
      days: Math.ceil((Date.now() - new Date(points[0].checkedAt).getTime()) / (24 * 60 * 60 * 1000)),
    });
  }
  return out;
}

/** Evenly spaced sample, always keeping the first and last reading. */
function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

export async function productRoutes(app: FastifyInstance) {
  // ---- list everything the user tracks ----
  app.get("/products", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId!;

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return reply.status(404).send({ error: "No wallet for user" });

    const tracked = await prisma.trackedProduct.findMany({
      where: { userId },
      orderBy: { addedAt: "desc" },
      include: { product: true },
    });

    const limits = limitsFor(wallet);
    const trends = await recentTrends(tracked.map((t) => t.productId), effectiveTier(wallet));

    return {
      tracked: tracked.map((t) => ({
        id: t.id,
        addedAt: t.addedAt,
        customThreshold: t.customThreshold,
        lastNotifiedAt: t.lastNotifiedAt,
        // What it cost when they started, so the list can show movement since
        // rather than just today's number in isolation.
        priceAtTracking: t.priceAtTracking,
        // Enough history to draw a line on the card and say where today's
        // price sits in it. The list is the screen people actually live on,
        // and until now it answered "what does it cost" without ever
        // answering "is that good", which is the question tracking is for.
        trend: trends.get(t.productId) ?? null,
        product: serializeProduct(t.product),
      })),
      limits: {
        maxTrackedProducts: limits.maxTrackedProducts,
        used: tracked.length,
      },
      tier: effectiveTier(wallet),
    };
  });

  // ---- start tracking ----
  // Accepts either a pasted product url, or a retailer + retailerId pair as
  // returned by compiled search.
  app.post(
    "/products/track",
    {
      preHandler: requireAuth,
      config: { rateLimit: SCRAPE_LIMIT },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const body = (request.body ?? {}) as {
        url?: string;
        retailer?: string;
        retailerId?: string;
        // Optional: set the user's check schedule in the same call, so confirming
        // a product and choosing its times is one action rather than two that
        // can half-fail.
        checkHours?: unknown;
        timezone?: unknown;
      };

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      if (!wallet)
        return reply.status(404).send({ error: "No wallet for user" });

      const limits = limitsFor(wallet);

      // Cap check happens before any scraping — no point spending a call the
      // user isn't allowed to use.
      const trackedCount = await prisma.trackedProduct.count({
        where: { userId },
      });
      if (trackedCount >= limits.maxTrackedProducts) {
        return reply.status(403).send({
          error: `Your plan tracks up to ${limits.maxTrackedProducts} products.`,
          code: "TRACK_LIMIT_REACHED",
          limit: limits.maxTrackedProducts,
          tier: effectiveTier(wallet),
        });
      }

      // Resolve what we're being asked to track. Same helper the list route
      // uses — it knows to look up a stored url by (retailer, retailerId)
      // rather than synthesizing one, which is what broke Best Buy.
      const resolved = await resolveProduct(body);
      if (!resolved.ok) {
        return reply
          .status(resolved.status)
          .send({ error: resolved.error, code: resolved.code });
      }
      const product = resolved.product;

      // Apply the schedule chosen in the confirm dialog, if one was sent.
      if (body.checkHours !== undefined && limits.fixedCheckTimes) {
        const normalized = normalizeCheckHours(
          body.checkHours,
          limits.checkTimesPerDay,
        );
        if (!normalized.ok) {
          return reply
            .status(400)
            .send({ error: normalized.error, code: "INVALID_SCHEDULE" });
        }
        if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
          return reply
            .status(400)
            .send({ error: "Unrecognised timezone", code: "INVALID_TIMEZONE" });
        }
        await prisma.wallet.update({
          where: { userId },
          data: {
            checkHours: normalized.hours,
            ...(body.timezone !== undefined
              ? { timezone: body.timezone as string }
              : {}),
          },
        });
      }

      // Idempotent: tracking something twice is a no-op, not an error.
      const tracked = await prisma.trackedProduct.upsert({
        where: { userId_productId: { userId, productId: product.id } },
        create: {
          userId,
          productId: product.id,
          // Snapshot the price now so "since you started" has an anchor.
          priceAtTracking: product.currentPrice,
        },
        // Deliberately NOT updated on re-track: the anchor should stay the
        // moment they first started watching, not reset each time they revisit.
        update: {},
        include: { product: true },
      });

      // First-ever track is worth a small nudge — it's the moment the app starts
      // being useful, and it gives a brand-new leaderboard entry something to
      // show other than zero.
      const firstTrackAward = await awardFirstTrack(userId);

      return reply.status(201).send({
        xpAwarded: firstTrackAward,
        tracked: {
          id: tracked.id,
          addedAt: tracked.addedAt,
          customThreshold: tracked.customThreshold,
          product: serializeProduct(tracked.product),
        },
      });
    },
  );

  // ---- preview a pasted link, without tracking it ----
  //
  // Scrapes the product and returns what we found so the user can confirm it's
  // the right item before committing a tracking slot to it. The result is
  // written into the shared Product cache regardless — we paid for the scrape,
  // and the next person to paste the same link gets it free.
  app.post(
    "/products/preview",
    {
      preHandler: requireAuth,
      config: { rateLimit: SCRAPE_LIMIT },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const { url: rawUrl } = (request.body ?? {}) as { url?: string };

      if (!rawUrl) {
        return reply.status(400).send({ error: "Paste a product link first." });
      }

      const resolved = await resolveProduct({ url: rawUrl });
      if (!resolved.ok) {
        return reply
          .status(resolved.status)
          .send({ error: resolved.error, code: resolved.code });
      }
      const product = resolved.product;

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      if (!wallet)
        return reply.status(404).send({ error: "No wallet for user" });

      const limits = limitsFor(wallet);
      const trackedCount = await prisma.trackedProduct.count({
        where: { userId },
      });
      const alreadyTracking = await prisma.trackedProduct.findUnique({
        where: { userId_productId: { userId, productId: product.id } },
      });

      return {
        product: serializeProduct(product),
        alreadyTracking: Boolean(alreadyTracking),
        // Everything the confirm dialog needs to decide what to show, so it
        // doesn't have to guess the plan's rules client-side.
        limits: {
          maxTrackedProducts: limits.maxTrackedProducts,
          used: trackedCount,
          canTrack:
            alreadyTracking !== null ||
            trackedCount < limits.maxTrackedProducts,
          checkTimesPerDay: limits.checkTimesPerDay,
          fixedCheckTimes: limits.fixedCheckTimes,
          checkIntervalMinutes: limits.checkIntervalMinutes,
        },
        schedule: {
          checkHours: wallet.checkHours,
          timezone: wallet.timezone,
          nextCheckAt: limits.fixedCheckTimes
            ? nextCheckAt(wallet.checkHours, wallet.timezone)
            : null,
        },
        tier: effectiveTier(wallet),
      };
    },
  );

  // ---- read / update the user's check schedule ----
  app.get(
    "/me/schedule",
    { preHandler: requireAuth },
    async (request, reply) => {
      const wallet = await prisma.wallet.findUnique({
        where: { userId: request.userId! },
      });
      if (!wallet)
        return reply.status(404).send({ error: "No wallet for user" });

      const limits = limitsFor(wallet);

      return {
        checkHours: wallet.checkHours,
        checkMinute: wallet.checkMinute,
        timezone: wallet.timezone,
        maxCheckTimes: limits.checkTimesPerDay,
        maxCheckMinute: maxCheckMinute(effectiveTier(wallet)),
        fixedCheckTimes: limits.fixedCheckTimes,
        canSetCheckMinute: limits.canSetCheckMinute,
        checkIntervalMinutes: limits.checkIntervalMinutes,
        nextCheckAt: limits.fixedCheckTimes
          ? nextCheckAt(wallet.checkHours, wallet.timezone)
          : nextIntervalCheckAt(
              limits.checkIntervalMinutes,
              wallet.checkMinute,
              wallet.timezone,
            ),
        tier: effectiveTier(wallet),
      };
    },
  );

  app.put(
    "/me/schedule",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.userId!;
      const { checkHours, checkMinute, timezone } = (request.body ?? {}) as {
        checkHours?: unknown;
        checkMinute?: unknown;
        timezone?: unknown;
      };

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      if (!wallet)
        return reply.status(404).send({ error: "No wallet for user" });

      const limits = limitsFor(wallet);
      const tier = effectiveTier(wallet);

      if (timezone !== undefined && !isValidTimezone(timezone)) {
        return reply
          .status(400)
          .send({ error: "Unrecognised timezone", code: "INVALID_TIMEZONE" });
      }

      const data: {
        checkHours?: number[];
        checkMinute?: number;
        timezone?: string;
      } = {};

      if (timezone !== undefined) data.timezone = timezone as string;

      if (limits.fixedCheckTimes) {
        // Answer the question they actually asked. Falling through to the
        // checkHours validator here replies "checkHours must be an array",
        // which explains nothing to someone who sent a minute offset.
        if (checkMinute !== undefined && checkHours === undefined) {
          return reply.status(400).send({
            error:
              "Your plan picks whole hours to check at, not a minute offset. Upgrade to choose exact timing.",
            code: "SCHEDULE_NOT_APPLICABLE",
          });
        }

        // The count cap is the load guarantee — enforced here, never client-side.
        const normalized = normalizeCheckHours(
          checkHours,
          limits.checkTimesPerDay,
        );
        if (!normalized.ok) {
          return reply
            .status(400)
            .send({ error: normalized.error, code: "INVALID_SCHEDULE" });
        }
        data.checkHours = normalized.hours;
      } else if (limits.canSetCheckMinute && checkMinute !== undefined) {
        // Interval tiers don't pick hours — they pick where in each interval the
        // check lands, e.g. every 2 hours at :35.
        const normalized = normalizeCheckMinute(
          checkMinute,
          maxCheckMinute(tier),
        );
        if (!normalized.ok) {
          return reply
            .status(400)
            .send({ error: normalized.error, code: "INVALID_SCHEDULE" });
        }
        data.checkMinute = normalized.minute;
      } else if (checkMinute === undefined && checkHours !== undefined) {
        return reply.status(400).send({
          error: `Your plan checks automatically every ${limits.checkIntervalMinutes} minutes. You can choose the minute it lands on.`,
          code: "SCHEDULE_NOT_APPLICABLE",
        });
      }

      const updated = await prisma.wallet.update({ where: { userId }, data });

      return {
        checkHours: updated.checkHours,
        checkMinute: updated.checkMinute,
        timezone: updated.timezone,
        maxCheckTimes: limits.checkTimesPerDay,
        maxCheckMinute: maxCheckMinute(tier),
        nextCheckAt: limits.fixedCheckTimes
          ? nextCheckAt(updated.checkHours, updated.timezone)
          : nextIntervalCheckAt(
              limits.checkIntervalMinutes,
              updated.checkMinute,
              updated.timezone,
            ),
      };
    },
  );

  // ---- stop tracking ----
  app.delete<{ Params: { id: string } }>(
    "/products/track/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.userId!;

      // Scoped by userId so one user can't untrack another's item by guessing
      // an id.
      const deleted = await prisma.trackedProduct.deleteMany({
        where: { userId, id: request.params.id },
      });

      if (deleted.count === 0) {
        return reply.status(404).send({ error: "Not tracking that product" });
      }

      return { ok: true };
    },
  );

  // ---- product detail + price history ----
  app.get<{ Params: { id: string } }>(
    "/products/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.userId!;

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      if (!wallet)
        return reply.status(404).send({ error: "No wallet for user" });

      const product = await prisma.product.findUnique({
        where: { id: request.params.id },
      });
      if (!product)
        return reply.status(404).send({ error: "Product not found" });

      const tier = effectiveTier(wallet);
      const cutoff = historyCutoff(tier);

      const history = await prisma.priceHistory.findMany({
        where: {
          productId: product.id,
          ...(cutoff ? { checkedAt: { gte: cutoff } } : {}),
        },
        orderBy: { checkedAt: "asc" },
        select: { price: true, checkedAt: true },
      });

      const tracked = await prisma.trackedProduct.findUnique({
        where: { userId_productId: { userId, productId: product.id } },
      });

      // Total points ignoring the tier window, so the UI can honestly say
      // "42 more points on Pro" rather than pretending the data doesn't exist.
      const totalPoints = await prisma.priceHistory.count({
        where: { productId: product.id },
      });

      return {
        product: serializeProduct(product),
        history,
        stats: priceStats(
          history.map((h) => h.price),
          product.currentPrice,
        ),
        tracking: tracked
          ? { id: tracked.id, customThreshold: tracked.customThreshold }
          : null,
        historyWindow: {
          days: cutoff
            ? Math.round((Date.now() - cutoff.getTime()) / 86_400_000)
            : null,
          shown: history.length,
          total: totalPoints,
        },
      };
    },
  );

  // ---- custom alert threshold (Ultimate) ----
  app.patch<{ Params: { id: string } }>(
    "/products/track/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.userId!;
      const { customThreshold } = (request.body ?? {}) as {
        customThreshold?: unknown;
      };

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      if (!wallet)
        return reply.status(404).send({ error: "No wallet for user" });

      if (!limitsFor(wallet).customThresholds) {
        return reply.status(403).send({
          error: "Custom alert thresholds need Pro or Ultimate.",
          code: "TIER_REQUIRED",
          requiredTier: "pro",
        });
      }

      // Clearing the threshold is legitimate; anything else must be a sane
      // positive amount in cents. Type-checked, not just range-checked.
      let value: number | null = null;
      if (customThreshold !== null && customThreshold !== undefined) {
        if (
          typeof customThreshold !== "number" ||
          !Number.isInteger(customThreshold) ||
          customThreshold <= 0 ||
          customThreshold > 100_000_000 // $1M ceiling — a typo guard, not a real limit
        ) {
          return reply.status(400).send({
            error:
              "customThreshold must be a positive integer number of cents, or null",
          });
        }
        value = customThreshold;
      }

      const updated = await prisma.trackedProduct.updateMany({
        where: { userId, id: request.params.id },
        data: { customThreshold: value },
      });

      if (updated.count === 0) {
        return reply.status(404).send({ error: "Not tracking that product" });
      }

      return { ok: true, customThreshold: value };
    },
  );

  // ---- force a re-check ----
  //
  // "Check price now" in the app. Budget is per tier and enforced here:
  //   free     — 10 a day
  //   pro      — unlimited count, one every 30 minutes
  //   ultimate — unlimited
  app.post<{ Params: { id: string } }>(
    "/products/:id/refresh",
    {
      preHandler: requireAuth,
      config: { rateLimit: SCRAPE_LIMIT },
    },
    async (request, reply) => {
      const userId = request.userId!;

      const tracked = await prisma.trackedProduct.findFirst({
        where: { userId, productId: request.params.id },
        include: { product: true },
      });
      if (!tracked) {
        return reply.status(404).send({ error: "Not tracking that product" });
      }

      // If something already checked this product seconds ago — the scheduler,
      // or another user tracking the same item — serve that instead of
      // scraping again. Costs the user nothing from their budget, because they
      // still get a fresh answer.
      const lastChecked = tracked.product.lastCheckedAt;
      if (lastChecked && Date.now() - lastChecked.getTime() < 60_000) {
        return {
          status: "fresh",
          product: serializeProduct(tracked.product),
          manualChecks: await getManualCheckState(userId),
        };
      }

      const outcome = await consumeManualCheck(userId);
      if (!outcome) {
        return reply.status(404).send({ error: "No wallet for user" });
      }

      if (!outcome.ok) {
        const { state } = outcome;
        return reply.status(429).send(
          outcome.reason === "limit"
            ? {
                error: `You've used all ${state.limit} manual checks for today. They reset at midnight UTC.`,
                code: "MANUAL_CHECK_LIMIT_REACHED",
                manualChecks: state,
              }
            : {
                error: `Your plan allows one manual check every ${state.cooldownMinutes} minutes.`,
                code: "MANUAL_CHECK_COOLDOWN",
                manualChecks: state,
              },
        );
      }

      const result = await checkProduct(tracked.productId);
      const product = await prisma.product.findUnique({
        where: { id: tracked.productId },
      });

      return {
        status: result.status,
        product: product ? serializeProduct(product) : null,
        manualChecks: outcome.state,
      };
    },
  );

  // ---- how many manual checks do I have left? ----
  app.get(
    "/products/manual-checks",
    { preHandler: requireAuth },
    async (request, reply) => {
      const state = await getManualCheckState(request.userId!);
      if (!state)
        return reply.status(404).send({ error: "No wallet for user" });
      return { manualChecks: state };
    },
  );
}

// ---- helpers ---------------------------------------------------------------

function serializeProduct(product: {
  id: string;
  retailer: string;
  retailerId: string;
  url: string;
  title: string;
  imageUrl: string | null;
  currentPrice: number | null;
  listPrice: number | null;
  currency: string;
  availability: string | null;
  rating: number | null;
  ratingCount: number | null;
  lastCheckedAt: Date | null;
  lastStatus: string | null;
}) {
  return {
    id: product.id,
    retailer: product.retailer,
    retailerId: product.retailerId,
    url: product.url,
    title: product.title,
    imageUrl: product.imageUrl,
    price: product.currentPrice,
    listPrice: product.listPrice,
    currency: product.currency,
    availability: product.availability,
    rating: product.rating,
    ratingCount: product.ratingCount,
    lastCheckedAt: product.lastCheckedAt,
    lastStatus: product.lastStatus,
  };
}

/**
 * The numbers the detail screen shows, and the same basis XP will use in pass
 * 2 ("% below historical average"). Computed from the points the caller is
 * allowed to see, so a free user's "average" reflects their 30-day window.
 */
function priceStats(prices: number[], currentPrice: number | null) {
  if (prices.length === 0) {
    return { low: null, high: null, average: null, percentBelowAverage: null };
  }

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const average = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

  const percentBelowAverage =
    currentPrice !== null && average > 0
      ? Math.round(((average - currentPrice) / average) * 100)
      : null;

  return { low, high, average, percentBelowAverage };
}
