// lib/health.ts
//
// Scraper health monitoring, built in from day one rather than bolted on after
// something breaks silently. The failure mode this exists to prevent is: a
// retailer changes their page structure, the scraper quietly returns nothing,
// and nobody notices until users complain that prices are stale.
//
// Two halves:
//   1. recordCheck() — every price check writes its outcome, success or not.
//   2. runHealthCheck() — a scheduled sweep over recent outcomes that emails
//      once per incident when a retailer's failure rate crosses the threshold.

import { sendAdminAlert } from "./alertEmail.js";
import { prisma } from "./prisma.js";
import { RETAILERS, type Retailer, type ScrapeStatus } from "./scrapers/types.js";

/** Share of recent checks that must fail before we alert. */
const FAILURE_RATE_THRESHOLD = 0.5;
/** Don't alert off a tiny sample — two failures out of two proves nothing. */
const MIN_SAMPLE_SIZE = 5;
/** How far back a health sweep looks. */
const WINDOW_MINUTES = 60;
/** Silence between repeat alerts for the same still-broken retailer. */
const REALERT_AFTER_MINUTES = 6 * 60;

export interface RetailerHealth {
  retailer: Retailer;
  total: number;
  failed: number;
  blocked: number;
  failureRate: number;
  healthy: boolean;
  lastDetail: string | null;
}

/**
 * Record the outcome of one price check. Called on every check — this is not
 * extra scraping work, just writing down what already happened.
 */
export async function recordCheck(params: {
  retailer: Retailer;
  status: ScrapeStatus;
  productId?: string | null;
  detail?: string | null;
  durationMs?: number;
}): Promise<void> {
  try {
    await prisma.scrapeCheck.create({
      data: {
        retailer: params.retailer,
        status: params.status,
        productId: params.productId ?? null,
        detail: params.detail?.slice(0, 2000) ?? null,
        durationMs: params.durationMs ?? null,
      },
    });
  } catch (err) {
    // Health logging must never be the thing that breaks a price check.
    console.error("[health] failed to record check:", err);
  }
}

/** Failure stats per retailer over the recent window. */
export async function getHealthReport(
  windowMinutes = WINDOW_MINUTES,
): Promise<RetailerHealth[]> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  const grouped = await prisma.scrapeCheck.groupBy({
    by: ["retailer", "status"],
    where: { checkedAt: { gte: since } },
    _count: { _all: true },
  });

  return Promise.all(
    RETAILERS.map(async (retailer) => {
      const rows = grouped.filter((g) => g.retailer === retailer);
      const countOf = (status: ScrapeStatus) =>
        rows.find((r) => r.status === status)?._count._all ?? 0;

      const success = countOf("success");
      const failed = countOf("failed");
      const blocked = countOf("blocked");
      const total = success + failed + blocked;
      const failureRate = total === 0 ? 0 : (failed + blocked) / total;

      // Only fetch the explanatory detail for retailers we'd actually report
      // on — no point querying five error bodies to print one.
      const lastDetail =
        failureRate > 0
          ? (
              await prisma.scrapeCheck.findFirst({
                where: {
                  retailer,
                  status: { in: ["failed", "blocked"] },
                  checkedAt: { gte: since },
                },
                orderBy: { checkedAt: "desc" },
                select: { detail: true },
              })
            )?.detail ?? null
          : null;

      return {
        retailer,
        total,
        failed,
        blocked,
        failureRate,
        // Too small a sample counts as healthy — we'd rather miss one hour of
        // a real outage than cry wolf on three checks.
        healthy: total < MIN_SAMPLE_SIZE || failureRate < FAILURE_RATE_THRESHOLD,
        lastDetail,
      };
    }),
  );
}

/**
 * Run a health sweep and email about newly-unhealthy retailers.
 * Alerts are deduped per retailer: one email per incident, not one per failed
 * check — a flood of emails is as useless as no alert at all.
 */
export async function runHealthCheck(): Promise<RetailerHealth[]> {
  const report = await getHealthReport();

  for (const health of report) {
    const alert = await prisma.scraperAlert.findUnique({
      where: { retailer: health.retailer },
    });

    if (health.healthy) {
      // Recovered — clear the open incident so the next break alerts again.
      if (alert && !alert.resolvedAt) {
        await prisma.scraperAlert.update({
          where: { retailer: health.retailer },
          data: { resolvedAt: new Date() },
        });
        console.log(`[health] ${health.retailer} recovered`);
      }
      continue;
    }

    const isOpenIncident = alert && !alert.resolvedAt;
    const staleEnoughToRepeat =
      alert &&
      Date.now() - alert.lastAlertAt.getTime() >
        REALERT_AFTER_MINUTES * 60 * 1000;

    if (isOpenIncident && !staleEnoughToRepeat) continue;

    await sendAlertEmail(health);

    await prisma.scraperAlert.upsert({
      where: { retailer: health.retailer },
      create: { retailer: health.retailer, lastAlertAt: new Date() },
      update: { lastAlertAt: new Date(), resolvedAt: null },
    });
  }

  return report;
}

// ---- email -----------------------------------------------------------------

async function sendAlertEmail(health: RetailerHealth) {
  const pct = Math.round(health.failureRate * 100);
  const subject = `[Sweep] ${health.retailer} scraper failing (${pct}%)`;

  // The raw detail goes in the body on purpose: it's the difference between
  // "page structure changed" and "we're being blocked", and having it here
  // means not re-debugging from scratch to find out which.
  const body = [
    `Retailer:      ${health.retailer}`,
    `Failure rate:  ${pct}% over the last ${WINDOW_MINUTES} minutes`,
    `Checks:        ${health.total} total — ${health.failed} failed, ${health.blocked} blocked`,
    ``,
    `Most recent failure detail:`,
    health.lastDetail ?? "(none recorded)",
    ``,
    health.blocked > health.failed
      ? `Mostly BLOCKED — anti-bot layer is rejecting us. Retrying won't help; this needs a proxy or a provider.`
      : `Mostly FAILED — likely a page structure change. Run: npm run test:scrapers`,
  ].join("\n");

  await sendAdminAlert(subject, body);
}
