// lib/providerCredits.ts
//
// How much of the paid scraping allowance is left, and an email before it runs out.
//
// Running out isn't a bill, it's an outage: when Decodo's credits are gone,
// Walmart stops answering, and before this the first sign would have been the
// store failing for everyone at once. On a free tier that is most likely to
// happen on the best day, when a video sends a crowd.
//
// Usage is counted where the billed request is made (decodo.ts, amazon.ts)
// rather than read back from ScrapeCheck. The check log only covers some
// paths, and against the providers' own dashboards it came to less than half
// the real number, so anything built on it would have warned too late.

import { prisma } from "./prisma.js";
import { sendAdminAlert } from "./alertEmail.js";

export type Provider = "decodo" | "brightdata";

interface ProviderConfig {
  label: string;
  /** The store it serves, so an alert says what breaks. */
  serves: string;
  /** "total" never refills. "monthly" resets on the 1st, UTC. */
  window: "total" | "monthly";
  /** The free-tier allowance, used until one is set from the dashboard. */
  defaultAllowance: number;
  /** Older configuration, still honoured if it's set on Railway. */
  envVar: string;
}

export const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
  decodo: {
    label: "Decodo",
    serves: "Walmart",
    window: "total",
    defaultAllowance: 2000,
    envVar: "DECODO_CREDITS",
  },
  brightdata: {
    label: "Bright Data",
    serves: "Amazon",
    window: "monthly",
    defaultAllowance: 5000,
    envVar: "BRIGHTDATA_CREDITS",
  },
};

export const PROVIDERS = Object.keys(PROVIDER_CONFIG) as Provider[];

/**
 * The percentages that send an email, once each per period.
 *
 * 50 is there for the good-day case: at 70% of Decodo's 2,000 there are 600
 * requests left, which a busy afternoon can use up before anyone reads an email.
 */
export const ALERT_LEVELS = [50, 70, 90, 100] as const;

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && value in PROVIDER_CONFIG;
}

/** Which allowance period `now` falls in. */
export function periodFor(provider: Provider, now = new Date()): string {
  if (PROVIDER_CONFIG[provider].window === "total") return "total";
  return now.toISOString().slice(0, 7);
}

/** The highest alert level `used` has reached, or 0. */
export function levelFor(used: number, allowance: number): number {
  if (allowance <= 0) return 0;
  const percent = (used / allowance) * 100;
  let reached = 0;
  for (const level of ALERT_LEVELS) if (percent >= level) reached = level;
  return reached;
}

