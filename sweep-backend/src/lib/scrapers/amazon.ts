// lib/scrapers/amazon.ts
//
// Amazon is the one retailer we pay for. Their anti-bot layer is purpose-built
// and actively maintained, so plain fetch is a dead end — this goes through
// Bright Data's Amazon Scraper API instead of trying to evade it in-house.
//
// Free tier is 5,000 records/month, which is a real ceiling: every call here
// spends quota. That's why the scheduler treats Amazon as `metered` and checks
// it less aggressively than the free scrapers.
//
// Bright Data answers either 200 with data, or 202 with a snapshot id we then
// poll — both paths are handled below.

import {
  type ProductDetail,
  type ReviewTopic,
  cleanQuote,
  num,
  strings,
} from "../productDetail.js";
import {
  type ScrapeResult,
  type ScrapedProduct,
  fail,
  ok,
  toCents,
} from "./types.js";
import { recordProviderUse } from "../providerCredits.js";

const API_BASE = "https://api.brightdata.com/datasets/v3";

function config() {
  return {
    apiKey: process.env.BRIGHTDATA_API_KEY,
    productDataset: process.env.BRIGHTDATA_AMAZON_DATASET_ID,
    searchDataset:
      process.env.BRIGHTDATA_AMAZON_SEARCH_DATASET_ID ??
      process.env.BRIGHTDATA_AMAZON_DATASET_ID,
  };
}

export function isAmazonConfigured() {
  const { apiKey, productDataset } = config();
  return Boolean(apiKey && productDataset);
}

// ---- 1. Single product lookup — scheduled re-checks of a tracked item ----
export async function scrapeAmazonProduct(
  url: string,
): Promise<ScrapeResult<ScrapedProduct>> {
  const started = Date.now();
  const { apiKey, productDataset } = config();

  if (!apiKey || !productDataset) {
    return fail("failed", NOT_CONFIGURED, elapsed(started));
  }

  try {
    const rows = await runJob(
      `${API_BASE}/scrape?dataset_id=${productDataset}&format=json`,
      { input: [{ url }] },
      apiKey,
    );

    const parsed = rows?.[0] ? parseAmazonProduct(rows[0], url) : null;
    if (!parsed) {
      return fail("failed", "Bright Data returned no rows for this url", elapsed(started));
    }
    return ok(parsed, elapsed(started));
  } catch (err) {
    return fail(kindOf(err), messageOf(err), elapsed(started));
  }
}

// ---- 2. Keyword search — the Amazon leg of compiled multi-site search ----
export async function searchAmazonProducts(
  keyword: string,
  limit = 4,
): Promise<ScrapeResult<ScrapedProduct[]>> {
  const started = Date.now();
  const { apiKey, searchDataset } = config();

  if (!apiKey || !searchDataset) {
    return fail("failed", NOT_CONFIGURED, elapsed(started));
  }

  try {
    const rows = await runJob(
      `${API_BASE}/scrape?dataset_id=${searchDataset}` +
        `&notify=false&include_errors=true&type=discover_new&discover_by=keyword`,
      { input: [{ keyword, zipcode: "" }], limit_per_input: limit },
      apiKey,
    );

    const products = (rows ?? [])
      .map((row) => parseAmazonProduct(row, row?.url ?? ""))
      .filter((p): p is ScrapedProduct => p !== null)
      .slice(0, limit);

    return ok(products, elapsed(started));
  } catch (err) {
    return fail(kindOf(err), messageOf(err), elapsed(started));
  }
}

