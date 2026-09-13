// routes/admin.ts
//
// A one-page admin portal at /admin.
//
// Exists because the alternative was curl commands with a header, which is
// fine at a desk and useless on a phone during a school lunch break. The
// things it answers — how many people are using this, what is it costing, is
// anything broken, and can I tell everyone something — were all invisible
// without a database client.
//
// AUTH: the same ADMIN_API_KEY as the announce endpoint, held in the browser's
// localStorage and sent as a header on each request. No cookies, no sessions,
// no new dependencies, and nothing to expire or invalidate.
//
// A session lasts until sign-out; there is nothing to renew. Rotation is the
// escape hatch rather than a routine: changing one Railway variable
// invalidates every browser holding the old key.
//
// That is a deliberate trade rather than an oversight. It is proportionate for
// a single-admin tool behind HTTPS, and would not be if more than one person
// ever used this.
//
// The page itself is served unauthenticated — it contains no data, only the
// form that asks for the key. Everything real is behind /admin/stats.

import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../lib/adminAuth.js";
import { getAdminStats } from "../lib/adminStats.js";
import { createPromoCode, deletePromoCode, listPromoCodes } from "../lib/promoAdmin.js";
import { probe, probeAdapter, probeDirect, recentStress, stress } from "../lib/probe.js";
import { getVisitSummary } from "../lib/siteVisits.js";

