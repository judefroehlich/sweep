// app/(tabs)/tracking.tsx
//
// Everything the user is watching, sorted by how good a deal each one is right
// now rather than by when it was added.

import AddByLink from "@/components/AddByLink";
import AddToListSheet, { type ListTarget } from "@/components/AddToListSheet";
import CardActionSheet from "@/components/CardActionSheet";
import type { CardAction } from "@/components/ProductCard";
import BudgetEntrySheet, { type EntryDraft } from "@/components/BudgetEntrySheet";
import ConfirmDialog from "@/components/ConfirmDialog";
import ProductCard from "@/components/ProductCard";
import SortMenu from "@/components/SortMenu";
import TrackedItemSheet from "@/components/TrackedItemSheet";
import {
  Button,
  EmptyState,
  ErrorBanner,
  Loading,
  Screen,
} from "@/components/ui";
import { type Palette, radius, spacing, type } from "@/constants/theme";
import { useTheme, useThemedStyles } from "@/lib/theme";
import { useTranslate } from "@/lib/i18n";
import { maybeAskForReview } from "@/lib/reviewPrompt";
import { toast } from "@/lib/toast";
import { storeListPhrase } from "@/lib/format";
import {
  ApiError,
  addToCart,
  type Schedule,
  type TrackedProduct,
  getSchedule,
  getTrackedProducts,
  untrackProduct,
  getBudget,
  getBudgetPrefill,
} from "@/lib/api";
import { formatPrice, percentOff, retailerLabel } from "@/lib/format";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

