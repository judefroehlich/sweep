// src/test-trend.ts — the price line on a tracked card.
//   npm run test:trend
//
// The tracking list is the screen people live on, and until this it showed
// today's price with no way to tell whether that was high or low for the item.
// What has to be right: the thinning keeps the shape and both ends, the range
// is the real range, and a single reading never draws as a trend.
import "./testEnv.js";
import { prisma } from "./lib/prisma.js";
import { recentTrends } from "./routes/products.js";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok && detail !== undefined) console.log("     ", JSON.stringify(detail));
};

const day = 24 * 60 * 60 * 1000;
const ids: string[] = [];

async function seed(prices: number[], spacingMs = day): Promise<string> {
  const product = await prisma.product.create({
    data: {
      retailer: "bestbuy",
      retailerId: `trend-${Date.now()}-${ids.length}`,
      url: "https://example.com/p",
      title: "Trend fixture",
      currentPrice: prices[prices.length - 1],
    },
  });
  ids.push(product.id);
  await prisma.priceHistory.createMany({
    data: prices.map((price, i) => ({
      productId: product.id,
      price,
      checkedAt: new Date(Date.now() - (prices.length - 1 - i) * spacingMs),
    })),
  });
  return product.id;
}

try {
  const falling = await seed([20000, 19000, 18000, 15000]);
  const single = await seed([9900]);
  // Forty readings an hour apart: more than a card-width line can show.
  const busy = await seed(Array.from({ length: 40 }, (_, i) => 10000 + i * 10), 60 * 60 * 1000);

  const trends = await recentTrends([falling, single, busy], "free");

  console.log("\n— what comes back —");
  const f = trends.get(falling)!;
  check("a tracked product gets a trend", Boolean(f));
  check("with every reading, in order", f.points.length === 4 && f.points[0].price === 20000, f.points.length);
  check("the low is the lowest reading", f.low === 15000, f.low);
  check("the high is the highest", f.high === 20000, f.high);
  check("the window is how long it's been watched", f.days >= 3 && f.days <= 4, f.days);
  check("points carry an ISO timestamp", typeof f.points[0].checkedAt === "string" && f.points[0].checkedAt.endsWith("Z"));

  console.log("\n— one reading is not a trend —");
  check("no line is drawn from a single point", trends.get(single) === undefined);

  console.log("\n— thinning —");
  const b = trends.get(busy)!;
  check("40 readings are thinned to 24", b.points.length === 24, b.points.length);
  check("the first reading is kept", b.points[0].price === 10000, b.points[0].price);
  check("the last reading is kept", b.points[23].price === 10390, b.points[23].price);
  check("the range is from all 40, not the 24", b.low === 10000 && b.high === 10390, { low: b.low, high: b.high });
  check(
    "they stay in time order",
    b.points.every((p, i) => i === 0 || p.checkedAt >= b.points[i - 1].checkedAt),
  );

  console.log("\n— the tier's history window —");
  // Free keeps 30 days, so a reading from 60 days ago is outside it. Without
  // this the card would quote a "low" the detail screen refuses to show.
  const old = await prisma.product.create({
    data: {
      retailer: "bestbuy",
      retailerId: `trend-old-${Date.now()}`,
      url: "https://example.com/o",
      title: "Old",
      currentPrice: 5000,
    },
  });
  ids.push(old.id);
  await prisma.priceHistory.createMany({
    data: [
      { productId: old.id, price: 99999, checkedAt: new Date(Date.now() - 60 * day) },
      { productId: old.id, price: 5000, checkedAt: new Date(Date.now() - 2 * day) },
      { productId: old.id, price: 5000, checkedAt: new Date(Date.now() - 1 * day) },
    ],
  });
  const o = (await recentTrends([old.id], "free")).get(old.id)!;
  check("readings older than the tier's history are left out", o.high === 5000, o.high);
  check("and what's left still draws", o.points.length === 2, o.points.length);

  console.log("\n— nothing to draw —");
  check("no products means no query", (await recentTrends([], "free")).size === 0);
} finally {
  await prisma.priceHistory.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
