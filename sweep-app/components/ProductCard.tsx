// components/ProductCard.tsx
//
// One product row, used by the tracking list and compiled search results. Same
// component in both places so a price can't render one way on one screen and
// differently on another.
//
// ---- on the layout ----
//
// Actions live in a toolbar under the content, not in a column beside it. They
// started as one button and grew to five (compare, list, sweep, bought, plus a
// per-screen primary), and a stack of five in a right-hand column squeezed the
// title and price — the parts people actually read — into whatever width was
// left. A full-width strip gives each control room and keeps the product
// itself the widest thing on the card.
//
// Actions are declared as data rather than passed as elements so every screen
// renders them identically. Handing in a <Button> was how the card ended up
// with two different visual languages for "things you can do here".
//
// ---- the grid variant ----
//
// `variant="grid"` is this same card stacked vertically for a two-up search
// grid: image on top, then store, title, price, verdict. A variant rather than
// a second component, because the note above about a price rendering two
// different ways on two screens applies more when the layouts differ, not less.
//
// A half-width card has no room for a five-button toolbar, which is the exact
// squeeze the toolbar was built to fix. So the accent action becomes a circle
// on the image and the rest move behind an overflow button. What stays visible
// is what people read: picture, title, price, and whether the discount is real.

import { type Palette, radius, spacing, type } from "@/constants/theme";
import { useTheme, useThemedStyles } from "@/lib/theme";
import { useTranslate } from "@/lib/i18n";
import {
  formatPrice,
  formatRating,
  formatRelativeTime,
  formatSellerRating,
  percentOff,
  retailerColor,
  retailerLabel,
} from "@/lib/format";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import Sparkline from "./Sparkline";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

export interface CardAction {
  key: string;
  icon: IoniconName;
  label: string;
  onPress: () => void;
  /** Tints the control — for the one action that's special on this screen. */
  tone?: "accent";
  /** Toggled-on state, e.g. Compare becoming Added. */
  active?: boolean;
  activeIcon?: IoniconName;
  activeLabel?: string;
  busy?: boolean;
}

interface Props {
  title: string;
  retailer: string;
  price: number | null;
  listPrice: number | null;
  imageUrl: string | null;
  rating?: number | null;
  ratingCount?: number | null;
  /** eBay only — seller feedback percentage, shown when no product rating exists. */
  sellerRating?: number | null;
  sellerRatingCount?: number | null;
  lastCheckedAt?: string | null;
  /** Rendered under the price — e.g. "Down $30 since you started". */
  note?: string | null;
  /** Colours the note. Movement isn't always good news. */
  noteTone?: "good" | "bad" | "neutral";
  onPress?: () => void;
  /** Toolbar under the card. Undefined entries are dropped, so a screen can
   *  write `sweepAvailable ? sweepAction : null` inline. */
  actions?: (CardAction | null | undefined | false)[];
  /**
   * "row" is the full-width card that tracking uses. "grid" is the half-width
   * one for a two-up search grid.
   */
  variant?: "row" | "grid";
  /** Hands the non-primary actions to a sheet the screen owns. */
  onShowActions?: (actions: CardAction[]) => void;
  /**
   * Recent history, drawn as a line under the price with a sentence saying
   * where today sits in it.
   *
   * The whole point of the row card: a price with no context can't answer the
   * question someone tracking an item actually has.
   */
  trend?: {
    points: { price: number; checkedAt: string }[];
    low: number;
    high: number;
    days: number;
  } | null;
}

