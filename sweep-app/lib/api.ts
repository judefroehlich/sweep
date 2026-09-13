// lib/api.ts
//
// The only place the app talks to the backend. Every call carries the Supabase
// access token when signed in, and the anonymous device id otherwise, so the
// server can apply the right limits without the client asserting anything.
//
// ---- the rule for these types ----
//
// The backend's rule is that changes are additive, so an OLD app keeps working
// against a NEW server (see sweep-backend/src/test-contract.ts). This file
// carries the other half of that bargain, which is easier to forget because
// it only bites in development and during deploys:
//
//   A NEW APP MUST SURVIVE AN OLD SERVER.
//
// A field added to a response after a release is absent for every client
// running against a backend that predates it — every phone mid-rollout, every
// dev build pointed at production, and the whole window between pushing the
// app and pushing the server. So a newly added response field is declared
// OPTIONAL here, and stays that way until no deployed backend can omit it.
//
// This is not hypothetical: `similar` on LookupResult was typed as required,
// and reading `.length` on it crashed the lookup screen against a server that
// simply hadn't been redeployed yet.

import Constants from "expo-constants";
import { markReachable, markUnreachable } from "./connection";
import { getDeviceId } from "./deviceId";
import { currentLanguage } from "./i18n";
import { supabase } from "./supabase";

/**
 * On a physical Android device, localhost is the phone, not your machine.
 * The android script in package.json runs `adb reverse tcp:3001 tcp:3001`,
 * which is what makes localhost work there. Set EXPO_PUBLIC_API_URL to point
 * somewhere else (a LAN IP, or the deployed backend).
 */
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  Constants.expoConfig?.extra?.apiUrl ??
  "http://localhost:3001";

/** Thrown for any non-2xx response, carrying the server's error contract. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: any,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = "GET", body } = options;

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const headers: Record<string, string> = {};
  // Only declare a JSON body when there actually is one — Fastify rejects a
  // request that claims application/json and sends nothing.
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  // Guests are identified by device. Sent even when signed in so the server
  // could reconcile a guest's history on signup later.
  headers["x-device-id"] = await getDeviceId();
  // The server generates plan copy and error messages itself, so it has to know
  // which language to write them in. Its own choice, not the phone's, since a
  // user who overrode the device language meant it here too.
  headers["Accept-Language"] = currentLanguage();

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    markUnreachable();
    throw new ApiError(
      "Can't reach Sweep. Check your connection and that the backend is running.",
      0,
      "NETWORK_ERROR",
    );
  }

  // Any response means the server is there — a 4xx or 5xx is still a
  // conversation, and treating it as "offline" would be misleading.
  markReachable();

  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  // A 401 when we *sent* a token means the session is dead — the account was
  // deleted, the password changed, or it was revoked elsewhere. Supabase won't
  // notice until its next refresh, which can be an hour away, and until then
  // the app sits there showing a signed-in user whose every request fails.
  //
  // Signing out here fires onAuthStateChange, which the root layout already
  // watches, so the user lands on the sign-in screen instead of a wall of
  // errors. Guarded on `token` so a guest touching an authenticated endpoint
  // is simply refused rather than bounced.
  //
  // Belt and braces alongside the server returning 403 for a failed re-auth:
  // a response that names a specific failure is answering the request, not
  // rejecting the session, and must never sign anyone out.
  if (
    response.status === 401 &&
    token &&
    payload?.code !== "PASSWORD_INCORRECT" &&
    payload?.code !== "PASSWORD_REQUIRED" &&
    payload?.code !== "REAUTH_REQUIRED"
  ) {
    await supabase.auth.signOut().catch(() => {});
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.error ?? `Request failed (${response.status})`,
      response.status,
      payload?.code,
      payload,
    );
  }

  return payload as T;
}

// ---- types shared with the server ------------------------------------------

export interface Product {
  id: string;
  retailer: string;
  retailerId: string;
  url: string;
  title: string;
  imageUrl: string | null;
  price: number | null;
  listPrice: number | null;
  currency: string;
  availability: string | null;
  rating: number | null;
  ratingCount: number | null;
  lastCheckedAt: string | null;
  lastStatus: string | null;
}

/** A search result hasn't been saved yet, so it has no Product id. */
export interface SearchProduct {
  retailer: string;
  retailerId: string;
  title: string;
  price: number | null;
  listPrice: number | null;
  currency: string;
  imageUrl: string | null;
  url: string;
  availability: string | null;
  rating: number | null;
  ratingCount: number | null;
  /** eBay only — seller feedback %, since eBay publishes no product rating. */
  sellerRating: number | null;
  sellerRatingCount: number | null;
}