export default function TrackingScreen() {
  const params = useLocalSearchParams<{ addUrl?: string }>();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const t = useTranslate();
  const router = useRouter();

  const [tracked, setTracked] = useState<TrackedProduct[] | null>(null);
  const [limits, setLimits] = useState<{
    maxTrackedProducts: number;
    used: number;
  } | null>(null);
  const [tier, setTier] = useState("free");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [editing, setEditing] = useState<TrackedProduct | null>(null);
  // The card keeps two buttons; everything else opens here, the same sheet
  // search uses.
  const [sheet, setSheet] = useState<{ subject: string; actions: CardAction[] } | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [listTarget, setListTarget] = useState<ListTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("deal");
  const [showSort, setShowSort] = useState(false);
  const [query, setQuery] = useState("");
  const [boughtDraft, setBoughtDraft] = useState<EntryDraft | null>(null);
  const [budgetCategories, setBudgetCategories] = useState<string[]>([]);
  const [canCustomCategories, setCanCustomCategories] = useState(false);
  // Remembered so the "stop tracking it too?" prompt after logging knows which
  // tracked row to remove.
  const [boughtItem, setBoughtItem] = useState<TrackedProduct | null>(null);
  // The tracked row the "stop tracking too?" dialog is asking about.
  const [confirmUntrack, setConfirmUntrack] = useState<TrackedProduct | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getTrackedProducts();
      setTracked(result.tracked);
      setLimits(result.limits);
      setTier(result.tier);
      setError(null);
      // Needed by the edit sheet: how many check times this plan allows, and
      // whether it uses fixed times at all.
      setSchedule(await getSchedule().catch(() => null));
    } catch (err) {
      const apiError = err as ApiError;
      // A guest landing here has no account — send them to sign up rather than
      // showing a bare 401.
      if (apiError.status === 401) {
        setTracked([]);
        setError(null);
      } else {
        setError(apiError.message);
      }
    }
  }, []);

  // Prices update in the background while the user is elsewhere in the app, so
  // this re-reads on focus rather than once on mount.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      load().finally(() => {
        if (cancelled) return;
      });
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  /**
   * "I bought this" — opens the log sheet prefilled from the product.
   *
   * The prefill is a server call because the price and a category guess both
   * live there; if it fails we still open the sheet, just empty. Refusing to
   * log a purchase because a guess didn't load would be absurd.
   */
  async function openBought(item: TrackedProduct) {
    setBoughtItem(item);
    setBoughtDraft({
      amount: item.product.price,
      category: "Other",
      description: item.product.title,
      productId: item.product.id,
      productTitle: item.product.title,
    });

    try {
      const [prefill, budget] = await Promise.all([
        getBudgetPrefill(item.product.id),
        getBudget(),
      ]);
      setBudgetCategories(budget.availableCategories);
      setCanCustomCategories(budget.limits.canUseCustomCategories);
      setBoughtDraft({
        amount: prefill.amount,
        category: prefill.category,
        description: prefill.description,
        productId: item.product.id,
        productTitle: item.product.title,
      });
    } catch {
      // Keep the local draft above.
    }
  }

  /**
   * Once something is bought, watching its price is usually pointless — and a
   * tracking slot is a scarce thing on the free tier. Offered, never automatic:
   * people do track items they've already bought, to watch for a price-drop
   * refund window.
   */
  function offerUntrack(item: TrackedProduct) {
    setConfirmUntrack(item);
  }

  async function onUntrack(item: TrackedProduct) {
    setRemoving(item.id);
    // Optimistic: the row disappears immediately, and comes back if the server
    // rejects it.
    const previous = tracked;
    setTracked((current) => current?.filter((t) => t.id !== item.id) ?? null);

    try {
      await untrackProduct(item.id);
      setLimits((current) =>
        current ? { ...current, used: Math.max(0, current.used - 1) } : current,
      );
    } catch (err) {
      setTracked(previous);
      setError((err as ApiError).message);
    } finally {
      setRemoving(null);
    }
  }

  // Above the early return, and it has to stay there. A hook after a
  // conditional return is called on some renders and not others, which is the
  // "Rendered more hooks than during the previous render" crash: this screen
  // returns <Loading /> until the first fetch lands, so the very first render
  // skipped it and the second did not.
  //
  // Filter first, then sort. The other order sorts rows that are about to be
  // thrown away, which on a hundred-item Ultimate list is work for nothing.
  const sorted = useMemo(
    () =>
      (tracked ?? [])
        .filter((item) => matchesQuery(item, query))
        .sort(SORTS[sortKey]),
    [tracked, query, sortKey],
  );

  if (tracked === null && !error) return <Loading />;

  const atLimit = limits ? limits.used >= limits.maxTrackedProducts : false;

  return (
    <Screen>
      {error && <ErrorBanner message={error} onRetry={load} />}
      {notice && <Text style={styles.notice}>{notice}</Text>}

      {limits && (
        <View style={styles.limitRow}>
          <Text style={styles.limitText}>
            {limits.used} of {limits.maxTrackedProducts} tracked
            {tier !== "free" ? ` · ${tier}` : ""}
          </Text>
          {atLimit && <Text style={styles.limitFull}>{t("tracking.limitReached")}</Text>}
        </View>
      )}

      {/* Two, not four. The first version of this gated at four on the grounds
          that sorting three rows is noise — but the free tier's ceiling IS
          three tracked products, so a gate of four hid sorting and filtering
          from every free user permanently. A threshold above the tier limit is
          not a threshold, it is an off switch.

          One item still gets nothing, because there is genuinely nothing to
          order or filter. */}
      {(tracked?.length ?? 0) >= 2 && (
        <View style={styles.controls}>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={15} color={colors.textTertiary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("tracking.filterPlaceholder")}
              placeholderTextColor={colors.textTertiary}
              style={styles.searchInput}
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery("")} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
              </Pressable>
            )}
          </View>

          <Pressable
            onPress={() => setShowSort(true)}
            style={({ pressed }) => [styles.sortButton, pressed && styles.sortPressed]}
            accessibilityRole="button"
          >
            <Ionicons name="swap-vertical" size={15} color={colors.textSecondary} />
            <Text style={styles.sortLabel}>{t(SORT_LABELS[sortKey])}</Text>
          </Pressable>
        </View>
      )}

      <AddByLink
        // Arrives from "Track price" on the product lookup page, which used
        // to navigate here and leave the field empty — asking someone to
        // re-find a link they were already looking at.
        initialUrl={typeof params.addUrl === "string" ? params.addUrl : undefined}
        disabled={atLimit}
        disabledReason={
          limits
            ? t("tracking.limitBody", { count: limits.maxTrackedProducts })
            : undefined
        }
        onTracked={(added) => {
          setError(null);

          // Tracking is idempotent server-side, so pasting a link for something
          // already in the list must not double-count against the plan limit.
          const isNew = !(tracked ?? []).some((t) => t.id === added.id);

          // Prepend rather than refetch: the server already returned the full
          // record, so a round trip would only add latency.
          setTracked((current) => [
            added,
            ...(current ?? []).filter((t) => t.id !== added.id),
          ]);
          if (isNew) {
            setLimits((current) =>
              current ? { ...current, used: current.used + 1 } : current,
            );
          }

          // A moment the app has just been useful, which is the only kind
          // worth asking on. Fire-and-forget: it decides for itself whether
          // this is the right time, and stays silent when it isn't.
          void maybeAskForReview();

          router.push(`/product/${added.product.id}`);
        }}
      />

      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          sorted.length === 0 ? styles.emptyList : styles.list
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          // Two different empties. Tracking nothing wants the explanation and
          // a way to start; a filter that matched nothing wants telling that
          // the list still exists, or it reads as everything having vanished.
          query.trim().length > 0 && (tracked?.length ?? 0) > 0 ? (
            <EmptyState
              title={t("tracking.filterNone")}
              body={t("tracking.filterNoneBody")}
              action={
                <Button
                  label={t("common.clear")}
                  onPress={() => setQuery("")}
                  variant="secondary"
                />
              }
            />
          ) : (
            <EmptyState
              title={t("tracking.empty")}
              // Named Target, which Sweep doesn't support, and left out two
              // stores it does.
              body={t("tracking.emptyBody", { stores: storeListPhrase() })}
              action={
                <Button
                  label={t("tracking.compareInstead")}
                  onPress={() => router.push("/search")}
                  variant="secondary"
                />
              }
            />
          )
        }
        renderItem={({ item }) => {
          // What's happened since THIS user started watching — the number that
          // actually answers "was tracking it worth it?". Retailer list price
          // is a marketing claim; this is measured.
          const since = movementSinceTracking(
            item.product.price,
            item.priceAtTracking,
          );
          return (
            <View style={styles.cardWrap}>
              <ProductCard
                title={item.product.title}
                retailer={item.product.retailer}
                price={item.product.price}
                listPrice={item.product.listPrice}
                imageUrl={item.product.imageUrl}
                rating={item.product.rating}
                ratingCount={item.product.ratingCount}
                lastCheckedAt={item.product.lastCheckedAt}
                note={since?.text ?? null}
                noteTone={since?.tone}
                trend={item.trend}
                onPress={() => router.push(`/product/${item.product.id}`)}
                onShowActions={(actions) =>
                  setSheet({ subject: item.product.title, actions })
                }
                actions={[
                  // In importance order: the card keeps the first two, the
                  // rest open in the sheet. Tracked items have real history,
                  // so the sale verdict is far stronger here than on a cold
                  // search result, and the alert threshold is the setting
                  // someone actually comes back to change.
                  {
                    key: "details",
                    icon: "reader-outline",
                    label: t("search.details"),
                    tone: "accent" as const,
                    onPress: () => router.push(`/lookup?productId=${item.product.id}`),
                  },
                  {
                    key: "edit",
                    icon: "notifications-outline",
                    label: t("tracking.alertAction"),
                    busy: removing === item.id,
                    onPress: () => setEditing(item),
                  },
                  {
                    key: "cart",
                    icon: "cart-outline",
                    label: t("cart.add"),
                    onPress: async () => {
                      // Was fire-and-forget with the error swallowed, which on
                      // a long list meant a tap with no visible result — the
                      // exact "is this button broken?" problem.
                      try {
                        await addToCart({ productId: item.product.id });
                        toast(t("cart.added"));
                      } catch (err) {
                        toast((err as ApiError).message, "bad");
                      }
                    },
                  },
                  {
                    key: "list",
                    icon: "list-outline",
                    label: "List",
                    onPress: () =>
                      setListTarget({
                        retailer: item.product.retailer,
                        retailerId: item.product.retailerId,
                        title: item.product.title,
                        url: item.product.url,
                      }),
                  },
                  {
                    key: "bought",
                    icon: "cart-outline",
                    label: "Bought",
                    onPress: () => openBought(item),
                  },
                ]}
              />
              {item.product.lastStatus &&
                item.product.lastStatus !== "success" && (
                  <Text style={styles.staleWarning}>
                    {item.product.lastStatus === "blocked"
                      ? t("tracking.storeBlocking")
                      : t("tracking.checkFailed")}
                  </Text>
                )}
            </View>
          );
        }}
      />
      {/* One sheet for the screen rather than one per card. */}
      <CardActionSheet
        subject={sheet?.subject ?? null}
        actions={sheet?.actions ?? []}
        onClose={() => setSheet(null)}
      />

      <AddToListSheet
        product={listTarget}
        onClose={() => setListTarget(null)}
        onAdded={(name) => setNotice(`Added to ${name}.`)}
      />

      <BudgetEntrySheet
        draft={boughtDraft}
        categories={budgetCategories}
        canUseCustomCategories={canCustomCategories}
        onClose={() => setBoughtDraft(null)}
        onSaved={() => {
          const item = boughtItem;
          setNotice(t("tracking.addedToBudget"));
          if (item) offerUntrack(item);
        }}
      />

      <SortMenu
        visible={showSort}
        title={t("tracking.sortBy")}
        options={(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
          key,
          label: t(SORT_LABELS[key]),
          hint: t(SORT_HINTS[key]),
        }))}
        value={sortKey}
        onPick={setSortKey}
        onClose={() => setShowSort(false)}
      />

      <ConfirmDialog
        content={
          confirmUntrack && {
            icon: "checkmark-circle",
            title: t("tracking.loggedIt"),
            body: t("tracking.stopToo"),
            subject: {
              title: confirmUntrack.product.title,
              imageUrl: confirmUntrack.product.imageUrl,
              caption: `Tracking since ${new Date(confirmUntrack.addedAt).toLocaleDateString(
                undefined,
                { month: "short", day: "numeric" },
              )}`,
            },
            confirmLabel: t("tracking.stopTracking"),
            cancelLabel: t("tracking.keepTracking"),
          }
        }
        onCancel={() => setConfirmUntrack(null)}
        onConfirm={() => {
          const item = confirmUntrack;
          setConfirmUntrack(null);
          if (item) void onUntrack(item);
        }}
      />

      <TrackedItemSheet
        item={editing}
        schedule={schedule}
        // Threshold editing is Pro and above; the server enforces it too.
        canSetThreshold={tier === "pro" || tier === "ultimate"}
        onClose={() => setEditing(null)}
        onChanged={load}
        onRemove={onUntrack}
      />
    </Screen>
  );
}