// ---- shared: submit a job, following the sync-or-snapshot fork ----
async function runJob(
  url: string,
  body: unknown,
  apiKey: string,
): Promise<any[] | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // Bright Data's /scrape holds the connection while it crawls and only
    // falls back to a snapshot id if that takes too long. Measured runs finish
    // in 19-23s normally but 70s when Amazon makes it retry, so a 60s ceiling
    // hung up on jobs that were about to succeed — the crawl completed and we
    // had already stopped listening. Amazon's slot on the server allows four
    // minutes; this should sit inside that, not below the normal worst case.
    signal: AbortSignal.timeout(180_000),
  });

  if (res.status === 200) {
    return billed(parseRows(await res.text()));
  }

  if (res.status === 202) {
    const { snapshot_id } = (await res.json()) as { snapshot_id: string };
    return billed(await pollSnapshot(snapshot_id, apiKey));
  }

  const errorBody = await res.text();
  // 401/403 here means our key or dataset is wrong, not that Amazon blocked
  // us — Bright Data absorbs Amazon's blocking on our behalf.
  throw new BrightDataError(
    `Bright Data returned ${res.status}: ${errorBody.slice(0, 400)}`,
    res.status === 429 ? "blocked" : "failed",
  );
}

/**
 * Count what Bright Data charges for: one record per row delivered. A search
 * for four results is four records, not one. Rows carrying an error came back
 * because of include_errors and aren't billed.
 */
function billed(rows: any[] | null): any[] | null {
  const records = (rows ?? []).filter((row) => row && typeof row === "object" && !row.error).length;
  if (records > 0) void recordProviderUse("brightdata", records);
  return rows;
}

// ---- shared: poll until the async job is ready, then fetch results ----
async function pollSnapshot(
  snapshotId: string,
  apiKey: string,
  maxAttempts = 40,
  delayMs = 5000,
): Promise<any[] | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, delayMs));

    const progressRes = await fetch(`${API_BASE}/progress/${snapshotId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });

    if (!progressRes.ok) {
      throw new BrightDataError(
        `progress check failed: ${progressRes.status}`,
        "failed",
      );
    }

    const progress = (await progressRes.json()) as { status: string };

    if (progress.status === "ready") {
      const dataRes = await fetch(
        `${API_BASE}/snapshot/${snapshotId}?format=json`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(60_000),
        },
      );
      return parseRows(await dataRes.text());
    }

    if (progress.status === "failed") {
      throw new BrightDataError(`job ${snapshotId} failed`, "failed");
    }

    // status === "running" — keep waiting
  }

  throw new BrightDataError(
    `job ${snapshotId} timed out after ${(maxAttempts * delayMs) / 1000}s`,
    "failed",
  );
}

/**
 * Bright Data does not always answer with a JSON array.
 *
 * Requests that pass `format=json` get one; the keyword-discovery endpoint
 * answers with NDJSON — one object per line — and feeding that to JSON.parse
 * dies at line 2 with "Unexpected non-whitespace character". Handle both,
 * plus a bare single object, so a format change can't silently blank Amazon.
 */
function parseRows(body: string): any[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    // A single object, or an error envelope.
    return [parsed];
  } catch {
    // Fall through to NDJSON.
  }

  const rows: any[] = [];
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      rows.push(JSON.parse(candidate));
    } catch {
      // One malformed line shouldn't discard the whole response.
    }
  }

  if (rows.length === 0) {
    throw new BrightDataError(
      `couldn't parse response as JSON or NDJSON: ${trimmed.slice(0, 200)}`,
      "failed",
    );
  }

  return rows;
}

// ---- shared: normalize raw Bright Data fields into our shape ----
function parseAmazonProduct(raw: any, fallbackUrl: string): ScrapedProduct | null {
  const retailerId = raw?.asin;
  const title = raw?.title;
  if (!retailerId || !title) return null;

  const price = toCents(raw?.final_price);
  const listPrice = toCents(raw?.initial_price);

  return {
    retailer: "amazon",
    retailerId: String(retailerId),
    title: String(title),
    price,
    listPrice: listPrice && price && listPrice > price ? listPrice : null,
    currency: raw?.currency ?? "USD",
    imageUrl: raw?.image_url ?? raw?.image ?? null,
    url: raw?.url ?? fallbackUrl,
    availability: raw?.availability ?? null,
    rating: numberOrNull(raw?.rating),
    ratingCount: numberOrNull(raw?.reviews_count),
    sellerRating: null,
    sellerRatingCount: null,
  };
}

