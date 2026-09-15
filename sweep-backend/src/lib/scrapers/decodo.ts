// lib/scrapers/decodo.ts
//
// Fetching pages that refuse our own IP.
//
// Walmart's parser has worked from the start — the blocker was always which
// address asked. Verified, in order: our Railway datacenter IP is refused, a
// Cloudflare Worker gets an identical 15KB challenge page every time, and
// Geonode returns 422 on datacenter, residential and JS-rendered alike.
//
// Decodo returns the real page: `__NEXT_DATA__` present on twelve consecutive
// requests, product pages in ~3s and search in 6-10s, on the standard proxy
// with no JS rendering. So this is a fetch that goes through them instead of
// out of our own network, and nothing above it changes.
//
// Deliberately a thin swap rather than an integration. It returns HTML, so
// every parser keeps working untouched and the day an official API arrives
// this file is deleted rather than unpicked.

import { recordProviderUse } from "../providerCredits.js";

const ENDPOINT = "https://scraper-api.decodo.com/v2/scrape";

/**
 * Long enough for a Walmart search, which measured 6-10s, plus headroom.
 * Shorter than the search deadline that races it, so a slow page loses to the
 * deadline rather than hanging a request nobody is waiting on any more.
 */
const TIMEOUT_MS = 25_000;

export function isDecodoConfigured(): boolean {
  return Boolean(process.env.DECODO_AUTH_TOKEN?.trim());
}

export class DecodoError extends Error {
  constructor(
    message: string,
    readonly kind: "failed" | "blocked",
  ) {
    super(message);
    this.name = "DecodoError";
  }
}

/**
 * Fetch a page's HTML through Decodo.
 *
 * Sends nothing but the url on purpose. Geo targeting and JS rendering both
 * bill at a higher rate per request, and Walmart needs neither — the payload
 * is in the initial HTML.
 */
export async function fetchViaDecodo(url: string): Promise<string> {
  const token = process.env.DECODO_AUTH_TOKEN?.trim();
  if (!token) throw new DecodoError("DECODO_AUTH_TOKEN is not set", "failed");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${token}`,
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // 402/429 mean we've run out or gone too fast — ours to fix, not the
    // store's. Reporting them as "blocked" would start the retailer cooldown
    // and hide an account problem behind a store outage.
    throw new DecodoError(
      `Decodo returned ${res.status}: ${detail}`,
      res.status === 403 ? "blocked" : "failed",
    );
  }

  // Billed from here on: Decodo charges for any request that got a page back,
  // including a challenge page that turns out to be useless below.
  void recordProviderUse("decodo");

  const body = (await res.json()) as {
    results?: { content?: string }[];
  };

  const html = body.results?.[0]?.content;
  if (typeof html !== "string" || html.length === 0) {
    throw new DecodoError("Decodo returned no content", "failed");
  }

  // A challenge page comes back as a perfectly good 200. Every real Walmart
  // page carries __NEXT_DATA__, so its absence is the signal — and without
  // this check a blocked fetch reads as a store with no products.
  if (!html.includes("__NEXT_DATA__")) {
    throw new DecodoError(
      `page came back without __NEXT_DATA__ (${html.length} bytes) — probably a challenge`,
      "blocked",
    );
  }

  return html;
}
