// app/(tabs)/index.tsx
//
// Home — the landing screen, and the app's pitch in one view.
//
// Deliberately led by SEARCH rather than by tracking. Price tracking is a
// commodity — Keepa and CamelCamelCamel have done it for years — so opening on
// a list of tracked items would frame Sweep as a worse version of something
// free. Comparing every store in one query is the part they don't do, so it
// gets the hero slot and tracking sits below it as a supporting feature.

import { useCallback, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Loading, Screen, SectionTitle } from "@/components/ui";
import { type Palette, radius, spacing, type } from "@/constants/theme";
import { setPushRegistered, usePushRegistered } from "@/lib/pushStatus";
import { useTheme, useThemedStyles } from "@/lib/theme";
import { useTranslate } from "@/lib/i18n";
import { setUnreadCount } from "@/lib/unreadCount";
import StoreTroubleSheet from "@/components/StoreTroubleSheet";
import { setLiveStores, storesInTrouble } from "@/lib/liveStores";
import {
  getNotificationStatus,
  getQuota,
  getNotifications,
  getRetailerStatus,
  getTrackedProducts,
  type TrackedProduct,
} from "@/lib/api";
import {
  RETAILERS,
  formatPrice,
  formatRelativeTime,
  retailerColor,
  retailerLabel,
  storeListPhrase,
} from "@/lib/format";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

const TIER_LABEL: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  ultimate: "Ultimate",
};