function allowanceFor(provider: Provider, stored: number | null): number {
  if (stored && stored > 0) return stored;
  const fromEnv = Number(process.env[PROVIDER_CONFIG[provider].envVar]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : PROVIDER_CONFIG[provider].defaultAllowance;
}

function utcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Count `units` billed against a provider, and alert if that crossed a line.
 *
 * Never throws and is safe to not await: a failed count must not fail the
 * scrape that has already been paid for.
 */
export async function recordProviderUse(provider: Provider, units = 1): Promise<void> {
  if (!Number.isFinite(units) || units <= 0) return;
  try {
    const period = periodFor(provider);

    // One statement, so two requests finishing together can't both read 99 and
    // write 100, and so a new month resets the count on the same write that
    // starts it.
    const [row] = await prisma.$queryRaw<{ used: number; allowance: number | null; alertedLevel: number }[]>`
      INSERT INTO "ProviderCredit" ("provider", "period", "used", "alertedLevel", "updatedAt")
      VALUES (${provider}, ${period}, ${units}, 0, now())
      ON CONFLICT ("provider") DO UPDATE SET
        "used" = CASE WHEN "ProviderCredit"."period" = EXCLUDED."period"
                      THEN "ProviderCredit"."used" + EXCLUDED."used" ELSE EXCLUDED."used" END,
        "alertedLevel" = CASE WHEN "ProviderCredit"."period" = EXCLUDED."period"
                              THEN "ProviderCredit"."alertedLevel" ELSE 0 END,
        "period" = EXCLUDED."period",
        "updatedAt" = now()
      RETURNING "used", "allowance", "alertedLevel"
    `;

    await prisma.providerCreditDay.upsert({
      where: { provider_day: { provider, day: utcDay() } },
      create: { provider, day: utcDay(), count: units },
      update: { count: { increment: units } },
    });

    if (row) await maybeAlert(provider, row.used, allowanceFor(provider, row.allowance), row.alertedLevel);
  } catch (err) {
    console.error(`[credits] failed to record ${provider} use:`, err);
  }
}

async function maybeAlert(provider: Provider, used: number, allowance: number, alertedLevel: number) {
  const level = levelFor(used, allowance);
  if (level <= alertedLevel) return;

  // Claim the level before sending. Whichever request gets the update sends the
  // email; any other request that crossed the same line in the same moment
  // updates nothing and stays quiet.
  const claimed = await prisma.providerCredit.updateMany({
    where: { provider, alertedLevel: { lt: level } },
    data: { alertedLevel: level },
  });
  if (claimed.count === 0) return;

  const summary = (await getProviderCredits()).find((p) => p.provider === provider);
  if (!summary) return;
  const { subject, body } = composeAlert(summary, level);
  await sendAdminAlert(subject, body);
}

export interface ProviderCreditSummary {
  provider: Provider;
  label: string;
  serves: string;
  window: "total" | "monthly";
  used: number;
  allowance: number;
  remaining: number;
  percent: number;
  /** Recent pace, from yesterday and today. Zero when nothing has run. */
  perDay: number;
  /** Days until empty at that pace, or null when there's no pace to go on. */
  daysLeft: number | null;
  syncedAt: string | null;
}

export async function getProviderCredits(now = new Date()): Promise<ProviderCreditSummary[]> {
  const today = utcDay(now);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

  const [rows, days] = await Promise.all([
    prisma.providerCredit.findMany(),
    prisma.providerCreditDay.findMany({ where: { day: { gte: yesterday } } }),
  ]);

  return PROVIDERS.map((provider) => {
    const config = PROVIDER_CONFIG[provider];
    const row = rows.find((r) => r.provider === provider);
    // A row left over from last month is a count of last month.
    const used = row && row.period === periodFor(provider, now) ? row.used : 0;
    const allowance = allowanceFor(provider, row?.allowance ?? null);
    const remaining = Math.max(0, allowance - used);

    // Yesterday in full plus however much of today has gone, so a spike this
    // morning shows up now rather than averaged away over a week.
    const counted = days
      .filter((d) => d.provider === provider)
      .reduce((sum, d) => sum + d.count, 0);
    const elapsed = 1 + (now.getTime() - today.getTime()) / (24 * 60 * 60 * 1000);
    const perDay = counted / elapsed;

    return {
      provider,
      label: config.label,
      serves: config.serves,
      window: config.window,
      used,
      allowance,
      remaining,
      percent: Math.min(100, Math.round((used / allowance) * 100)),
      perDay: Math.round(perDay * 10) / 10,
      daysLeft: perDay > 0 ? Math.round((remaining / perDay) * 10) / 10 : null,
      syncedAt: row?.syncedAt?.toISOString() ?? null,
    };
  });
}

/**
 * Overwrite the count with what the provider's own dashboard says.
 *
 * Pass `remaining` (what dashboards usually show) or `used`. The alert level is
 * set to wherever that lands, so a correction doesn't email about a line you
 * were looking at when you typed the number in.
 */
export async function syncProviderCredits(
  provider: Provider,
  input: { used?: number; remaining?: number; allowance?: number },
): Promise<ProviderCreditSummary> {
  const existing = await prisma.providerCredit.findUnique({ where: { provider } });

  const allowance =
    input.allowance === undefined ? allowanceFor(provider, existing?.allowance ?? null) : Math.round(input.allowance);
  if (!Number.isFinite(allowance) || allowance <= 0) throw new Error("The allowance has to be a positive number.");

  let used: number;
  if (input.used !== undefined) used = Math.round(input.used);
  else if (input.remaining !== undefined) used = allowance - Math.round(input.remaining);
  else throw new Error("Enter how many are used or how many are left.");
  if (!Number.isFinite(used) || used < 0 || used > allowance) {
    throw new Error(`That puts usage at ${used} of ${allowance}, which can't be right.`);
  }

  const data = {
    period: periodFor(provider),
    used,
    allowance: input.allowance === undefined ? existing?.allowance ?? null : allowance,
    alertedLevel: levelFor(used, allowance),
    syncedAt: new Date(),
  };
  await prisma.providerCredit.upsert({ where: { provider }, create: { provider, ...data }, update: data });

  const summary = (await getProviderCredits()).find((p) => p.provider === provider);
  if (!summary) throw new Error("Saved, but couldn't read it back.");
  return summary;
}

/** The email for a provider crossing `level`. Exported for the test and the dashboard's test button. */
export function composeAlert(p: ProviderCreditSummary, level: number): { subject: string; body: string } {
  const out = level >= 100;
  const subject = out
    ? `[Sweep] ${p.label} credits are gone, ${p.serves} is down`
    : `[Sweep] ${p.label} credits at ${level}%, ${p.remaining.toLocaleString("en-US")} left`;

  const pace =
    p.daysLeft === null
      ? "No recent pace to estimate from."
      : `At about ${p.perDay.toLocaleString("en-US")} a day, that lasts roughly ${formatDays(p.daysLeft)}.`;

  const body = [
    `${p.label} (serves ${p.serves})`,
    `Used:       ${p.used.toLocaleString("en-US")} of ${p.allowance.toLocaleString("en-US")} (${p.percent}%)`,
    `Remaining:  ${p.remaining.toLocaleString("en-US")}`,
    p.window === "monthly" ? "Resets:     on the 1st of next month" : "Resets:     never, this allowance is one-time",
    "",
    out ? `${p.serves} results will fail until credits are added or the fallback is switched on.` : pace,
    "",
    "Options: top up the plan, switch to the fallback provider (see SCRAPING.md),",
    "or add the store to DISABLED_RETAILERS on Railway so searches skip it cleanly.",
    "",
    "These numbers are Sweep's own count. If the provider's dashboard says",
    "something different, type its number into the sync box on /admin.",
  ].join("\n");

  return { subject, body };
}

function formatDays(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`;
  if (days < 2) return "1 day";
  return `${Math.round(days)} days`;
}