export interface TrackedProduct {
  id: string;
  addedAt: string;
  customThreshold: number | null;
  lastNotifiedAt?: string | null;
  /** Price when this user started watching, in cents. */
  priceAtTracking: number | null;
  product: Product;
}

export interface Quota {
  used: number;
  limit: number;
  remaining: number;
  bonus: number;
  canWatchAd: boolean;
  resetsAt: string;
}

export interface RetailerResult {
  retailer: string;
  label: string;
  status: "success" | "failed" | "blocked";
  message: string | null;
  products: SearchProduct[];
}

/**
 * How much the server trusts a retailer's claimed discount.
 *
 * Absent from older servers, so treat undefined as "no opinion" and render
 * exactly as before rather than assuming the worst.
 */
export type DiscountConfidence = "plausible" | "unverified";

export interface Highlight {
  kind: "cheapest" | "best_rated" | "biggest_discount";
  label: string;
  reason: string;
  product: SearchProduct;
  /** "biggest_discount" only, and only from servers that send it. */
  confidence?: DiscountConfidence;
}

export interface SearchResponse {
  keyword: string;
  quota: Quota;
  /** How many results per store this search actually used. */
  resultsPerRetailer?: number;
  /** What this tier may choose. min === max means no choice. */
  resultsRange?: { min: number; max: number; default: number };
  /** The few results worth showing above the per-store columns. */
  highlights: Highlight[];
  /** What the server decided the query was about. */
  categories: string[];
  /** Stores deliberately not searched, because they don't sell this kind of thing. */
  skipped: { retailer: string; label: string }[];
  /**
   * Set when Amazon is still running. Bright Data's free tier can take up to
   * ~3 minutes, so Amazon is fetched out-of-band and polled separately rather
   * than holding up the four retailers that answer in seconds.
   */
  amazonJobId: string | null;
  results: RetailerResult[];
}

/** What /search/start hands back: the search has begun, nothing has landed. */
export interface SearchStart {
  jobId: string;
  keyword: string;
  quota: Quota;
  /** Stores this search will ask, in the order the server routed them. */
  pending: { retailer: string; label: string }[];
  categories: string[];
  skipped: { retailer: string; label: string }[];
}

/** A poll of a running search. `done` means nothing is left to wait for. */
export interface SearchProgress {
  jobId: string;
  keyword: string;
  done: boolean;
  results: RetailerResult[];
  highlights: Highlight[];
}

export interface AmazonJobResult {
  status: "pending" | "success" | "failed" | "blocked";
  retailer: string;
  label: string;
  products: SearchProduct[];
  message: string | null;
  elapsedMs: number;
}

export interface PricePoint {
  price: number;
  checkedAt: string;
}

export interface ProductDetail {
  product: Product;
  history: PricePoint[];
  stats: {
    low: number | null;
    high: number | null;
    average: number | null;
    percentBelowAverage: number | null;
  };
  tracking: { id: string; customThreshold: number | null } | null;
  historyWindow: { days: number | null; shown: number; total: number };
}

// ---- endpoints -------------------------------------------------------------

export function syncUser(email: string) {
  return request<{ user: unknown }>("/auth/sync-user", {
    method: "POST",
    body: { email },
  });
}

export function getQuota() {
  return request<{
    quota: Quota;
    isGuest: boolean;
    tier: string;
    /** What this tier may choose per store. min === max means no choice. */
    resultsRange?: { min: number; max: number; default: number };
  }>("/search/quota");
}

export function search(
  keyword: string,
  retailers?: string[],
  resultsPerRetailer?: number,
) {
  const params = new URLSearchParams({ q: keyword });
  if (retailers?.length) params.set("retailers", retailers.join(","));
  // A preference, not an instruction — the server clamps it to the tier.
  if (resultsPerRetailer) params.set("results", String(resultsPerRetailer));
  return request<SearchResponse>(`/search?${params}`);
}