export default function HomeScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const t = useTranslate();
  const [storeHelpOpen, setStoreHelpOpen] = useState(false);
  const router = useRouter();

  const [tracked, setTracked] = useState<TrackedProduct[]>([]);
  // Null while unknown — defaulting to "free" told offline users they were on
  // the free plan instead of admitting we hadn't reached the server.
  const [tier, setTier] = useState<string | null>(null);
  const [searchesLeft, setSearchesLeft] = useState<number | null>(null);
  const [isGuest, setIsGuest] = useState(false);
  const pushOn = usePushRegistered();
  const [downStores, setDownStores] = useState<
    { retailer: string; label: string; enabled?: boolean }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // Every one of these is allowed to fail independently — Home should still
    // render something useful if one endpoint is down.
    const [products, quota, push, stores, notifications] = await Promise.all([
      getTrackedProducts().catch(() => null),
      getQuota().catch(() => null),
      getNotificationStatus().catch(() => null),
      getRetailerStatus().catch(() => null),
      // Guests have no feed, and a server that predates it has no endpoint —
      // both land here as "nothing unread", which drops the badge. The bell
      // itself stays put either way.
      getNotifications().catch(() => null),
    ]);

    // Fed into the shared store rather than kept here: the badge lives in the
    // tab header, and Home is already fetching the number anyway, so this
    // saves the header a second request.
    setUnreadCount(notifications?.unread ?? 0);
    // Keeps the store names in Home's own hero copy honest, and every other
    // screen's along with it.
    setLiveStores(stores?.retailers);

    if (products) {
      setTracked(products.tracked);
    }
    if (quota) {
      setTier(quota.tier);
      setSearchesLeft(quota.quota.remaining);
      setIsGuest(quota.isGuest);
    }
    setPushRegistered(push?.registered ?? null);
    // Only stores that are BOTH switched on and failing.
    //
    // Without the enabled check this counted the three stores we've turned off
    // ourselves, so Home permanently read "3 stores having trouble" — a
    // standing warning about nothing, which is worse than no warning at all
    // because it also hides a real outage in the noise.
    //
    // `enabled !== false` rather than `enabled`, since an older server omits
    // the field and absence means "no opinion", not "switched off".
    setDownStores(storesInTrouble(stores?.retailers ?? []));
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (loading) return <Loading />;

  // What actually happened to the things this person watches. Home used to
  // show one card — the steepest discount off list — which is a fact about the
  // retailer's own sticker, not about anything that changed. Someone opening
  // the app wants to know what moved since they last looked, and if nothing
  // did, to be told that plainly instead of left to guess.
  const moved = movedItems(tracked);
  const lastChecked = tracked
    .map((t) => t.product.lastCheckedAt)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        {/* Shown to someone with nothing tracked yet, who still needs telling
            what this is. A returning user gets the space back for their own
            prices — they know what app they opened. */}
        {tracked.length === 0 && (
          <View style={styles.brand}>
            <Text style={styles.brandName}>Sweep</Text>
            <Text style={styles.brandTagline}>{t("home.tagline")}</Text>
          </View>
        )}

        {/* ---- the pitch: one search, every store ---- */}
        <Pressable
          style={({ pressed }) => [styles.searchHero, pressed && styles.pressed]}
          onPress={() => router.push("/search")}
        >
          <View style={styles.searchHeroTop}>
            <Ionicons name="search" size={20} color={colors.accent} />
            <Text style={styles.searchHeroTitle}>{t("home.heroTitle")}</Text>
          </View>
          <Text style={styles.searchHeroBody}>
            {t("home.heroBody", { stores: storeListPhrase() })}
          </Text>
          <View style={styles.searchHeroFooter}>
            <View style={styles.storeDots}>
              {RETAILERS.map((r) => (
                <View
                  key={r}
                  style={[styles.storeDot, { backgroundColor: retailerColor(colors, r) }]}
                />
              ))}
            </View>
            <Text style={styles.searchHeroMeta}>
              {searchesLeft === null
                ? t("home.heroOneSearch")
                : t(
                    searchesLeft === 1 ? "home.searchLeftShort" : "home.searchesLeftShort",
                    { count: searchesLeft },
                  )}
            </Text>
          </View>
        </Pressable>

        {/* ---- what changed while you were away ---- */}
        {tracked.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.changedHead}>
              <SectionTitle>{t("home.changed")}</SectionTitle>
              {tracked.length > moved.length && moved.length > 0 && (
                <Pressable onPress={() => router.push("/tracking")} hitSlop={8}>
                  <Text style={styles.seeAll}>
                    {t("home.seeAll", { count: tracked.length })}
                  </Text>
                </Pressable>
              )}
            </View>

            {moved.length > 0 ? (
              moved.map((m) => (
                <Pressable
                  key={m.item.id}
                  style={({ pressed }) => [styles.movedRow, pressed && styles.pressed]}
                  onPress={() => router.push(`/product/${m.item.product.id}`)}
                >
                  <Ionicons
                    name={m.down ? "trending-down" : "trending-up"}
                    size={18}
                    color={m.down ? colors.success : colors.warning}
                  />
                  <View style={styles.movedText}>
                    <Text style={styles.movedTitle} numberOfLines={1}>
                      {m.item.product.title}
                    </Text>
                    <Text style={styles.movedMeta}>
                      {formatPrice(m.item.product.price)} ·{" "}
                      {retailerLabel(m.item.product.retailer)}
                    </Text>
                  </View>
                  <Text style={[styles.movedDelta, m.down ? styles.movedDown : styles.movedUp]}>
                    {t(m.down ? "home.changedDown" : "home.changedUp", {
                      amount: formatPrice(m.amount),
                    })}
                  </Text>
                </Pressable>
              ))
            ) : (
              // Said out loud rather than left as an empty space. "Nothing
              // moved" is a real answer, and the check time is what makes it
              // believable.
              <View style={styles.quietCard}>
                <Ionicons name="checkmark-circle-outline" size={18} color={colors.textSecondary} />
                <View style={styles.movedText}>
                  <Text style={styles.quietTitle}>{t("home.nothingMoved")}</Text>
                  <Text style={styles.quietBody}>
                    {t(tracked.length === 1 ? "home.nothingMovedOne" : "home.nothingMovedBody", {
                      count: tracked.length,
                      when: lastChecked ? formatRelativeTime(lastChecked) : "—",
                    })}
                  </Text>
                </View>
              </View>
            )}
          </View>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.watchEmpty, pressed && styles.pressed]}
            onPress={() => router.push("/tracking")}
          >
            <Ionicons name="pricetag-outline" size={18} color={colors.textSecondary} />
            <View style={styles.movedText}>
              <Text style={styles.quietTitle}>{t("home.trackSomething")}</Text>
              <Text style={styles.quietBody}>{t("home.trackSomethingBody")}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
          </Pressable>
        )}

        {/* ---- things that need fixing ---- */}
        {(pushOn === false || isGuest) && (
          <View style={styles.section}>
            <SectionTitle>{t("home.needsAttention")}</SectionTitle>

            {isGuest && (
              <ActionCard
                icon="person-add-outline"
                tone="accent"
                title={t("home.createAccount")}
                body={t("home.guestBody")}
                onPress={() => router.push("/auth")}
              />
            )}

            {pushOn === false && !isGuest && (
              <ActionCard
                icon="notifications-off-outline"
                tone="warning"
                title={t("home.alertsOff")}
                body={t("home.alertsOffBody")}
                onPress={() => router.push("/profile")}
              />
            )}
          </View>
        )}

        {/* Above the shortcuts, where the store-down banner used to sit —
            it's the same information, so it keeps the same place. Small and
            quiet, but always present: a store dropping out looks like our
            bug from the outside, and someone who thinks the app is broken
            stops trusting the prices that are fine. */}
        {/* Only when something is actually wrong. This used to sit here
            permanently, which put a support link in the middle of the home
            screen for the 99% of days when every store works — and a standing
            "is a retailer broken?" prompt plants the idea that one is. The
            full list lives in Profile, where someone who wants it will look. */}
        {downStores.length > 0 && (
        <Pressable
          onPress={() => setStoreHelpOpen(true)}
          hitSlop={8}
          style={({ pressed }) => [
            styles.storeHelp,
            downStores.length > 0 && styles.storeHelpDown,
            pressed && styles.pressed,
          ]}
        >
          <Ionicons
            name={
              downStores.length > 0 ? "build-outline" : "help-circle-outline"
            }
            size={15}
            color={downStores.length > 0 ? colors.warning : colors.textSecondary}
          />
          <Text
            style={[
              styles.storeHelpText,
              downStores.length > 0 && styles.storeHelpTextDown,
            ]}
          >
            {downStores.length === 0
              ? t("storeTrouble.button")
              : downStores.length === 1
                ? t("storeTrouble.buttonDownOne", { store: downStores[0].label })
                : t("storeTrouble.buttonDownMany", { count: downStores.length })}
          </Text>
        </Pressable>
        )}

        <View style={styles.section}>
          <SectionTitle>{t("home.shortcuts")}</SectionTitle>
          <View style={styles.shortcutGrid}>
            {/* First in the grid deliberately: this is the thing the app is
                for now, not a utility alongside the budget. */}
            <Shortcut
              icon="reader-outline"
              label={t("home.lookup")}
              hint={t("home.lookupHint")}
              onPress={() => router.push("/lookup")}
            />
            {/* Moved off the tab bar to make room for the cart. Still worth a
                place — it's the social half of the app. */}
            <Shortcut
              icon="flame-outline"
              label={t("home.deals")}
              hint={t("home.dealsHint")}
              onPress={() => router.push("/(tabs)/deals")}
            />
            <Shortcut
              icon="radio-outline"
              label={t("home.radar")}
              hint={t("home.radarHint")}
              onPress={() => router.push("/radar")}
            />
            <Shortcut
              icon="list-outline"
              label={t("home.lists")}
              hint={t("home.listsHint")}
              onPress={() => router.push("/lists")}
            />
            <Shortcut
              icon="wallet-outline"
              label={t("home.budget")}
              hint={t("home.budgetHint")}
              onPress={() => router.push("/budget")}
            />
            <Shortcut
              icon="trophy-outline"
              label={t("home.leaderboard")}
              hint={t("home.leaderboardHint")}
              onPress={() => router.push("/leaderboard")}
            />
          </View>

          {/* A row rather than the floating button this started as: a floating
              control sits on top of content permanently to be tapped once,
              and the answer it leads to is worth reading once, not hovering
              over forever. */}
          <Pressable
            style={styles.whyLimited}
            onPress={() => router.push("/why-limited")}
          >
            <Ionicons
              name="help-circle-outline"
              size={17}
              color={colors.textSecondary}
            />
            <Text style={styles.whyLimitedText}>{t("home.whyLimited")}</Text>
            <Ionicons
              name="chevron-forward"
              size={15}
              color={colors.textTertiary}
            />
          </Pressable>
        </View>

        <StoreTroubleSheet
          visible={storeHelpOpen}
          downStores={downStores}
          onClose={() => setStoreHelpOpen(false)}
          onSeeStatus={() => {
            setStoreHelpOpen(false);
            router.push("/profile");
          }}
        />

        {/* ---- plan ---- */}
        <Pressable
          style={({ pressed }) => [styles.planCard, pressed && styles.pressed]}
          onPress={() => router.push("/plans")}
        >
          <View style={styles.planLeft}>
            <Text style={styles.planLabel}>{t("home.yourPlan")}</Text>
            <Text style={[styles.planTier, !tier && styles.planUnknown]}>
              {tier ? (TIER_LABEL[tier] ?? tier) : t("home.notConfirmed")}
            </Text>
          </View>
          {tier === null || tier === "free" ? (
            <View style={styles.upgradePill}>
              <Text style={styles.upgradeText}>{t("home.seeUpgrades")}</Text>
            </View>
          ) : (
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          )}
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