/**
 * Movement since this user started watching.
 *
 * ALWAYS shown when we have an anchor, including "no change" — because the
 * card also displays the retailer's own "23% off list" badge, and those two
 * numbers are easy to confuse. If you start tracking something already
 * discounted, the badge says 23% off while nothing has actually moved since1
 * you started. Saying so explicitly is the only way to tell them apart.
 */
function movementSinceTracking(
  current: number | null,
  atTracking: number | null,
): { text: string; tone: "good" | "bad" | "neutral" } | null {
  if (current === null || atTracking === null || atTracking <= 0) return null;

  const delta = atTracking - current;
  const percent = Math.round((Math.abs(delta) / atTracking) * 100);

  // Sub-1% movement rounds to 0% and would read as a contradiction.
  if (delta === 0 || percent < 1) {
    return {
      text: `Same as when you started (${formatPrice(atTracking)})`,
      tone: "neutral",
    };
  }

  return delta > 0
    ? {
        text: `Down ${formatPrice(delta)} (${percent}%) since you started`,
        tone: "good",
      }
    : {
        text: `Up ${formatPrice(-delta)} (${percent}%) since you started`,
        tone: "bad",
      };
}

/**
 * Sort key: how good a deal this is right now. Discount off list is the honest
 * signal we have on this screen — the deeper "% below historical average" needs
 * the full history, which lives on the detail screen.
 */