/**
 * Begin a search. Returns as soon as the stores have been kicked off, so the
 * screen can render its columns before any of them have answered.
 */
export function startSearch(
  keyword: string,
  retailers?: string[],
  resultsPerRetailer?: number,
) {
  const params = new URLSearchParams({ q: keyword });
  if (retailers?.length) params.set("retailers", retailers.join(","));
  if (resultsPerRetailer) params.set("results", String(resultsPerRetailer));
  return request<SearchStart>(`/search/start?${params}`);
}

/** Whatever has landed so far. Safe to call repeatedly. */
export function getSearchProgress(jobId: string) {
  return request<SearchProgress>(`/search/job/${jobId}`);
}

export function getAmazonSearchResult(jobId: string) {
  return request<AmazonJobResult>(`/search/amazon/${jobId}`);
}

export function claimRewardedSearch() {
  return request<{ quota: Quota }>("/search/rewarded", { method: "POST" });
}

export function getTrackedProducts() {
  return request<{
    tracked: TrackedProduct[];
    limits: { maxTrackedProducts: number; used: number };
    tier: string;
  }>("/products");
}

export interface TrackLimits {
  maxTrackedProducts: number;
  used: number;
  canTrack: boolean;
  checkTimesPerDay: number;
  fixedCheckTimes: boolean;
  checkIntervalMinutes: number;
}

export interface ProductPreview {
  product: Product;
  alreadyTracking: boolean;
  limits: TrackLimits;
  schedule: {
    checkHours: number[];
    timezone: string;
    nextCheckAt: string | null;
  };
  tier: string;
}

/** Scrape a pasted link and show what we found, without committing to track it. */
export function previewProduct(url: string) {
  return request<ProductPreview>("/products/preview", {
    method: "POST",
    body: { url },
  });
}

export function trackProduct(
  target: { url: string } | { retailer: string; retailerId: string },
  /** Only the timezone is sent now — check times aren't user-chosen. */
  options?: { timezone: string },
) {
  return request<{ tracked: TrackedProduct }>("/products/track", {
    method: "POST",
    body: { ...target, ...(options ?? {}) },
  });
}

export interface Schedule {
  checkHours: number[];
  /** Minute offset for interval tiers: "every 2 hours at :35". */
  checkMinute: number;
  timezone: string;
  maxCheckTimes: number;
  maxCheckMinute: number;
  fixedCheckTimes: boolean;
  canSetCheckMinute: boolean;
  checkIntervalMinutes: number;
  nextCheckAt: string | null;
  tier: string;
}

export function getSchedule() {
  return request<Schedule>("/me/schedule");
}

export function updateSchedule(
  timezone: string,
  options: { checkHours?: number[]; checkMinute?: number },
) {
  return request<{
    checkHours: number[];
    checkMinute: number;
    timezone: string;
    maxCheckTimes: number;
    maxCheckMinute: number;
    nextCheckAt: string | null;
  }>("/me/schedule", { method: "PUT", body: { timezone, ...options } });
}

export function untrackProduct(trackedId: string) {
  return request<{ ok: true }>(`/products/track/${trackedId}`, {
    method: "DELETE",
  });
}

export function getProductDetail(productId: string) {
  return request<ProductDetail>(`/products/${productId}`);
}

export interface ManualCheckState {
  used: number;
  /** Null when the tier has no daily cap (Pro/Ultimate). */
  limit: number | null;
  remaining: number | null;
  cooldownMinutes: number | null;
  availableAt: string | null;
  resetsAt: string;
}

export function refreshProduct(productId: string) {
  return request<{
    status: string;
    product: Product | null;
    manualChecks: ManualCheckState | null;
  }>(`/products/${productId}/refresh`, { method: "POST" });
}

export function getManualChecks() {
  return request<{ manualChecks: ManualCheckState }>("/products/manual-checks");
}

export function setCustomThreshold(trackedId: string, cents: number | null) {
  return request<{ ok: true; customThreshold: number | null }>(
    `/products/track/${trackedId}`,
    { method: "PATCH", body: { customThreshold: cents } },
  );
}