/**
 * Tracked items whose price has actually moved, steepest first.
 *
 * Movement is measured against what this person first saw, not against the
 * retailer's list price: "73% off list" is the shop's own claim and is often
 * permanent, while "$4 cheaper than when you started watching" is a fact about
 * the thing they asked us to watch.
 *
 * Sub-1% wobble is left out. A 12 cent drift on a $40 item is not news, and a
 * list of non-events trains people to ignore the screen.
 */
function movedItems(tracked: TrackedProduct[]) {
  return tracked
    .map((item) => {
      const now = item.product.price;
      const then = item.priceAtTracking;
      if (now === null || then === null || then <= 0) return null;
      const amount = Math.abs(then - now);
      if (amount / then < 0.01) return null;
      return { item, amount, down: now < then };
    })
    .filter((m): m is { item: TrackedProduct; amount: number; down: boolean } => m !== null)
    .sort((a, b) => b.amount / b.item.priceAtTracking! - a.amount / a.item.priceAtTracking!)
    .slice(0, 3);
}

function ActionCard({
  icon,
  title,
  body,
  tone,
  onPress,
}: {
  icon: IoniconName;
  title: string;
  body: string;
  tone: "accent" | "warning";
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const accentColor = tone === "warning" ? colors.warning : colors.accent;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionCard,
        { borderColor: accentColor },
        pressed && styles.pressed,
      ]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={20} color={accentColor} />
      <View style={styles.actionText}>
        <Text style={styles.actionTitle}>{title}</Text>
        <Text style={styles.actionBody}>{body}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
    </Pressable>
  );
}