function dealScore(item: TrackedProduct): number {
  return percentOff(item.product.price, item.product.listPrice) ?? 0;
}

/**
 * How much the price has moved since this user started watching, as a share of
 * what they first saw.
 *
 * Proportional rather than absolute on purpose: $20 off a $40 item is a better
 * catch than $20 off a $900 one, and a list sorted by dollars would put every
 * expensive thing first regardless of whether anything happened to it.
 *
 * Positive means it fell. Null prices score zero rather than sorting to an end,
 * since "we do not know" is not the same as "no change".
 */
function dropSinceTracking(item: TrackedProduct): number {
  const started = item.priceAtTracking;
  const now = item.product.price;
  if (started === null || now === null || started === 0) return 0;
  return ((started - now) / started) * 100;
}

export type SortKey = "deal" | "drop" | "newest" | "cheapest" | "name";

export const SORT_HINTS = {
  deal: "tracking.sortDealHint",
  drop: "tracking.sortDropHint",
  newest: "tracking.sortNewestHint",
  cheapest: "tracking.sortCheapestHint",
  name: "tracking.sortNameHint",
} as const;

export const SORT_LABELS = {
  deal: "tracking.sortDeal",
  drop: "tracking.sortDrop",
  newest: "tracking.sortNewest",
  cheapest: "tracking.sortCheapest",
  name: "tracking.sortName",
} as const;