export function registerPushToken(token: string, platform: "ios" | "android") {
  return request<{ ok: true }>("/notifications/register", {
    method: "POST",
    body: { token, platform },
  });
}

export function unregisterPushToken(token: string) {
  return request<{ ok: true }>("/notifications/register", {
    method: "DELETE",
    body: { token },
  });
}

export function getNotificationStatus() {
  return request<{ registered: boolean; devices: number }>(
    "/notifications/status",
  );
}

// ---- lists ----

export interface ListItem {
  id: string;
  note: string | null;
  claimed: boolean;
  addedAt: string;
  product: {
    id: string;
    retailer: string;
    retailerId: string;
    title: string;
    imageUrl: string | null;
    url: string;
    price: number | null;
    listPrice: number | null;
  };
}

export interface GiftList {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  shareToken: string | null;
  createdAt: string;
  itemCount: number;
  totalValue: number;
  items: ListItem[];
}

export function getLists() {
  return request<{
    lists: GiftList[];
    limits: { maxLists: number; maxItemsPerList: number; used: number };
    tier: string;
  }>("/lists");
}

export function createList(name: string, description?: string) {
  return request<{ list: GiftList }>("/lists", {
    method: "POST",
    body: { name, description },
  });
}

export function renameList(id: string, name: string) {
  return request<{ ok: true }>(`/lists/${id}`, { method: "PATCH", body: { name } });
}

export function deleteList(id: string) {
  return request<{ ok: true }>(`/lists/${id}`, { method: "DELETE" });
}

export function addListItem(
  listId: string,
  target: { url: string } | { retailer: string; retailerId: string },
  note?: string,
) {
  return request<{ item: ListItem }>(`/lists/${listId}/items`, {
    method: "POST",
    body: { ...target, note },
  });
}

export function removeListItem(listId: string, itemId: string) {
  return request<{ ok: true }>(`/lists/${listId}/items/${itemId}`, {
    method: "DELETE",
  });
}

export function setListSharing(listId: string, enabled: boolean) {
  return request<{ isPublic: boolean; shareToken: string | null }>(
    `/lists/${listId}/share`,
    { method: "POST", body: { enabled } },
  );
}

// ---- plans ----

export interface PlanFeature {
  label: string;
  group: "tracking" | "search" | "budget" | "lists" | "extras";
  included: boolean;
}

export interface Plan {
  tier: string;
  name: string;
  tagline: string;
  pricing: {
    monthly: number | null;
    yearly: number | null;
    yearlySavingPercent: number | null;
    /** What the yearly price works out to per month. */
    yearlyPerMonth: number | null;
  };
  /** Short ribbon above the name, e.g. "MOST POPULAR". Null for Free. */
  badge: string | null;
  /** One-line summary of this plan's headline numbers. */
  summary: string;
  /** The handful of numbers that improve at this tier. `from` is null on Free. */
  // `id` is the language-independent handle ("dial.manual"); `label` is
  // translated. Filter on id, never on label.
  upgrades: { id: string; label: string; from: string | null; to: string }[];
  /** Features that switch on at this tier and weren't available below it. */
  unlocks: string[];
  features: PlanFeature[];
  highlighted: boolean;
}

export function getPlans() {
  return request<{
    plans: Plan[];
    groupLabels: Record<string, string>;
    currentTier: string | null;
  }>("/plans");
}

// ---- deals feed ----

export interface Deal {
  id: string;
  percentBelowAverage: number;
  previousPrice: number;
  newPrice: number;
  averagePrice: number;
  foundAt: string;
  /** Username of whoever tracked it first. Null if that account is gone. */
  finder: string | null;
  foundByMe: boolean;
  isTracking: boolean;
  product: {
    id: string;
    retailer: string;
    retailerId: string;
    title: string;
    imageUrl: string | null;
    url: string;
    currentPrice: number | null;
  };
}

export function getDeals() {
  return request<{ deals: Deal[]; isGuest: boolean }>("/deals");
}

// ---- XP + leaderboard ----

export interface LeaderboardEntry {
  rank: number;
  name: string;
  xp: number;
  level: number;
  title: string;
  isMe: boolean;
}