function Shortcut({
  icon,
  label,
  hint,
  onPress,
  soon,
}: {
  icon: IoniconName;
  label: string;
  hint: string;
  onPress?: () => void;
  soon?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.shortcut,
        soon && styles.shortcutSoon,
        pressed && !soon && styles.pressed,
      ]}
      onPress={onPress}
      disabled={soon}
    >
      <Ionicons
        name={icon}
        size={22}
        color={soon ? colors.textTertiary : colors.accent}
      />
      <Text style={[styles.shortcutLabel, soon && styles.shortcutLabelSoon]}>{label}</Text>
      <Text style={styles.shortcutHint}>{soon ? "Coming soon" : hint}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    changedHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    seeAll: { color: colors.accent, fontSize: type.caption.fontSize, fontWeight: "700" },

    movedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    movedText: { flex: 1, gap: 2 },
    movedTitle: { color: colors.textPrimary, fontSize: type.body.fontSize, fontWeight: "700" },
    movedMeta: { color: colors.textSecondary, fontSize: type.caption.fontSize },
    movedDelta: { fontSize: type.body.fontSize, fontWeight: "800" },
    movedDown: { color: colors.success },
    movedUp: { color: colors.warning },

    quietCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: spacing.md,
    },
    quietTitle: { color: colors.textPrimary, fontSize: type.body.fontSize, fontWeight: "700" },
    quietBody: { color: colors.textSecondary, fontSize: type.caption.fontSize },

    content: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xxl },
    pressed: { opacity: 0.75 },

    brand: { gap: 1 },
    brandName: {
      color: colors.textPrimary,
      fontSize: type.display.fontSize,
      fontWeight: "900",
      letterSpacing: -0.5,
    },
    brandTagline: {
      color: colors.accent,
      fontSize: type.body.fontSize,
      fontWeight: "600",
    },

    searchHero: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.accentMuted,
      padding: spacing.md,
      gap: spacing.sm,
    },
    searchHeroTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    searchHeroTitle: {
      color: colors.textPrimary,
      fontSize: type.heading.fontSize,
      fontWeight: "800",
      flex: 1,
    },
    searchHeroBody: {
      color: colors.textSecondary,
      fontSize: type.label.fontSize,
      lineHeight: 19,
    },
    searchHeroFooter: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: spacing.xs,
    },
    storeDots: { flexDirection: "row", gap: 5 },
    storeDot: { width: 9, height: 9, borderRadius: radius.pill },
    searchHeroMeta: {
      color: colors.textTertiary,
      fontSize: type.caption.fontSize,
      fontWeight: "600",
    },

    watchCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: spacing.md,
    },
    watchLeft: { flex: 1, gap: 2 },
    watchLabel: {
      color: colors.textTertiary,
      fontSize: type.caption.fontSize,
      fontWeight: "800",
      letterSpacing: 0.5,
    },
    watchTitle: {
      color: colors.textPrimary,
      fontSize: type.body.fontSize,
      fontWeight: "600",
    },
    watchPriceRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: spacing.sm,
      marginTop: 1,
    },
    watchPrice: { color: colors.textPrimary, fontSize: 17, fontWeight: "800" },
    watchOff: {
      color: colors.success,
      fontSize: type.caption.fontSize,
      fontWeight: "800",
    },
    watchRetailer: { color: colors.textTertiary, fontSize: type.caption.fontSize },

    watchEmpty: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      borderStyle: "dashed",
      padding: spacing.md,
    },
    watchEmptyText: {
      color: colors.textSecondary,
      fontSize: type.label.fontSize,
      flex: 1,
    },

    section: { gap: spacing.xs },

    actionCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    actionText: { flex: 1, gap: 1 },
    actionTitle: {
      color: colors.textPrimary,
      fontSize: type.body.fontSize,
      fontWeight: "700",
    },
    actionBody: { color: colors.textSecondary, fontSize: type.caption.fontSize },

    storeHelp: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      alignSelf: "center",
      paddingVertical: 8,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      backgroundColor: colors.surface,
    },
    // When something is down the same control carries the warning, so there
    // is one place that answers "is a store missing?" instead of two.
    storeHelpDown: { borderColor: colors.warning, backgroundColor: colors.surfaceRaised },
    storeHelpText: {
      color: colors.textSecondary,
      fontSize: type.label.fontSize,
      fontWeight: "600",
    },
    storeHelpTextDown: { color: colors.textPrimary, fontWeight: "700" },
    whyLimited: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      marginTop: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
    },
    whyLimitedText: {
      flex: 1,
      color: colors.textSecondary,
      fontSize: type.label.fontSize,
      fontWeight: "600",
    },
    shortcutGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    shortcut: {
      // Two per row, accounting for the gap between them.
      width: "48%",
      flexGrow: 1,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: spacing.md,
      gap: 2,
    },
    shortcutSoon: { opacity: 0.55 },
    shortcutLabel: {
      color: colors.textPrimary,
      fontSize: type.body.fontSize,
      fontWeight: "700",
      marginTop: spacing.xs,
    },
    shortcutLabelSoon: { color: colors.textSecondary },
    shortcutHint: { color: colors.textTertiary, fontSize: type.caption.fontSize },

    planCard: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: spacing.md,
    },
    planLeft: { gap: 2 },
    planLabel: {
      color: colors.textTertiary,
      fontSize: type.caption.fontSize,
      fontWeight: "800",
      letterSpacing: 0.6,
    },
    planUnknown: { color: colors.textTertiary },
    planTier: {
      color: colors.textPrimary,
      fontSize: type.heading.fontSize,
      fontWeight: "800",
    },
    upgradePill: {
      backgroundColor: colors.accentMuted,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    upgradeText: {
      color: colors.accent,
      fontSize: type.caption.fontSize,
      fontWeight: "800",
    },
  });