export default function ProductCard({
  title,
  retailer,
  price,
  listPrice,
  imageUrl,
  rating,
  ratingCount,
  sellerRating,
  sellerRatingCount,
  lastCheckedAt,
  note,
  noteTone = "good",
  onPress,
  actions,
  variant = "row",
  onShowActions,
  trend,
}: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const t = useTranslate();
  // A failed image should fall back to the placeholder, not leave a blank white
  // square that's indistinguishable from a product photo on a white background.
  const [imageFailed, setImageFailed] = useState(false);

  const discount = percentOff(price, listPrice);
  // Prefer a real product rating; fall back to seller feedback where that's
  // all the retailer publishes.
  const ratingText = formatRating(rating ?? null, ratingCount ?? null);
  const sellerText = ratingText
    ? null
    : formatSellerRating(sellerRating ?? null, sellerRatingCount ?? null);

  const visible = (actions ?? []).filter((a): a is CardAction => Boolean(a));

  // Two buttons stay on the card: whichever the screen marked accent, plus the
  // next one. Screens pass their actions in importance order, so this needs no
  // second list to keep in step.
  const primary = visible.filter((a) => a.tone === "accent");
  const rest = visible.filter((a) => a.tone !== "accent");
  const toolbarActions = onShowActions ? [...primary, ...rest].slice(0, 2) : visible;
  const overflow = onShowActions
    ? [...primary, ...rest].slice(2)
    : [];

  if (variant === "grid") {
    return (
      <View style={[styles.card, styles.gridCard]}>
        <Pressable
          style={({ pressed }) => pressed && onPress && styles.pressed}
          onPress={onPress}
          disabled={!onPress}
        >
          <View style={styles.gridThumbWrap}>
            {imageUrl && !imageFailed ? (
              <Image
                source={{ uri: imageUrl }}
                style={styles.thumb}
                resizeMode="contain"
                onError={() => setImageFailed(true)}
              />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]}>
                <Ionicons name="image-outline" size={22} color={colors.textTertiary} />
              </View>
            )}
          </View>

          <View style={styles.gridBody}>
            <View style={styles.badgeRow}>
              <View
                style={[
                  styles.retailerDot,
                  { backgroundColor: retailerColor(colors, retailer) },
                ]}
              />
              <Text style={styles.retailer} numberOfLines={1}>
                {retailerLabel(retailer)}
              </Text>
            </View>

            <Text style={styles.gridTitle} numberOfLines={2}>
              {title}
            </Text>

            {/* The discount stays on the card, never behind the overflow. It
                is the one line here a competitor does not have, and the first
                version of this grid dropped it — which defeated the point. */}
            <View style={styles.gridPriceRow}>
              <Text style={[styles.price, price === null && styles.priceMissing]}>
                {price === null ? t("card.noPrice") : formatPrice(price)}
              </Text>
              {listPrice !== null && discount !== null && (
                <Text style={styles.gridListPrice}>{formatPrice(listPrice)}</Text>
              )}
            </View>
            {listPrice !== null && discount !== null && (
              <View style={styles.gridDiscountPill}>
                <Text style={styles.discountText}>{discount}% off list</Text>
              </View>
            )}

            {note && (
              <Text
                style={[
                  styles.gridNote,
                  noteTone === "bad" && styles.noteBad,
                  noteTone === "neutral" && styles.noteNeutral,
                ]}
                numberOfLines={2}
              >
                {note}
              </Text>
            )}
          </View>
        </Pressable>

        {/* Every action, including the accent one. Tapping the card itself is
            the primary action now, so the photo carries one control instead of
            two competing circles sitting on the product. */}
        {visible.length > 0 && onShowActions && (
          <Pressable
            onPress={() => onShowActions(visible)}
            hitSlop={8}
            style={({ pressed }) => [styles.gridMore, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={t("card.moreActions")}
          >
            <Ionicons name="ellipsis-horizontal" size={16} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Pressable
        style={({ pressed }) => [styles.main, pressed && onPress && styles.pressed]}
        onPress={onPress}
        disabled={!onPress}
      >
        <View style={styles.thumbWrap}>
          {imageUrl && !imageFailed ? (
            <Image
              source={{ uri: imageUrl }}
              style={styles.thumb}
              resizeMode="contain"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <View style={[styles.thumb, styles.thumbEmpty]}>
              <Ionicons name="image-outline" size={20} color={colors.textTertiary} />
            </View>
          )}
        </View>

        <View style={styles.body}>
          <View style={styles.badgeRow}>
            <View
              style={[
                styles.retailerDot,
                { backgroundColor: retailerColor(colors, retailer) },
              ]}
            />
            <Text style={styles.retailer}>{retailerLabel(retailer)}</Text>
            {ratingText && <Text style={styles.rating}>{ratingText}</Text>}
            {sellerText && <Text style={styles.sellerRating}>{sellerText}</Text>}
          </View>

          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>

          <View style={styles.priceRow}>
            <Text style={[styles.price, price === null && styles.priceMissing]}>
              {price === null ? t("card.noPrice") : formatPrice(price)}
            </Text>
            {listPrice !== null && discount !== null && (
              <>
                <Text style={styles.listPrice}>{formatPrice(listPrice)}</Text>
                <View style={styles.discountPill}>
                  <Text style={styles.discountText}>{discount}% off list</Text>
                </View>
              </>
            )}
          </View>

          {note && (
            <Text
              style={[
                styles.note,
                noteTone === "bad" && styles.noteBad,
                noteTone === "neutral" && styles.noteNeutral,
              ]}
            >
              {note}
            </Text>
          )}
          {/* Needs today's price to say where today sits. A card with no price
              shows the line alone rather than a sentence about nothing. */}
          {trend && trend.points.length > 1 && price !== null && (
            <View style={styles.trend}>
              <Sparkline points={trend.points} tone={trendTone(trend)} />
              <Text
                style={[styles.trendNote, atLow(price, trend) && styles.trendNoteLow]}
                numberOfLines={1}
              >
                {atLow(price, trend)
                  ? t("card.lowestIn", { days: trend.days })
                  : t("card.aboveLow", {
                      amount: formatPrice((price ?? 0) - trend.low),
                      days: trend.days,
                    })}
              </Text>
            </View>
          )}
          {lastCheckedAt !== undefined && lastCheckedAt !== null && (
            <Text style={styles.checked}>
              {t("card.checkedAgo", { when: formatRelativeTime(lastCheckedAt) })}
            </Text>
          )}
        </View>

        {onPress && (
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        )}
      </Pressable>

      {visible.length > 0 && (
        <View style={styles.toolbar}>
          {toolbarActions.map((item) => {
            const on = Boolean(item.active);
            return (
              <Pressable
                key={item.key}
                onPress={item.onPress}
                disabled={item.busy}
                style={({ pressed }) => [
                  styles.tool,
                  pressed && styles.toolPressed,
                  item.busy && styles.toolBusy,
                ]}
              >
                <Ionicons
                  name={on ? (item.activeIcon ?? item.icon) : item.icon}
                  size={17}
                  color={
                    on || item.tone === "accent" ? colors.accent : colors.textSecondary
                  }
                />
                <Text
                  style={[
                    styles.toolLabel,
                    (on || item.tone === "accent") && styles.toolLabelAccent,
                  ]}
                  numberOfLines={1}
                >
                  {on ? (item.activeLabel ?? item.label) : item.label}
                </Text>
              </Pressable>
            );
          })}

          {/* One row of five identical buttons made every action look equally
              likely, which is how a list of features looks rather than a tool.
              The rest live one tap away, in the sheet the screen owns. */}
          {overflow.length > 0 && onShowActions && (
            <Pressable
              onPress={() => onShowActions(overflow)}
              style={({ pressed }) => [styles.tool, pressed && styles.toolPressed]}
              accessibilityRole="button"
              accessibilityLabel={t("card.moreActions")}
            >
              <Ionicons name="ellipsis-horizontal" size={17} color={colors.textSecondary} />
              <Text style={styles.toolLabel} numberOfLines={1}>
                {t("card.more")}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

/** Is today's price the lowest reading in the window? */
function atLow(price: number | null, trend: { low: number }): boolean {
  return price !== null && price <= trend.low;
}

/**
 * What the line means, which is not the same as where it ends. A price that
 * fell and came back is not good news, so this compares the ends.
 */
function trendTone(trend: { points: { price: number }[] }): "good" | "bad" | "flat" {
  const first = trend.points[0]?.price;
  const last = trend.points[trend.points.length - 1]?.price;
  if (first === undefined || last === undefined || first === last) return "flat";
  return last < first ? "good" : "bad";
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      overflow: "hidden",
    },
    main: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      padding: spacing.md,
    },
    pressed: { opacity: 0.7 },
    thumbWrap: {
      width: 64,
      height: 64,
      borderRadius: radius.sm,
      backgroundColor: "#FFFFFF",
      overflow: "hidden",
    },
    thumb: { width: "100%", height: "100%" },

    // ---- grid variant ----
    gridCard: { position: "relative", flex: 1 },
    gridThumbWrap: {
      width: "100%",
      aspectRatio: 1,
      backgroundColor: "#FFFFFF",
      overflow: "hidden",
    },
    gridBody: { gap: 3, padding: spacing.sm },
    gridTitle: {
      color: colors.textPrimary,
      fontSize: type.label.fontSize,
      fontWeight: "700",
      lineHeight: 18,
    },
    gridNote: { color: colors.success, fontSize: type.caption.fontSize, fontWeight: "700" },
    gridPriceRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.xs },
    gridListPrice: {
      color: colors.textTertiary,
      fontSize: type.caption.fontSize,
      textDecorationLine: "line-through",
    },
    gridDiscountPill: {
      alignSelf: "flex-start",
      backgroundColor: colors.successMuted,
      borderRadius: radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 2,
      marginTop: 2,
    },
    // Solid rather than translucent: product photos are usually white, but not
    // always, and a control that vanishes on a dark one is worse than a
    // slightly heavy one that never does.
    gridMore: {
      position: "absolute",
      top: spacing.xs,
      right: spacing.xs,
      width: 30,
      height: 30,
      borderRadius: radius.pill,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      alignItems: "center",
      justifyContent: "center",
    },
    thumbEmpty: {
      backgroundColor: colors.surfaceRaised,
      alignItems: "center",
      justifyContent: "center",
    },
    body: { flex: 1, gap: 3 },
    badgeRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
    retailerDot: { width: 7, height: 7, borderRadius: radius.pill },
    retailer: {
      color: colors.textSecondary,
      fontSize: type.caption.fontSize,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    rating: { color: colors.textTertiary, fontSize: type.caption.fontSize },
    // Visually distinct from a star rating, because it isn't one.
    sellerRating: {
      color: colors.textTertiary,
      fontSize: type.caption.fontSize,
      fontStyle: "italic",
    },
    title: {
      color: colors.textPrimary,
      fontSize: type.body.fontSize,
      fontWeight: "600",
      lineHeight: 19,
    },
    priceRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: spacing.xs,
      marginTop: 2,
      flexWrap: "wrap",
    },
    price: { color: colors.textPrimary, fontSize: 17, fontWeight: "800" },
    priceMissing: { color: colors.textTertiary, fontSize: type.body.fontSize },
    listPrice: {
      color: colors.textTertiary,
      fontSize: type.label.fontSize,
      textDecorationLine: "line-through",
    },
    discountPill: {
      backgroundColor: colors.accentMuted,
      borderRadius: radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    discountText: {
      color: colors.accent,
      fontSize: type.caption.fontSize,
      fontWeight: "800",
    },
    note: {
      color: colors.success,
      fontSize: type.caption.fontSize,
      fontWeight: "700",
    },
    noteBad: { color: colors.warning },
    // Grey, not accent. "Nothing has happened" was painted in the same colour
    // as a price drop, which made the brand colour mean nothing on a screen
    // where it should mean "look here".
    noteNeutral: { color: colors.textSecondary, fontWeight: "600" },
    checked: { color: colors.textTertiary, fontSize: type.caption.fontSize },
    trend: { marginTop: spacing.xs, gap: 2 },
    trendNote: { color: colors.textSecondary, fontSize: type.caption.fontSize },
    trendNoteLow: { color: colors.success, fontWeight: "700" },

    toolbar: {
      flexDirection: "row",
      borderTopWidth: 1,
      borderTopColor: colors.surfaceBorder,
      backgroundColor: colors.background,
    },
    // Icon over label: at four across on a narrow phone, side-by-side runs out
    // of width and truncates the labels that make the icons legible.
    tool: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
      paddingVertical: 9,
      paddingHorizontal: 2,
    },
    toolPressed: { backgroundColor: colors.surfaceRaised },
    toolBusy: { opacity: 0.4 },
    toolLabel: {
      color: colors.textSecondary,
      fontSize: type.caption.fontSize,
      fontWeight: "700",
    },
    toolLabelAccent: { color: colors.accent },
  });