export interface LeaderboardMe {
  rank: number;
  name: string;
  xp: number;
  hasUsername: boolean;
  offList: boolean;
  level: number;
  currentLevelXp: number;
  nextLevelXp: number;
  progress: number;
  title: string;
}

export function getLeaderboard() {
  return request<{ entries: LeaderboardEntry[]; me: LeaderboardMe | null }>(
    "/leaderboard",
  );
}

export interface Badge {
  id: string;
  label: string;
  description: string;
  icon: string;
  tier: "bronze" | "silver" | "gold";
  earned: boolean;
  progress: number;
  progressLabel: string;
}

export interface XpEntry {
  id: string;
  xp: number;
  reason: string;
  detail: string | null;
  productTitle: string | null;
  at: string;
}

export function getMyXp() {
  return request<{
    username: string | null;
    name: string;
    xp: number;
    level: number;
    currentLevelXp: number;
    nextLevelXp: number;
    progress: number;
    title: string;
    badges: Badge[];
    history: XpEntry[];
  }>("/me/xp");
}

export function setUsername(username: string) {
  return request<{ username: string }>("/me/username", {
    method: "PUT",
    body: { username },
  });
}

export function getRetailerStatus() {
  return request<{
    retailers: {
      retailer: string;
      label: string;
      available: boolean;
      successRate: number | null;
      /**
       * Median successful search time in seconds, over the past week, or null
       * when there haven't been enough searches to say.
       *
       * Optional: added after a release, so a server that predates it won't
       * send it. See the rule at the top of this file.
       */
      typicalSeconds?: number | null;
      /** False when switched off by configuration, not merely failing. */
      enabled?: boolean;
    }[];
  }>("/search/retailers");
}

// ---- budget -----------------------------------------------------------------

export interface BudgetEntry {
  id: string;
  amount: number;
  category: string;
  description: string | null;
  spentAt: string;
  /** Set when the entry was logged from a tracked product. */
  product: {
    id: string;
    title: string;
    retailer: string;
    imageUrl: string | null;
    url: string;
  } | null;
}

export interface BudgetMonth {
  month: string;
  total: number;
  /** The overall monthly budget, or null if none is set. */
  budget: number | null;
  entries: BudgetEntry[];
  categories: { category: string; spent: number; limit: number | null }[];
  limits: {
    canSetCategoryLimits: boolean;
    canUseCustomCategories: boolean;
    canExport: boolean;
    historyMonths: number | null;
    earliestMonth: string | null;
  };
  availableCategories: string[];
  tier: string;
}

export function getBudget(month?: string) {
  return request<BudgetMonth>(`/budget${month ? `?month=${month}` : ""}`);
}

export function addBudgetEntry(entry: {
  amount: number;
  category: string;
  description?: string | null;
  spentAt?: string;
  productId?: string;
}) {
  return request<{ entry: BudgetEntry }>("/budget", { method: "POST", body: entry });
}

export function updateBudgetEntry(
  id: string,
  changes: { amount?: number; category?: string; description?: string | null; spentAt?: string },
) {
  return request<{ ok: true }>(`/budget/${id}`, { method: "PATCH", body: changes });
}

export function deleteBudgetEntry(id: string) {
  return request<{ ok: true }>(`/budget/${id}`, { method: "DELETE" });
}

/** `category: null` sets the overall monthly budget. `amount: null` clears it. */
export function setBudgetLimit(category: string | null, amount: number | null) {
  return request<{ ok: true; category: string | null; amount: number | null }>(
    "/budget/limits",
    { method: "PUT", body: { category, amount } },
  );
}

/** What to prefill the "I bought this" sheet with for a tracked product. */
export function getBudgetPrefill(productId: string) {
  return request<{
    productId: string;
    amount: number | null;
    category: string;
    description: string;
  }>(`/budget/prefill/${productId}`);
}

// ---- the sale verdict --------------------------------------------------------
//
// Kept from "Sweep this deal", which product lookup replaced. This was always
// the strongest thing that feature did — it's judged against the product's own
// recorded price history, so unlike everything else on a product page it comes
// from our data rather than the store's, and a retailer can't stage it.

export type SaleVerdict =
  | "genuine-low"      // Cheapest we've ever recorded.
  | "good-price"       // Meaningfully below its own usual.
  | "typical-price"    // The "sale" is just the normal price.
  | "above-usual"      // Currently pricier than normal.
  | "no-history";      // We haven't watched it long enough to say.

