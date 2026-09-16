// components/Sparkline.tsx
//
// Thirty days of price in the width of a card row.
//
// The tracking list used to show today's price and nothing else, which answers
// "what does it cost" and never "is that good" — the question tracking exists
// for. A user had to open a product to find out whether the number in front of
// them was high or low for that item.
//
// Same geometry as PriceChart, deliberately: one tested implementation of
// "where does this line go", drawn with rotated Views because the project
// ships a prebuilt android/ and a charting library would mean a native module.
//
// No axes, no labels, no dates. At this size they would be unreadable, and the
// sentence next to it says the part that needs words.

import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { type Palette } from "@/constants/theme";
import { useTheme, useThemedStyles } from "@/lib/theme";
import { type ChartPoint, buildLine, downsample } from "@/lib/chartGeometry";

interface Props {
  points: ChartPoint[];
  height?: number;
  /** Coloured by what the line means, decided by the caller. */
  tone?: "good" | "bad" | "flat";
}

const STROKE = 1.5;
const DOT = 5;
/** More than this in a strip this wide is ink, not information. */
const MAX_POINTS = 24;

export default function Sparkline({ points, height = 34, tone = "flat" }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);

  const thinned = useMemo(() => downsample(points, MAX_POINTS), [points]);
  const layout = useMemo(
    () => buildLine(thinned, width, height, STROKE),
    [thinned, width, height],
  );

  const color =
    tone === "good" ? colors.success : tone === "bad" ? colors.warning : colors.textTertiary;

  return (
    <View
      style={[styles.plot, { height }]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      // Decorative: the line repeats what the text beside it already says, and
      // a screen reader announcing a shape it can't describe is noise.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {layout && (
        <>
          {layout.segments.map((segment, index) => (
            <View
              key={index}
              style={[
                styles.segment,
                {
                  backgroundColor: color,
                  left: segment.left,
                  top: segment.top,
                  width: segment.width,
                  transform: [{ rotate: `${segment.angle}deg` }],
                },
              ]}
            />
          ))}
          {/* Only today's reading. The low is named in the sentence next to the
              line, and a second dot this size reads as a smudge. */}
          {layout.dots
            .filter((dot) => dot.kind === "now")
            .map((dot) => (
              <View
                key={dot.kind}
                style={[
                  styles.dot,
                  { backgroundColor: color, left: dot.x - DOT / 2, top: dot.y - DOT / 2 },
                ]}
              />
            ))}
        </>
      )}
    </View>
  );
}

const makeStyles = (_colors: Palette) =>
  StyleSheet.create({
    plot: { width: "100%", position: "relative" },
    segment: { position: "absolute", height: STROKE, borderRadius: STROKE },
    dot: { position: "absolute", width: DOT, height: DOT, borderRadius: DOT / 2 },
  });