const SORTS: Record<SortKey, (a: TrackedProduct, b: TrackedProduct) => number> = {
  deal: (a, b) => dealScore(b) - dealScore(a),
  drop: (a, b) => dropSinceTracking(b) - dropSinceTracking(a),
  newest: (a, b) => +new Date(b.addedAt) - +new Date(a.addedAt),
  // Missing prices last. A row with no price is the least useful answer to
  // "what is cheapest", so it does not get to sit at the top of that list.
  cheapest: (a, b) =>
    (a.product.price ?? Number.POSITIVE_INFINITY) -
    (b.product.price ?? Number.POSITIVE_INFINITY),
  name: (a, b) => a.product.title.localeCompare(b.product.title),
};

/** Matches on title and store, because "amazon" is a thing people type. */
function matchesQuery(item: TrackedProduct, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.product.title.toLowerCase().includes(q) ||
    retailerLabel(item.product.retailer).toLowerCase().includes(q)
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    controls: {
      flexDirection: "row",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    searchWrap: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 8,
    },
    searchInput: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: type.label.fontSize,
      padding: 0,
    },
    sortButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 8,
    },
    sortPressed: { opacity: 0.7 },
    sortLabel: {
      color: colors.textSecondary,
      fontSize: type.caption.fontSize,
      fontWeight: "700",
    },
    limitRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    limitText: {
      color: colors.textSecondary,
      fontSize: type.label.fontSize,
      fontWeight: "600",
    },
    limitFull: {
      color: colors.warning,
      fontSize: type.caption.fontSize,
      fontWeight: "800",
      backgroundColor: colors.surface,
      borderRadius: radius.sm,
      paddingHorizontal: 8,
      paddingVertical: 3,
      overflow: "hidden",
    },
    notice: {
      color: colors.success,
      fontSize: type.label.fontSize,
      fontWeight: "700",
      paddingHorizontal: spacing.md,
      paddingTop: spacing.xs,
    },
    list: { padding: spacing.md, gap: spacing.sm },
    emptyList: { flexGrow: 1 },
    cardWrap: { marginBottom: spacing.sm },
    staleWarning: {
      color: colors.warning,
      fontSize: type.caption.fontSize,
      paddingHorizontal: spacing.sm,
      paddingTop: 4,
    },
  });