export interface SaleAssessment {
  verdict: SaleVerdict;
  headline: string;
  detail: string;
  /** The retailer's claimed discount, which may well be theatre. */
  claimedPercentOff: number | null;
  /** Whether that claim is believable on its face. Older servers omit it. */
  claimedConfidence?: DiscountConfidence | null;
  /** What it's actually worth against its own history. */
  realPercentBelowTypical: number | null;
}

// ---- product lookup ----------------------------------------------------------
//
// One enriched page about one product, replacing "Sweep this deal".
//
// Every field below is optional on purpose. Stores differ enormously in what
// they publish — Amazon returns a review summary with per-topic sentiment,
// eBay returns seller feedback and a delivery window and no product reviews at
// all, Etsy returns little of either. The page renders what arrived and omits
// the rest; it never fills a gap with something that looks similar.

export interface ReviewTopic {
  topic: string;
  positiveMentions: number;
  negativeMentions: number;
  description: string | null;
  quotes: string[];
}

export interface ReviewSummary {
  text: string | null;
  positive: string[];
  negative: string[];
  mixed: string[];
  topics: ReviewTopic[];
  images: string[];
}

export interface SellerInfo {
  name: string | null;
  ratingPercent: number | null;
  ratingCount: number | null;
  offerCount: number | null;
  url: string | null;
}

export interface ShippingInfo {
  /** Cents. 0 is free shipping; null means the store didn't quote one. */
  costCents: number | null;
  earliest: string | null;
  latest: string | null;
}

export interface TrustSignals {
  badge: string | null;
  amazonChoice: boolean;
  frequentlyReturned: boolean;
  frequentlyReturnedNote: string | null;
  boughtRecently: string | null;
  bestSellerRank: number | null;
  bestSellerCategory: string | null;
}

export interface ProductDetail {
  retailer: string;
  retailerId: string;
  title: string;
  url: string;
  price: number | null;
  listPrice: number | null;
  currency: string;
  availability: string | null;
  inStock: boolean | null;
  images: string[];
  brand: string | null;
  description: string | null;
  features: string[];
  specs: { label: string; value: string }[];
  rating: number | null;
  ratingCount: number | null;
  reviews: ReviewSummary | null;
  seller: SellerInfo | null;
  shipping: ShippingInfo | null;
  trust: TrustSignals | null;
  coupon: string | null;
  condition: string | null;
  fetchedAt: string;
}

/**
 * Which sections this store can fill at all.
 *
 * Sent by the server rather than inferred from nulls, because "eBay never
 * returns product reviews" and "this listing happens to have none" deserve
 * different wording.
 */
export interface DetailCoverage {
  reviews: boolean;
  seller: boolean;
  shipping: boolean;
  specs: boolean;
}

export interface SimilarProduct {
  productId: string;
  retailer: string;
  retailerLabel: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number;
  /** Positive means cheaper than the product being viewed. */
  saving: number;
  /**
   * "same" is a confident like-for-like; "similar" is explicitly not claimed
   * to be identical, and the caveats say why.
   */
  confidence: "same" | "similar";
  caveats: string[];
}

export interface LookupResult {
  detail: ProductDetail;
  /**
   * Whether this "sale" is real, judged against the product's own history.
   * The one claim on the page that comes from our data, not the store's.
   */
  sale: SaleAssessment | null;
  coverage: DetailCoverage;
  history: { price: number; checkedAt: string }[];
  /**
   * Other listings that look like the same thing, from what the server has
   * already cached — never a fresh store search.
   *
   * OPTIONAL because a server that predates this feature simply won't send
   * it, and the app has to survive that: a released build outlives whatever
   * backend was deployed the day it shipped, and there is always a window
   * mid-deploy where both are live. Undefined and empty mean the same thing
   * here — nothing to show.
   */
  similar?: SimilarProduct[];
  productId: string;
  isTracked: boolean;
  /** False when the store couldn't be reached and this came from cache. */
  fresh: boolean;
  staleReason: "blocked" | "failed" | "unsupported" | null;
}

export interface LookupQuota {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
  available: boolean;
}