// ---- 3. Product lookup — one enriched page about one item ----
//
// Same dataset and the same single billed record as a price check; the only
// difference is how much of the payload we keep. A price check needs four
// fields, so it throws the rest away. This keeps the parts a person reading a
// product page actually wants: what buyers say, what's in the box, and whether
// the listing itself is trustworthy.
export async function enrichAmazonProduct(
  url: string,
): Promise<ScrapeResult<ProductDetail>> {
  const started = Date.now();
  const { apiKey, productDataset } = config();

  if (!apiKey || !productDataset) {
    return fail("failed", NOT_CONFIGURED, elapsed(started));
  }

  try {
    const rows = await runJob(
      `${API_BASE}/scrape?dataset_id=${productDataset}&format=json`,
      { input: [{ url }] },
      apiKey,
    );
    const detail = rows?.[0] ? parseAmazonDetail(rows[0], url) : null;
    if (!detail) {
      return fail("failed", "Bright Data returned no rows for this url", elapsed(started));
    }
    return ok(detail, elapsed(started));
  } catch (err) {
    return fail(kindOf(err), messageOf(err), elapsed(started));
  }
}

/** Exported for tests, which run it against a recorded Bright Data payload. */
export function parseAmazonDetail(raw: any, fallbackUrl: string): ProductDetail | null {
  const base = parseAmazonProduct(raw, fallbackUrl);
  if (!base) return null;

  const price = base.price;

  // `customers_say` is Amazon's own summary of its review corpus. We have no
  // access to the reviews themselves, so everything here is passed through
  // unmodified — there is nothing for us to recompute, and inventing a
  // derived number would imply an analysis we did not do.
  const say = raw?.customers_say ?? raw?.customers_says ?? null;
  const keywords = say?.keywords ?? {};

  const topics: ReviewTopic[] = Array.isArray(raw?.customers_say_topics)
    ? raw.customers_say_topics
        .map((topic: any): ReviewTopic | null => {
          const name = typeof topic?.topic === "string" ? topic.topic.trim() : "";
          if (!name) return null;
          return {
            topic: name,
            // Deliberately NOT using `mentions_count`: observed payloads carry
            // mentions_count 5 alongside 4497 positive mentions, so it is not
            // a total and any "x of y" or percentage built on it would be
            // fiction. Positive and negative are internally consistent.
            positiveMentions: num(topic?.positive_mentions_count) ?? 0,
            negativeMentions: num(topic?.negative_mentions_count) ?? 0,
            description:
              typeof topic?.topic_description === "string"
                ? topic.topic_description.trim() || null
                : null,
            quotes: Array.isArray(topic?.example_quotes)
              ? topic.example_quotes
                  .map(cleanQuote)
                  .filter((q: string | null): q is string => q !== null)
              : [],
          };
        })
        .filter((t: ReviewTopic | null): t is ReviewTopic => t !== null)
    : [];

  const summaryText =
    typeof say?.text === "string" && say.text.trim() ? say.text.trim() : null;
  const reviewImages = strings(raw?.review_images);

  const hasReviewData =
    summaryText !== null || topics.length > 0 || reviewImages.length > 0;

  const specs = Array.isArray(raw?.product_details)
    ? raw.product_details
        .map((row: any) => ({
          label: typeof row?.type === "string" ? row.type.trim() : "",
          value: row?.value === null || row?.value === undefined ? "" : String(row.value).trim(),
        }))
        .filter((row: { label: string; value: string }) => row.label && row.value)
    : [];

  // Amazon itself is the seller on most first-party listings, and returns null
  // for seller_name there. Only claimed when there is a name to show.
  const sellerName =
    typeof raw?.seller_name === "string" && raw.seller_name.trim()
      ? raw.seller_name.trim()
      : null;
  const offerCount = num(raw?.number_of_sellers);
  const sellerRating = num(raw?.buybox_seller_rating);

  const couponText =
    (typeof raw?.coupon_description === "string" && raw.coupon_description.trim()) ||
    (typeof raw?.coupon === "string" && raw.coupon.trim()) ||
    null;

  const badge =
    typeof raw?.badge === "string" && raw.badge.trim() ? raw.badge.trim() : null;
  const returnedNote =
    typeof raw?.frequently_returned_item_message === "string" &&
    raw.frequently_returned_item_message.trim()
      ? raw.frequently_returned_item_message.trim()
      : null;
  const boughtRecently =
    typeof raw?.bought_past_month_text === "string" && raw.bought_past_month_text.trim()
      ? raw.bought_past_month_text.trim()
      : null;
  const bsRank = num(raw?.bs_rank) ?? num(raw?.root_bs_rank);
  const bsCategory =
    (typeof raw?.bs_category === "string" && raw.bs_category.trim()) ||
    (typeof raw?.root_bs_category === "string" && raw.root_bs_category.trim()) ||
    null;

  const hasTrust =
    badge !== null ||
    raw?.amazon_choice === true ||
    raw?.is_frequently_returned_item_badge === true ||
    boughtRecently !== null ||
    bsRank !== null;

  // Lead with the main image, then the gallery, without repeating it.
  const images = strings([base.imageUrl, ...(Array.isArray(raw?.images) ? raw.images : [])]);

  return {
    retailer: "amazon",
    retailerId: base.retailerId,
    title: base.title,
    url: base.url,
    price,
    listPrice: base.listPrice,
    currency: base.currency,
    availability: base.availability,
    // `is_available` is the store's own boolean; the availability string is
    // prose and varies too much to parse.
    inStock: typeof raw?.is_available === "boolean" ? raw.is_available : null,

    images,
    brand:
      (typeof raw?.brand === "string" && raw.brand.trim()) ||
      (typeof raw?.manufacturer === "string" && raw.manufacturer.trim()) ||
      null,
    description:
      (typeof raw?.description === "string" && raw.description.trim()) ||
      (typeof raw?.product_description === "string" && raw.product_description.trim()) ||
      null,
    features: strings(raw?.features),
    specs,

    rating: base.rating,
    ratingCount: base.ratingCount,
    reviews: hasReviewData
      ? {
          text: summaryText,
          positive: strings(keywords?.positive),
          negative: strings(keywords?.negative),
          mixed: strings(keywords?.mixed),
          topics,
          images: reviewImages,
        }
      : null,

    seller:
      sellerName || offerCount !== null || sellerRating !== null
        ? {
            name: sellerName,
            ratingPercent: sellerRating,
            ratingCount: null,
            offerCount,
            url: typeof raw?.seller_url === "string" ? raw.seller_url : null,
          }
        : null,
    // Amazon's payload carries no usable shipping cost or delivery window, so
    // this is null rather than a guess. See COVERAGE.
    shipping: null,
    trust: hasTrust
      ? {
          badge,
          amazonChoice: raw?.amazon_choice === true,
          frequentlyReturned: raw?.is_frequently_returned_item_badge === true,
          frequentlyReturnedNote: returnedNote,
          boughtRecently,
          bestSellerRank: bsRank,
          bestSellerCategory: bsCategory,
        }
      : null,

    coupon: couponText,
    condition: null,
    fetchedAt: new Date().toISOString(),
  };
}

class BrightDataError extends Error {
  constructor(
    message: string,
    readonly kind: "failed" | "blocked",
  ) {
    super(message);
    this.name = "BrightDataError";
  }
}

const NOT_CONFIGURED =
  "Amazon is not configured — set BRIGHTDATA_API_KEY and BRIGHTDATA_AMAZON_DATASET_ID (see docs/INTEGRATIONS.md)";

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function elapsed(started: number) {
  return Date.now() - started;
}

function kindOf(err: unknown): "failed" | "blocked" {
  return err instanceof BrightDataError ? err.kind : "failed";
}

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