export async function adminRoutes(app: FastifyInstance) {
  app.get("/admin", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(PAGE);
  });

  app.get("/admin/stats", { preHandler: requireAdmin }, async () => {
    return getAdminStats();
  });

  // Visits to the public site. Counts, not people — see lib/siteVisits.ts for
  // what is deliberately not stored and why.
  app.get("/admin/visits", { preHandler: requireAdmin }, async () => {
    return getVisitSummary();
  });

  // Fetch a url from wherever this server is, and report what came back.
  //
  // The whole point is the vantage point: a page that loads perfectly from a
  // laptop can be refused outright from a datacenter, and that difference has
  // been the answer three times now while being impossible to check.
  app.post("/admin/probe", { preHandler: requireAdmin }, async (request, reply) => {
    const { url } = (request.body ?? {}) as { url?: string };
    if (typeof url !== "string" || !url.trim()) {
      return reply.status(400).send({ error: "Give it a url." });
    }

    const result = await probe(url.trim());
    request.log.info(
      { url: result.finalUrl, status: result.status, refused: result.refused },
      "admin probe",
    );
    return result;
  });

  // Runs a real adapter from here, which is a different question from whether
  // the page loads: a store can serve a 200 with all the right markers and a
  // payload the parser finds nothing in.
  app.post("/admin/probe/adapter", { preHandler: requireAdmin }, async (request, reply) => {
    const { retailer, keyword } = (request.body ?? {}) as {
      retailer?: string;
      keyword?: string;
    };
    if (typeof retailer !== "string" || !retailer.trim()) {
      return reply.status(400).send({ error: "Which retailer?" });
    }

    const result = await probeAdapter(retailer.trim(), (keyword || "wireless headphones").trim());
    request.log.info(
      { retailer: result.retailer, status: result.status, count: result.count },
      "admin adapter probe",
    );
    return result;
  });

  // Runs the adapter repeatedly and reports the spread. One run says almost
  // nothing about a store that fails intermittently.
  // Can we fetch the retailer straight from our own address, skipping the paid
  // middleman? Measured rather than assumed, because the answer is allowed to
  // change and because a measurement settles an argument that opinions do not.
  app.post("/admin/probe/direct", { preHandler: requireAdmin }, async (request, reply) => {
    const { retailer } = (request.body ?? {}) as { retailer?: string };
    if (typeof retailer !== "string" || !retailer.trim()) {
      return reply.status(400).send({ error: "retailer is required" });
    }
    const result = await probeDirect(retailer.trim());
    request.log.info(
      { retailer: result.retailer, verdict: result.verdict },
      "admin direct probe",
    );
    return result;
  });

  app.post("/admin/probe/stress", { preHandler: requireAdmin }, async (request, reply) => {
    const { retailer, runs, spendMoney } = (request.body ?? {}) as {
      retailer?: string;
      runs?: number;
      spendMoney?: boolean;
    };
    if (typeof retailer !== "string" || !retailer.trim()) {
      return reply.status(400).send({ error: "Which retailer?" });
    }

    const result = await stress(retailer.trim(), Number(runs) || 8, spendMoney === true);
    request.log.info(
      { retailer: result.retailer, runs: result.runs, successRate: result.successRate },
      "admin stress test",
    );
    return result;
  });

  // The last few stress runs. Cleared by a redeploy, which is fine — this
  // exists so a result outlives the tab that asked for it, not forever.
  app.get("/admin/probe/stress", { preHandler: requireAdmin }, async () => {
    return { recent: recentStress() };
  });

  app.get("/admin/promo", { preHandler: requireAdmin }, async () => {
    return { codes: await listPromoCodes() };
  });

  app.delete("/admin/promo/:code", { preHandler: requireAdmin }, async (request, reply) => {
    const { code } = request.params as { code: string };
    try {
      const result = await deletePromoCode(code);
      request.log.warn(
        { code: result.code, redemptionsRemoved: result.redemptionsRemoved },
        "promo code deleted",
      );
      return { ok: true, ...result };
    } catch (err) {
      return reply
        .status(404)
        .send({ error: err instanceof Error ? err.message : "Could not delete code" });
    }
  });

  app.post("/admin/promo", { preHandler: requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const created = await createPromoCode({
        code: typeof body.code === "string" ? body.code : undefined,
        tier: String(body.tier ?? "pro"),
        days: Number(body.days ?? 14),
        maxRedemptions:
          body.maxRedemptions === null || body.maxRedemptions === undefined || body.maxRedemptions === ""
            ? null
            : Number(body.maxRedemptions),
        expiresInDays:
          body.expiresInDays === null || body.expiresInDays === undefined || body.expiresInDays === ""
            ? null
            : Number(body.expiresInDays),
      });
      request.log.info(
        { code: created.code, tier: created.grantsTier, days: created.grantsDurationDays },
        "promo code created",
      );
      return { ok: true, code: created.code };
    } catch (err) {
      // Validation messages here are written for the admin reading them, and
      // the only reader is authenticated, so passing them through is safe.
      return reply
        .status(400)
        .send({ error: err instanceof Error ? err.message : "Could not create code" });
    }
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sweep admin</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --dim: #8888; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 20px 16px 64px; max-width: 760px;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em;
       color: var(--dim); margin: 28px 0 10px; }
  .sub { color: var(--dim); font-size: 13px; margin: 0 0 20px; }
  input, button, textarea, select {
    font: inherit; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--line); background: transparent; color: inherit;
    width: 100%; margin-bottom: 8px;
  }
  /* Two fields side by side, stacking on a phone — which is where this page
     actually gets used. */
  .row { display: flex; gap: 8px; }
  .row > * { flex: 1; min-width: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .dim { color: var(--dim); }
  button { background: #4f46e5; color: #fff; border: 0; font-weight: 700; cursor: pointer; }
  button.secondary { background: transparent; border: 1px solid var(--line); color: inherit; font-weight: 600; }
  /* An inline action inside a table row, not a page-level button. */
  button.link { background: none; border: 0; color: #dc2626; font-weight: 600;
                width: auto; margin: 0; padding: 2px 0; font-size: 13px; }
  .probe { border: 1px solid var(--line); border-radius: 10px; padding: 12px 13px;
           margin-top: 8px; font-size: 13px; }
  .probe .big { font-size: 15px; font-weight: 800; margin-bottom: 6px; }
  .probe dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; }
  .probe dt { color: var(--dim); }
  .probe dd { margin: 0; word-break: break-all; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .n { font-size: 22px; font-weight: 800; }
  .k { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td, th { text-align: left; padding: 7px 4px; border-bottom: 1px solid var(--line); }
  th { color: var(--dim); font-size: 12px; font-weight: 600; text-transform: uppercase; }
  .ok { color: #16a34a; } .bad { color: #dc2626; } .warn { color: #d97706; }
  .msg { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); margin-bottom: 12px; font-size: 14px; }
  .hide { display: none; }

  /* Provider credit bars. Colour is the whole message — you should be able to
     tell whether you are fine from across the room. */
  .prov { border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; margin-bottom: 8px; }
  .provTop { display: flex; align-items: baseline; gap: 8px; font-size: 14px; }
  .provTop b { font-weight: 800; }
  .provTop .who { color: var(--dim); font-size: 12px; }
  .provTop .num { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 700; }
  .bar { height: 7px; border-radius: 4px; background: #8882; margin-top: 8px; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 4px; background: #16a34a; }
  .bar i.warn { background: #d97706; }
  .bar i.bad { background: #dc2626; }

  /* Seven bars. Enough to see a direction, which is all a week can tell you. */
  /* Two lists side by side on a desktop, stacked on a phone. */
  .two { display: grid; gap: 18px; margin-top: 18px; }
  @media (min-width: 620px) { .two { grid-template-columns: 1fr 1fr; } }
  .two h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em;
            color: #9aa0aa; margin: 0 0 8px; }
  /* dt/dd as a two-column row: name on the left, count right-aligned. */
  dl { display: grid; grid-template-columns: 1fr auto; gap: 6px 14px; margin: 0; }
  dt { color: #d5d8dd; font-size: 14px; overflow: hidden; text-overflow: ellipsis;
       white-space: nowrap; }
  dd { margin: 0; color: #9aa0aa; font-size: 14px; text-align: right;
       font-variant-numeric: tabular-nums; }
  .muted { color: #7b818b; font-size: 13px; line-height: 1.5; margin-top: 14px; }
  .spark { display: flex; align-items: flex-end; gap: 6px; height: 96px; }
  .spark div { flex: 1; display: flex; flex-direction: column; justify-content: flex-end;
               align-items: center; gap: 4px; height: 100%; }
  .spark span.col { display: block; width: 100%; background: #4f46e5; border-radius: 4px 4px 0 0; min-height: 2px; }
  .spark span.lab { font-size: 10px; color: var(--dim); }
  .spark span.val { font-size: 11px; font-weight: 800; }
</style>
</head>
<body>

<h1>Sweep admin</h1>
<p class="sub" id="stamp">Not signed in.</p>

<div id="msg" class="hide"></div>

<div id="login">
  <input id="key" type="password" placeholder="Admin key" autocomplete="off"
         onkeydown="if (event.key === 'Enter') signIn()">
  <button onclick="signIn()">Sign in</button>
  <p class="sub">Signs you in until you sign out — the key is kept in this browser only. If it ever leaks, changing ADMIN_API_KEY on Railway logs every browser out at once.</p>
</div>

<div id="app" class="hide">

  <h2>Provider credits</h2>
  <p class="sub">What the metered stores are spending. Running out takes the
  store down, so this is a deadline rather than a gauge.</p>
  <div id="providers"></div>

  <h2>Last 7 days</h2>
  <div class="spark" id="trend"></div>

  <h2>Website visits</h2>
  <div class="grid" id="visits"></div>
  <div class="spark" id="visitTrend"></div>
  <div class="two">
    <div><h3>Pages</h3><dl id="visitPages"></dl></div>
    <div><h3>Came from</h3><dl id="visitRefs"></dl></div>
  </div>
  <p class="muted">
    Visits, not visitors. No IP, cookie or session is stored, so one person
    opening the site ten times counts ten times. Obvious crawlers are excluded.
  </p>

  <h2>People</h2>
  <div class="grid" id="people"></div>

  <h2>Today</h2>
  <div class="grid" id="today"></div>

  <h2>Stores</h2>
  <table><thead><tr><th>Store</th><th>State</th><th>Success</th><th>Checks</th></tr></thead>
  <tbody id="stores"></tbody></table>

  <h2>Heaviest use today</h2>
  <p class="sub">Everyone is capped, so nobody here took more than they were given.
  This answers who is driving the Amazon bill.</p>
  <table><thead><tr><th>Account</th><th>Tier</th><th>Searches</th><th>Lookups</th></tr></thead>
  <tbody id="heaviest"></tbody></table>

  <h2>Reach a page from here</h2>
  <p class="sub">Fetches from this server, not your laptop. A store that answers
  a home connection and refuses a datacenter looks identical from a browser —
  this is the only way to tell them apart.</p>
  <input id="probeUrl" placeholder="https://www.zappos.com/..." autocomplete="off">
  <button onclick="runProbe()">Probe</button>
  <div id="probeOut"></div>

  <h2>Run a retailer from here</h2>
  <p class="sub">The other probe proves a page loads. This runs the actual
  adapter through the actual rate gate, which is the only thing that answers
  whether it will work in the app. Works on stores that are switched off &mdash;
  that is the point.</p>
  <div class="row">
    <select id="adRetailer">
      <option>amazon</option><option>walmart</option><option>bestbuy</option>
      <option>ebay</option><option>newegg</option><option>asos</option>
      <option>etsy</option>
    </select>
    <input id="adKeyword" value="wireless headphones" placeholder="Search term">
  </div>
  <button onclick="runAdapter()">Run it</button>
  <div id="adOut"></div>

  <h2>Stress a retailer</h2>
  <p class="sub">Runs the adapter over and over from this server, with a
  different search term each time so nothing is served from cache. This is how
  you tell a store that is genuinely flaky from one that had a bad minute.</p>
  <div class="row">
    <select id="stRetailer">
      <option>bestbuy</option><option>ebay</option><option>etsy</option>
      <option>newegg</option><option>asos</option>
      <option>amazon</option><option>walmart</option>
    </select>
    <input id="stRuns" type="number" min="1" max="30" value="12">
  </div>
  <button onclick="runStress()">Run it</button>
  <div id="stOut"></div>
  <div id="stRecent"></div>

  <h2>Promo codes</h2>
  <p class="sub">Grants time on a paid tier. It never touches a real subscription —
  someone who already pays keeps what they pay for, and the grant is what they
  fall back on if that ever ends.</p>
  <div class="row">
    <select id="pTier">
      <option value="pro">Pro</option>
      <option value="ultimate">Ultimate</option>
    </select>
    <input id="pDays" type="number" min="1" max="365" value="14" placeholder="Days">
  </div>
  <div class="row">
    <input id="pCode" placeholder="Code (blank = generate one)" autocomplete="off">
    <input id="pMax" type="number" min="1" placeholder="Max uses (blank = unlimited)">
  </div>
  <input id="pExpires" type="number" min="1" placeholder="Code itself expires in N days (blank = never)">
  <button onclick="makeCode()">Create code</button>
  <table><thead><tr><th>Code</th><th>Grants</th><th>Used</th><th>Status</th><th></th></tr></thead>
  <tbody id="promo"></tbody></table>

  <h2>Send an announcement</h2>
  <p class="sub">Appears in everyone's bell. Tick the box below to buzz their phone too —
  worth saving for things that genuinely can't wait, since an app that
  interrupts about nothing gets muted for everything.</p>
  <button class="secondary" onclick="useTemplate()">Use the usual format</button>
  <input id="aTitle" placeholder="Title" maxlength="80" oninput="counts()">
  <textarea id="aBody" rows="5" placeholder="Body" maxlength="300" oninput="counts()"></textarea>
  <p class="sub" id="counts">0/80 title · 0/300 body</p>
  <input id="aEmail" placeholder="Just one person? Their email. Blank = everyone">
  <label style="display:flex;gap:8px;align-items:center;margin:4px 0 12px;font-size:14px;">
    <input type="checkbox" id="aPush" style="width:auto;margin:0;">
    Also send a push notification
  </label>
  <button onclick="announce()">Send</button>
  <button class="secondary" onclick="signOut()">Sign out</button>
</div>

<script>
const KEY = "sweep.admin.key";

// Kept in memory as well as in storage. localStorage throws in a private
// window and wherever site data is blocked, and the first version let that
// throw out of the click handler — so the button did nothing at all, with
// nothing in the UI to say why. In memory it still works for the session.
let memoryKey = "";

function key() {
  if (memoryKey) return memoryKey;
  try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; }
}

function signIn() {
  const v = document.getElementById("key").value.trim();
  if (!v) return say("Enter the key first.", true);
  memoryKey = v;
  try {
    localStorage.setItem(KEY, v);
  } catch (e) {
    say("Signed in for this tab only — this browser is blocking storage.", false);
  }
  load();
}

function signOut() {
  memoryKey = "";
  try { localStorage.removeItem(KEY); } catch (e) {}
  location.reload();
}
function say(text, bad) {
  const el = document.getElementById("msg");
  el.textContent = text;
  el.className = "msg " + (bad ? "bad" : "ok");
  setTimeout(() => { el.className = "hide"; }, 6000);
}
// NOTE: this whole page is a TypeScript template literal, so every backslash
// below has to be doubled — including in comments like this one. A lone
// backslash-n is consumed at compile time and drops a real line break into the
// served JavaScript, which is a syntax error that kills the ENTIRE script,
// including the sign-in button hundreds of lines above and seemingly
// unrelated. It happened twice while writing this: once in the strings, and
// once in the comment explaining the strings.
//
// The greeting and sign-off are ~52 characters of the 300 the server allows,
// which is worth knowing before writing rather than after being truncated —
// hence the live count next to it.
const TEMPLATE_TOP = "Hey Sweep users!\\n\\n";
const TEMPLATE_BOTTOM = "\\n\\nThanks,\\nJude \\u2014 sweepshopping.com";

function useTemplate() {
  const el = document.getElementById("aBody");
  // Keeps anything already typed, so pressing this after starting to write
  // wraps what's there instead of throwing it away.
  const middle = el.value.trim() || "";
  el.value = TEMPLATE_TOP + middle + TEMPLATE_BOTTOM;
  el.focus();
  // Drop the cursor where the message goes, not at the end after the sign-off.
  const at = TEMPLATE_TOP.length + middle.length;
  el.setSelectionRange(at, at);
  counts();
}

function counts() {
  const t = document.getElementById("aTitle").value.length;
  const b = document.getElementById("aBody").value.length;
  const el = document.getElementById("counts");
  el.textContent = t + "/80 title \u00b7 " + b + "/300 body";
  el.className = b > 280 || t > 70 ? "sub bad" : "sub";
}

function card(k, n) { return '<div class="card"><div class="k">' + k + '</div><div class="n">' + n + '</div></div>'; }

async function load() {
  let res;
  var began = Date.now();
  try {
    // A deadline of our own. Without one a slow query looks identical to being
    // offline — the browser eventually gives up and the only thing on screen
    // is "check your connection", which sends you looking at your wifi while
    // the actual problem is a query on the server.
    res = await fetch("/admin/stats", {
      headers: { "x-admin-key": key() },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    var waited = Math.round((Date.now() - began) / 1000);
    say(
      waited >= 19
        ? "The server took more than 20s to answer. It is up, but /admin/stats is slow — check the Railway logs."
        : "Couldn't reach the server after " + waited + "s. Check your connection.",
      true,
    );
    return;
  }

  if (res.status === 401) {
    memoryKey = "";
    try { localStorage.removeItem(KEY); } catch (e) {}
    say("That key wasn't accepted.", true);
    return;
  }
  if (res.status === 503) {
    say("The server has no ADMIN_API_KEY set.", true);
    return;
  }
  if (!res.ok) { say("Couldn't load stats (" + res.status + ").", true); return; }
  const s = await res.json();

  document.getElementById("login").className = "hide";
  document.getElementById("app").className = "";
  document.getElementById("stamp").textContent =
    "Updated " + new Date(s.generatedAt).toLocaleTimeString();

  // Separate requests, deliberately not awaited: a failure in either shouldn't
  // stop the stats that just arrived from rendering.
  loadPromo();
  loadRecentStress();

  document.getElementById("providers").innerHTML = s.providers.map(function (p) {
    var pct = p.percent;
    var cls = pct === null ? "" : pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
    var right = p.allowance === null
      ? p.used.toLocaleString() + " calls"
      : p.used.toLocaleString() + " / " + p.allowance.toLocaleString() + " (" + pct + "%)";
    var bar = p.allowance === null
      ? '<div class="sub" style="margin:6px 0 0;font-size:12px">Set ' +
        (p.name === "Decodo" ? "DECODO_CREDITS" : "BRIGHTDATA_CREDITS") +
        " to see how much is left.</div>"
      : '<div class="bar"><i class="' + cls + '" style="width:' + Math.max(pct, 2) + '%"></i></div>';
    return '<div class="prov"><div class="provTop"><b>' + p.name +
      '</b><span class="who">' + p.serves + " &middot; " + p.window +
      '</span><span class="num">' + right + "</span></div>" + bar + "</div>";
  }).join("");

  var peak = Math.max.apply(null, s.trend.map(function (d) { return d.checks; }).concat([1]));
  document.getElementById("trend").innerHTML = s.trend.map(function (d) {
    var h = Math.round((d.checks / peak) * 100);
    var day = new Date(d.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" });
    return '<div title="' + d.checks + ' checks, ' + d.signups + ' signups">' +
      '<span class="val">' + (d.signups ? "+" + d.signups : "") + "</span>" +
      '<span class="col" style="height:' + Math.max(h, 2) + '%"></span>' +
      '<span class="lab">' + day + "</span></div>";
  }).join("");

  void loadVisits();

  document.getElementById("people").innerHTML =
    card("Users", s.users.total) + card("New today", s.users.newToday) +
    card("New this week", s.users.newThisWeek) + card("Tracking", s.usage.tracked) +
    card("Pro", s.tiers.pro) + card("Ultimate", s.tiers.ultimate) +
    card("Est. MRR", "$" + s.revenue.monthly.toFixed(2));

  document.getElementById("today").innerHTML =
    card("Searches", s.usage.searchesToday) + card("Lookups", s.usage.lookupsToday) +
    card("Amazon calls (max)", s.usage.meteredCeiling) +
    card("Announcements", s.notifications.sentToday);

  document.getElementById("stores").innerHTML = s.retailers.map(function (r) {
    var state = !r.enabled ? '<span class="dim">off</span>'
      : r.coolingSeconds ? '<span class="warn">cooling ' + r.coolingSeconds + 's</span>'
      : '<span class="ok">on</span>';
    var rate = r.successRate === null ? "—"
      : '<span class="' + (r.successRate > 0.8 ? "ok" : r.successRate > 0.4 ? "warn" : "bad") + '">'
        + Math.round(r.successRate * 100) + '%</span>';
    return "<tr><td>" + r.label + "</td><td>" + state + "</td><td>" + rate + "</td><td>" + r.checks + "</td></tr>";
  }).join("");

  document.getElementById("heaviest").innerHTML = s.heaviest.length
    ? s.heaviest.map(function (h) {
        return "<tr><td>" + h.email + "</td><td>" + h.tier + "</td><td>" + h.searches + "</td><td>" + h.lookups + "</td></tr>";
      }).join("")
    : '<tr><td colspan="4" class="dim">Nothing used yet today.</td></tr>';
}

async function loadVisits() {
  var res = await fetch("/admin/visits", { headers: { "x-admin-key": key() } });
  if (!res.ok) return;
  var v = await res.json();

  document.getElementById("visits").innerHTML =
    card("Today", v.today) + card("Last 7 days", v.last7) + card("Last 30 days", v.last30);

  // Oldest to newest, so the chart reads left to right like every other one.
  var days = v.daily.slice().reverse().slice(-14);
  var peak = Math.max.apply(null, days.map(function (d) { return d.count; }).concat([1]));
  document.getElementById("visitTrend").innerHTML = days.map(function (d) {
    var h = Math.round((d.count / peak) * 100);
    var label = new Date(d.day + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" });
    return '<div title="' + d.count + ' visits on ' + d.day + '">' +
      '<span class="val">' + (d.count || "") + "</span>" +
      '<span class="col" style="height:' + Math.max(h, 2) + '%"></span>' +
      '<span class="lab">' + label + "</span></div>";
  }).join("");

  function rows(list, keyName) {
    if (!list.length) return "<dt>Nothing yet</dt><dd></dd>";
    return list.map(function (r) {
      return "<dt>" + r[keyName] + "</dt><dd>" + r.count + "</dd>";
    }).join("");
  }
  document.getElementById("visitPages").innerHTML = rows(v.topPages, "path");
  document.getElementById("visitRefs").innerHTML = rows(v.topReferrers, "referrer");
}

async function loadPromo() {
  const res = await fetch("/admin/promo", { headers: { "x-admin-key": key() } });
  if (!res.ok) return;
  const data = await res.json();
  const rows = data.codes.map(function (c) {
    const status = c.expired ? "expired" : c.exhausted ? "used up" : "active";
    const used = c.used + (c.max === null ? " / unlimited" : " / " + c.max);
    const grants = c.days + "d " + c.tier;
    const cls = status === "active" ? "" : ' class="dim"';
    // Attributes carry what the confirm prompt needs, so deleting doesn't have
    // to re-fetch the row it is already looking at.
    const del = '<button class="link" onclick="dropCode(this)" data-code="' + c.code +
      '" data-used="' + c.used + '">Delete</button>';
    return "<tr" + cls + "><td><code>" + c.code + "</code></td><td>" + grants +
      "</td><td>" + used + "</td><td>" + status + "</td><td>" + del + "</td></tr>";
  }).join("");
  document.getElementById("promo").innerHTML = rows ||
    '<tr><td colspan="5" class="dim">No codes yet.</td></tr>';
}

async function runProbe() {
  var url = document.getElementById("probeUrl").value.trim();
  if (!url) return say("Give it a url.", true);

  var out = document.getElementById("probeOut");
  out.innerHTML = '<div class="probe">Fetching&hellip;</div>';

  var res = await fetch("/admin/probe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": key() },
    body: JSON.stringify({ url: url }),
  });
  var d = await res.json().catch(function () { return {}; });
  if (!res.ok) { out.innerHTML = ""; return say(d.error || "Probe failed.", true); }

  // The verdict first. Everything under it is the evidence for it.
  var headline, colour;
  if (d.refused) { headline = "Refused before sending"; colour = "#d97706"; }
  else if (d.error) { headline = "Never completed"; colour = "#dc2626"; }
  else if (d.challenges.length) { headline = "Blocked - challenge page"; colour = "#dc2626"; }
  // Before the success cases, deliberately. A bounce to the homepage carries
  // every marker a real page does, so checked afterwards it reads as a clean
  // success — which is exactly how it was misread the first time.
  else if (d.bounced) { headline = "Blocked - bounced to the homepage"; colour = "#dc2626"; }
  // Prices, not markers. This used to accept either, and markers alone said
  // "Reachable, with product data" about Target's search page, which carries
  // __NEXT_DATA__ and not one price: the payload is 224 bytes of status code
  // and everything real is fetched client-side from an API that 403s. A green
  // verdict there is worse than a red one, because it sends someone off to
  // write a parser for a page with nothing in it.
  else if (d.priceish > 0) { headline = "Reachable, with product data"; colour = "#16a34a"; }
  else if (d.markers.length) { headline = "Reachable, but the prices are not in the HTML"; colour = "#d97706"; }
  else if (d.status === 200) { headline = "200, but nothing a parser wants"; colour = "#d97706"; }
  else { headline = "HTTP " + d.status; colour = "#dc2626"; }

  var rows = "";
  function row(k, v) { rows += "<dt>" + k + "</dt><dd>" + v + "</dd>"; }

  if (d.refused) row("Reason", d.refused);
  if (d.error) row("Error", d.error);
  if (d.status !== null) row("Status", d.status);
  row("Took", (d.ms / 1000).toFixed(1) + "s");
  if (d.bytes) row("Size", Math.round(d.bytes / 1024) + " KB" + (d.truncated ? " (capped)" : ""));
  if (d.markers.length) row("Markers", d.markers.join(", "));
  row("Price-shaped values", d.priceish);
  if (!d.priceish && d.markers.length && d.status === 200) {
    row("What that means",
      "The page loaded but renders its products in the browser. A scraper would " +
      "get this same empty shell. Find the API the page calls and probe that " +
      "instead — it is usually the part that is defended.");
  }
  if (d.challenges.length) row("Challenge text", d.challenges.join(", "));
  if (d.redirects.length) row("Redirects", d.redirects.length + " &rarr; " + d.finalUrl);
  if (d.bounced) {
    row("What that means",
      "You asked for a page and got the front door. The markers below are the " +
      "homepage's, not your page's.");
  }

  out.innerHTML = '<div class="probe"><div class="big" style="color:' + colour + '">' +
    headline + "</div><dl>" + rows + "</dl></div>";
}

async function runAdapter() {
  var retailer = document.getElementById("adRetailer").value;
  var keyword = document.getElementById("adKeyword").value.trim();

  // Amazon and Walmart bill per call. Nothing here should quietly spend money.
  if (retailer === "amazon" || retailer === "walmart") {
    if (!confirm(retailer + " costs real money per request. Run it anyway?")) return;
  }

  var out = document.getElementById("adOut");
  out.innerHTML = '<div class="probe">Running&hellip;</div>';

  var res = await fetch("/admin/probe/adapter", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": key() },
    body: JSON.stringify({ retailer: retailer, keyword: keyword }),
  });
  var d = await res.json().catch(function () { return {}; });
  if (!res.ok) { out.innerHTML = ""; return say(d.error || "Failed.", true); }

  var headline, colour;
  if (d.error) { headline = "Threw"; colour = "#dc2626"; }
  else if (d.status !== "success") { headline = "Adapter says: " + d.status; colour = "#dc2626"; }
  else if (d.count === 0) {
    // The case a url probe cannot see: it worked, and found nothing.
    headline = "Succeeded with zero results"; colour = "#d97706";
  }
  else { headline = "Working - " + d.count + " results"; colour = "#16a34a"; }

  var rows = "";
  function row(k, v) { rows += "<dt>" + k + "</dt><dd>" + v + "</dd>"; }
  row("Took", (d.ms / 1000).toFixed(1) + "s");
  if (d.metered) row("Cost", "billed per request");
  if (d.detail) row("Detail", d.detail);
  if (d.error) row("Error", d.error);
  for (var i = 0; i < d.sample.length; i++) {
    var p = d.sample[i];
    row(p.price === null ? "no price" : "$" + (p.price / 100).toFixed(2), p.title);
  }

  out.innerHTML = '<div class="probe"><div class="big" style="color:' + colour + '">' +
    headline + "</div><dl>" + rows + "</dl></div>";
}

// Drawn on sign-in as well as after a run, so walking away mid-run does not
// lose the answer.
async function loadRecentStress() {
  var res = await fetch("/admin/probe/stress", { headers: { "x-admin-key": key() } });
  if (!res.ok) return;
  var d = await res.json();
  var out = document.getElementById("stRecent");
  if (!d.recent.length) { out.innerHTML = ""; return; }

  out.innerHTML = '<p class="sub" style="margin:14px 0 6px">Earlier runs (cleared on deploy)</p>' +
    '<table><tbody>' + d.recent.map(function (r) {
      var when = new Date(r.at).toLocaleTimeString();
      var colour = r.successRate >= 90 ? "#16a34a" : r.successRate >= 70 ? "#d97706" : "#dc2626";
      return "<tr><td>" + when + "</td><td>" + r.retailer + "</td><td>" + r.runs +
        ' runs</td><td style="color:' + colour + ';font-weight:800">' + r.successRate +
        "%</td><td>" + (r.medianMs === null ? "-" : (r.medianMs / 1000).toFixed(1) + "s median") +
        "</td></tr>";
    }).join("") + "</tbody></table>";
}

async function runStress() {
  var retailer = document.getElementById("stRetailer").value;
  var runs = parseInt(document.getElementById("stRuns").value, 10) || 8;
  var spend = false;

  if (retailer === "amazon" || retailer === "walmart") {
    if (!confirm(runs + " x " + retailer + " costs real money, once per run. Continue?")) return;
    spend = true;
  }

  var out = document.getElementById("stOut");
  out.innerHTML = '<div class="probe">Running ' + runs + " searches, one at a time&hellip; this takes a minute.</div>";

  var res;
  try {
    res = await fetch("/admin/probe/stress", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": key() },
      body: JSON.stringify({ retailer: retailer, runs: runs, spendMoney: spend }),
      // Long, deliberately: fifteen sequential searches against a slow store is
      // minutes, and the default would abandon it halfway with no result.
      signal: AbortSignal.timeout(240000),
    });
  } catch (e) {
    out.innerHTML = "";
    return say("The run did not finish in four minutes.", true);
  }

  var d = await res.json().catch(function () { return {}; });
  if (!res.ok || d.error) { out.innerHTML = ""; return say(d.error || "Failed.", true); }

  var colour = d.successRate >= 90 ? "#16a34a" : d.successRate >= 70 ? "#d97706" : "#dc2626";

  // The run-by-run strip. A store that failed three in a row and then settled
  // is a different problem from one failing every fourth request, and an
  // average hides which you have.
  var strip = "";
  for (var i = 0; i < d.sequence.length; i++) {
    var s = d.sequence[i];
    strip += '<span title="run ' + s.n + ": " + s.status + ", " + s.ms + 'ms" style="display:inline-block;width:14px;height:14px;border-radius:3px;margin-right:3px;background:' +
      (s.status === "success" ? "#16a34a" : s.status === "blocked" ? "#dc2626" : "#d97706") + '"></span>';
  }

  var rows = "";
  function row(k, v) { rows += "<dt>" + k + "</dt><dd>" + v + "</dd>"; }
  row("Runs", d.runs);
  row("Succeeded", d.ok);
  if (d.failed) row("Failed", d.failed);
  if (d.blocked) row("Blocked", d.blocked);
  if (d.medianMs !== null) {
    row("Time", "fastest " + (d.fastestMs / 1000).toFixed(1) + "s, median " +
      (d.medianMs / 1000).toFixed(1) + "s, slowest " + (d.slowestMs / 1000).toFixed(1) + "s");
  }
  for (var r = 0; r < d.reasons.length; r++) {
    row(d.reasons[r].count + "x", d.reasons[r].reason);
  }

  out.innerHTML = '<div class="probe"><div class="big" style="color:' + colour + '">' +
    d.successRate + "% success over " + d.runs + " runs</div>" +
    "<div style='margin-bottom:10px'>" +
    strip + "</div><dl>" + rows + "</dl></div>";
  loadRecentStress();
}

async function dropCode(el) {
  const code = el.getAttribute("data-code");
  const used = parseInt(el.getAttribute("data-used"), 10) || 0;

  // Spelled out, because "delete" reads like it takes access back and it does
  // not — grants already given live on the wallet and stay there.
  const warning = used > 0
    ? "Delete " + code + "?\\n\\n" + used + " already redeemed it. They KEEP their time — " +
      "this only stops anyone else using the code, and erases the record of who redeemed it."
    : "Delete " + code + "? Nobody has redeemed it.";
  if (!confirm(warning)) return;

  const res = await fetch("/admin/promo/" + encodeURIComponent(code), {
    method: "DELETE",
    headers: { "x-admin-key": key() },
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) return say(data.error || "Could not delete that code.", true);

  say("Deleted " + code + ".");
  loadPromo();
}

async function makeCode() {
  const days = parseInt(document.getElementById("pDays").value, 10);
  if (!days || days < 1) return say("Days must be at least 1.", true);

  const res = await fetch("/admin/promo", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": key() },
    body: JSON.stringify({
      tier: document.getElementById("pTier").value,
      days: days,
      code: document.getElementById("pCode").value.trim(),
      maxRedemptions: document.getElementById("pMax").value.trim(),
      expiresInDays: document.getElementById("pExpires").value.trim(),
    }),
  });

  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) return say(data.error || "Could not create that code.", true);

  say("Created " + data.code + ".");
  document.getElementById("pCode").value = "";
  loadPromo();
}

async function announce() {
  const title = document.getElementById("aTitle").value.trim();
  const body = document.getElementById("aBody").value.trim();
  const email = document.getElementById("aEmail").value.trim();
  const push = document.getElementById("aPush").checked;
  if (!title || !body) return say("Title and body are both required.", true);
  const who = email ? email : "EVERY user";
  const how = push ? " AND buzz their phone" : "";
  if (!confirm("Send to " + who + how + "?")) return;

  const res = await fetch("/notifications/announce", {
    method: "POST",
    headers: { "x-admin-key": key(), "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ title, body }, email ? { email } : {}, push ? { push: true } : {})),
  });
  const out = await res.json();
  if (!res.ok) return say(out.error || "Failed.", true);
  say("Filed for " + out.sent + " " + (out.sent === 1 ? "person" : "people")
      + (out.pushed ? ", pushed to " + out.pushed + " device" + (out.pushed === 1 ? "" : "s") : "")
      + ".");
  document.getElementById("aTitle").value = "";
  document.getElementById("aBody").value = "";
  document.getElementById("aEmail").value = "";
  document.getElementById("aPush").checked = false;
  counts();
  load();
}

if (key()) load();
</script>
</body>
</html>`;