export function getLookupQuota() {
  return request<{ quota: LookupQuota; tier: string; guest: boolean }>(
    "/lookup/quota",
  );
}

export function lookUpProduct(
  target: { productId: string } | { url: string } | { retailer: string; retailerId: string },
) {
  return request<LookupResult & { quota: LookupQuota; tier: string }>("/lookup", {
    method: "POST",
    body: target,
  });
}

// ---- notifications feed -------------------------------------------------------

export interface AppNotification {
  id: string;
  /** "price-drop" | "radar-match" | "announcement", open-ended by design. */
  kind: string;
  title: string;
  body: string;
  /** In-app path to open, or null when there's nowhere to go. */
  href: string | null;
  read: boolean;
  createdAt: string;
}

export function getNotifications() {
  return request<{ unread: number; notifications: AppNotification[] }>(
    "/notifications",
  );
}

/** Clears the badge. Separate from reading the list, deliberately. */
export function markNotificationsRead() {
  return request<{ cleared: number }>("/notifications/read", { method: "POST" });
}

/**
 * Delete one, for good.
 *
 * Nothing else removes a notification — they no longer expire — so this is the
 * only way the list ever gets shorter.
 */
export function deleteNotification(id: string) {
  return request<{ ok: true }>(`/notifications/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Delete the lot. */
export function clearNotifications() {
  return request<{ deleted: number }>("/notifications", { method: "DELETE" });
}

// ---- cart ----------------------------------------------------------------
//
// Not a checkout — Sweep sells nothing. A staging area for what you've decided
// to buy, gathered from wherever you found it, with a total no single shop can
// give you.

export interface CartItem {
  productId: string;
  quantity: number;
  title: string;
  imageUrl: string | null;
  url: string;
  retailer: string;
  retailerLabel: string;
  /** Cents. Null when the store isn't quoting a price right now. */
  price: number | null;
  priceAtAdd: number | null;
  /** Cents moved since it was added. Negative is cheaper. Null if unknown. */
  since: number | null;
  addedAt: string;
}

export interface Cart {
  items: CartItem[];
  /** Cents, across every store. */
  total: number;
  /** How the total has moved since things went in. Negative is good. */
  since: number;
  pricedCount: number;
  stores: { retailer: string; label: string; count: number; total: number }[];
}

export function getCart() {
  return request<Cart>("/cart");
}

export function addToCart(
  target: { productId: string } | { url: string } | { retailer: string; retailerId: string },
) {
  return request<Cart>("/cart", { method: "POST", body: target });
}

export function setCartQuantity(productId: string, quantity: number) {
  return request<Cart>(`/cart/${productId}`, { method: "PATCH", body: { quantity } });
}

export function removeFromCart(productId: string) {
  return request<Cart>(`/cart/${productId}`, { method: "DELETE" });
}

export function clearCart() {
  return request<Cart>("/cart", { method: "DELETE" });
}

// ---- deal radar --------------------------------------------------------------

export interface SavedSearch {
  id: string;
  keyword: string;
  targetPrice: number | null;
  createdAt: string;
  lastCheckedAt: string | null;
  lastBestPrice: number | null;
  lastMatchAt: string | null;
  nextCheckAt: string;
  unchangedChecks: number;
}

export interface RadarMatch {
  retailer: string;
  retailerLabel: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number;
  listPrice: number | null;
  rating: number | null;
  ratingCount: number | null;
}

export interface RadarRefreshes {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
}

/** Budget for creating a radar or changing its keyword. */
export interface RadarChanges {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
}

export function getRadar() {
  return request<{
    searches: SavedSearch[];
    limits: {
      maxSavedSearches: number;
      used: number;
      intervalMinutes: number;
      /** False on free — radars only run when the user refreshes them. */
      autoChecks: boolean;
    };
    refreshes: RadarRefreshes | null;
    changes: RadarChanges | null;
    tier: string;
  }>("/radar");
}

export function createRadar(keyword: string, targetPrice: number | null) {
  return request<{ search: SavedSearch }>("/radar", {
    method: "POST",
    body: { keyword, targetPrice },
  });
}

export function updateRadar(
  id: string,
  changes: { keyword?: string; targetPrice?: number | null },
) {
  return request<{ ok: true }>(`/radar/${id}`, { method: "PATCH", body: changes });
}

export function deleteRadar(id: string) {
  return request<{ ok: true }>(`/radar/${id}`, { method: "DELETE" });
}

/**
 * Begin a refresh. Returns once the stores have been kicked off, so matches
 * can appear one store at a time instead of all at the speed of the slowest.
 */
export function startRadarRefresh(id: string) {
  return request<{
    jobId: string;
    pending: { retailer: string; label: string }[];
    refreshes: RadarRefreshes | null;
  }>(`/radar/${id}/refresh/start`, { method: "POST" });
}

/** Matches derived from whatever has landed so far. Safe to call repeatedly. */
export function getRadarRefreshProgress(id: string, jobId: string) {
  return request<{
    done: boolean;
    matches: RadarMatch[];
    best: RadarMatch | null;
    isNewBest: boolean;
    unreachable: string[];
    pending: string[];
    refreshes: RadarRefreshes | null;
  }>(`/radar/${id}/refresh/${jobId}`);
}

export function refreshRadar(id: string) {
  return request<{
    matches: RadarMatch[];
    best: RadarMatch | null;
    unreachable: string[];
    isNewBest: boolean;
    refreshes: RadarRefreshes | null;
  }>(`/radar/${id}/refresh`, { method: "POST" });
}

/**
 * Permanently delete the signed-in account and everything attached to it.
 *
 * Required by Google Play. Irreversible — the confirmation flag is enforced
 * server-side too, so this can't fire from a stray call.
 */
export function deleteAccount(password?: string) {
  // Omitted for an account with no password — a Google account. The server
  // then requires a sign-in from the last few minutes instead, which the
  // profile screen gets by showing the Google picker immediately beforehand.
  return request<{
    ok: true;
    deleted: Record<string, number>;
    authRecordRemoved: boolean;
  }>("/me", { method: "DELETE", body: { confirm: true, ...(password ? { password } : {}) } });
}

// ---- promo codes -------------------------------------------------------------
//
// A grant is not a subscription, and the app has to keep them apart. Someone on
// granted Pro must not be offered "Cancel subscription" — that opens Play and
// shows them nothing to cancel.

export interface PromoGrant {
  tier: string;
  /** ISO date. */
  expiresAt: string;
  daysLeft: number;
}

export interface PromoStatus {
  /** Null when there's no active grant. */
  grant: PromoGrant | null;
  effectiveTier: string;
}

export type RedeemResult =
  | {
      ok: true;
      tier: string;
      expiresAt: string;
      days: number;
      effectiveTier: string;
      /** True when a paid subscription already beats this grant. */
      overshadowed: boolean;
      message: string;
    }
  | { ok: false; reason: string; message: string };

/**
 * Failures come back as 200 with ok:false and a message written for the user,
 * so this returns the body either way rather than throwing on a bad code.
 */
export function redeemPromoCode(code: string) {
  return request<RedeemResult>("/promo/redeem", { method: "POST", body: { code } });
}

export function getPromoStatus() {
  return request<PromoStatus>("/promo/status");
}

// ---- search history ----------------------------------------------------------
//
// Reopening a past search costs no quota and hits no retailer — the server
// rebuilds it from products it already holds. Prices are read live, so a search
// reopened a week later shows this week's prices rather than a snapshot.

export interface HistoryEntry {
  id: string;
  keyword: string;
  /** How many results it returned when it ran. */
  resultCount: number;
  storeCount: number;
  /** ISO date. */
  searchedAt: string;
}

export interface ReopenedSearch {
  keyword: string;
  searchedAt: string;
  /** True when some results are no longer available to show. */
  partial: boolean;
  originalCount: number;
  products: SearchProduct[];
  highlights: Highlight[];
}

export function getSearchHistory() {
  return request<{ searches: HistoryEntry[]; limit: number }>("/search/history");
}

export function reopenSearch(id: string) {
  return request<ReopenedSearch>(`/search/history/${id}`);
}

export function forgetSearch(id: string) {
  return request<{ ok: true }>(`/search/history/${id}`, { method: "DELETE" });
}

export function clearSearchHistory() {
  return request<{ ok: true; removed: number }>("/search/history", { method: "DELETE" });
}
