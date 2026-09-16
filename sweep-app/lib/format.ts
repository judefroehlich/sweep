// lib/format.ts
//
// Shared formatting. Every screen that renders a price, a date, or a retailer
// name goes through here — one source of truth, so two screens can't quietly
// disagree about what "$0" or "just now" looks like.

import type { Palette } from "@/constants/theme";
import { liveStoreNames } from "@/lib/liveStores";

export type Retailer =
  | "amazon"
  | "walmart"
  | "bestbuy"
  | "ebay"
  | "newegg"
  | "asos"
  | "etsy";

/** Every store, in the order they should be shown. */
export const RETAILERS: Retailer[] = [
  "amazon",
  "walmart",
  "bestbuy",
  "ebay",
  "newegg",
  "asos",
  "etsy",
];

export const RETAILER_LABELS: Record<Retailer, string> = {
  amazon: "Amazon",
  walmart: "Walmart",
  bestbuy: "Best Buy",
  ebay: "eBay",
  newegg: "Newegg",
  asos: "ASOS",
  etsy: "Etsy",
};

/**
 * The supported stores as prose: "Amazon, Walmart, Best Buy, eBay and more".
 *
 * Generated because the list grows. A hardcoded "6 stores" becomes wrong the
 * day a seventh arrives, and those strings hide in onboarding copy and hints
 * where nobody thinks to check.
 */
export function storeListPhrase(limit = 4): string {
  // Live names when the server has told us, the full list until then. The
  // static list includes stores that are switched off, so using it once the
  // truth is known means advertising stores we don't search.
  const names = liveStoreNames();
  const shown = names.slice(0, limit);
  return names.length > shown.length
    ? `${shown.join(", ")} and more`
    : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

export function retailerLabel(retailer: string) {
  return RETAILER_LABELS[retailer as Retailer] ?? retailer;
}

/**
 * Brand colour for a store's dot.
 *
 * Takes the palette rather than importing one: two of these differ between
 * themes (Best Buy's yellow vanishes on white, ASOS's black on near-black), so
 * a fixed import would leave those dots invisible in one theme or the other.
 */
export function retailerColor(colors: Palette, retailer: string) {
  return colors.retailers[retailer as Retailer] ?? colors.textSecondary;
}

/**
 * Cents to a display price. Everything server-side is integer cents; this is
 * the only place that turns them into money, so rounding can't differ by screen.
 */
export function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Compact form for chart axes, where "$1.2k" beats "$1,234.00". */
export function formatPriceShort(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${Math.round(dollars)}`;
}

export function percentOff(
  price: number | null | undefined,
  reference: number | null | undefined,
): number | null {
  if (!price || !reference || reference <= 0 || price >= reference) return null;
  return Math.round(((reference - price) / reference) * 100);
}

export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return "never";

  const then = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);

  if (Number.isNaN(seconds)) return "never";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatChartDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * "March 2026" — for a date whose day doesn't matter.
 *
 * Follows the device's own locale rather than the app's language setting: the
 * month name is the only word in it, and a phone set to Spanish spells it the
 * way its owner expects.
 */
export function formatMonthYear(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** "3 searches" / "1 search" — avoids a stray plural in the UI. */
/**
 * Count plus a noun.
 *
 * The default plural just appends "s", which is wrong for anything ending in
 * s, ch, sh or x — this produced "9 searchs left today" on the profile screen
 * for a while. Pass `plural` explicitly for those.
 *
 * Also worth noting it builds an English string, so it does not belong in
 * anything user-facing that has a translation key available. The profile line
 * that caused the typo was untranslated for the same reason it was misspelled.
 */
export function pluralize(count: number, singular: string, plural?: string) {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function formatRating(rating: number | null, count: number | null) {
  if (rating === null) return null;
  const stars = rating.toFixed(1);
  if (!count) return `${stars}★`;
  return `${stars}★ (${compactCount(count)})`;
}

/**
 * eBay has no product ratings — only seller feedback. Rendered with an explicit
 * "seller" label so nobody reads 99.3% as a 5-star score, or compares it
 * against Walmart's 4.4★ as though they measured the same thing.
 */
export function formatSellerRating(
  percentage: number | null,
  count: number | null,
) {
  if (percentage === null) return null;
  const pct = `${percentage % 1 === 0 ? percentage : percentage.toFixed(1)}% seller`;
  return count ? `${pct} (${compactCount(count)})` : pct;
}

function compactCount(count: number) {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`;
  }
  return String(count);
}
