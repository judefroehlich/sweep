// routes/legal.ts
//
// The privacy policy and the account-deletion request page.
//
// Both are served from the backend rather than a separate site because Google
// Play requires each to be a publicly reachable URL, and the API already has
// one. Point a real domain at this later and the links keep working.
//
// The deletion page in particular has a requirement people miss: it must be
// reachable by someone who has already uninstalled the app, and therefore
// cannot be behind a login.
//
// Written from what the schema actually stores. A policy that lists categories
// the app doesn't collect is as much of a problem as one that omits something
// it does — the Data Safety form has to match this document, and Google checks.

import type { FastifyInstance } from "fastify";
import { storeListPhrase } from "../lib/scrapers/types.js";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? "support@sweepapp.example";
const APP_NAME = "Sweep";
/** Bump when the substance changes, not for typo fixes. */
const LAST_UPDATED = "14 September 2026";

export async function legalRoutes(app: FastifyInstance) {
  app.get("/privacy", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(page("Privacy Policy", privacyBody()));
  });

  // Google Play wants this URL on the store listing, separate from the policy.
  app.get("/delete-account", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(page("Delete your account", deletionBody()));
  });

  // Where Supabase sends people after they click the link in a confirmation
  // email. Without somewhere real to land, the redirect falls back to whatever
  // Site URL is configured — which was localhost, so every tester who
  // confirmed their address hit a dead page on their phone.
  //
  // Supabase has already done the verifying by the time the browser gets here.
  // This page exists purely to say so and to get the person back into the app,
  // which is the step a web-shaped auth flow leaves out on mobile.
  app.get("/confirmed", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send(page("Email confirmed", confirmedBody()));
  });
}

function confirmedBody() {
  return `
  <h1>Email confirmed</h1>
  <p>
    Thanks — your ${APP_NAME} account is ready. Head back to the app and it
    will sign you in on its own; there's nothing left to type.
  </p>
  <p>
    <!--
      Android intent URL rather than a bare sweep:// link. Chrome, and
      especially the in-app browsers mail clients use, often refuse to navigate
      to a custom scheme from a link. An intent:// URL is the documented way,
      names the package explicitly so it opens the installed app rather than
      hunting for a handler, and falls back to the Play listing if the app
      isn't installed on whatever device opened the email.
    -->
    <a class="cta" href="intent://open#Intent;scheme=sweep;package=com.sweepshopping.app;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.sweepshopping.app;end">Open ${APP_NAME}</a>
  </p>
  <p class="note">
    If that button does nothing, just switch to the ${APP_NAME} app yourself —
    the confirmation has already gone through. If the app is still waiting,
    tap "I've confirmed it" on that screen.
  </p>
  <p class="note">
    Didn't sign up for ${APP_NAME}? You can ignore this. An address can't be
    used until it is confirmed, and nothing further will be sent to it.
  </p>

  <p><a href="/privacy">Privacy policy</a></p>`;
}

function privacyBody() {
  return `
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated ${LAST_UPDATED}</p>

  <p>
    ${APP_NAME} is a price tracker and shopping companion. This policy explains
    exactly what it stores, why, and how to get rid of it. It describes what the
    app actually does — not a general template.
  </p>

  <h2>What we collect</h2>

  <h3>If you create an account</h3>
  <ul>
    <li><strong>Email address</strong> — how you sign in, and where price alerts go if you enable email. Handled by Supabase Auth.</li>
    <li><strong>If you continue with Google</strong> — Google confirms your email address to us. Supabase Auth also keeps the name and profile picture link Google sends with it; the app does not display or use them. We never receive your Google password or access to anything else in your Google account.</li>
    <li><strong>Username</strong> — optional, and <em>public</em>. It appears on the leaderboard and next to deals you find. If you don't set one you appear as an anonymous "Sweeper".</li>
  </ul>

  <h3>What you put into the app</h3>
  <ul>
    <li><strong>Products you track</strong> — the item, when you started, its price then, and any alert threshold you set.</li>
    <li><strong>Lists</strong> — names, descriptions, items and notes. A list is private unless you turn sharing on, which creates an unguessable link. Turning sharing off destroys that link permanently.</li>
    <li><strong>Budget entries</strong> — amounts, categories, notes and dates you enter yourself. This is spending information, so it is worth being explicit: it is stored on our servers, it is never shown to anyone else, and it is never used for advertising.</li>
    <li><strong>Deal Radars</strong> — the search terms and target prices you ask us to watch for.</li>
  </ul>

  <h3>Collected automatically</h3>
  <ul>
    <li><strong>Notification token</strong> — a device identifier from Expo, so we can send price alerts. Deleted when you turn notifications off.</li>
    <li><strong>Device ID</strong> — a random identifier generated on your device, used only to count a guest's free searches. It is not linked to a person and contains nothing about your device.</li>
    <li><strong>IP address, hashed</strong> — we store a one-way hash, never the address itself, purely to stop one network exhausting the free search allowance. It cannot be reversed to identify you.</li>
    <li><strong>Plan and usage counters</strong> — your tier, XP, and how many searches or checks you've used today.</li>
    <li><strong>Crash and error reports</strong> — via Sentry, to find bugs. Query strings are stripped before reports are sent.</li>
  </ul>

  <h2>What we do not collect</h2>
  <ul>
    <li>No payment card details. If you subscribe, Google Play handles payment; we only ever learn that a purchase happened.</li>
    <li>No location, contacts, photos, files, calendar, microphone or camera.</li>
    <li>No browsing history or activity outside the app.</li>
    <li>We do not sell personal information, and nothing you track, search, list or budget is shared with data brokers or advertisers.</li>
  </ul>

  <h2>Who else sees data</h2>
  <p>Only what each one needs to do its job:</p>
  <ul>
    <li><strong>Supabase</strong> — hosts the database and handles sign-in.</li>
    <li><strong>Expo</strong> — delivers push notifications. Receives the notification token and the alert text.</li>
    <li><strong>Retailers (${storeListPhrase(6)})</strong>, <strong>Bright Data</strong> and <strong>Decodo</strong> — receive the <em>search terms and product links</em> needed to look up a price. They do not receive your identity, email, or anything else about you.</li>
    <li><strong>Sentry</strong> — receives crash reports.</li>
    <li><strong>Resend</strong> — sends email alerts, if you enable them.</li>
    <li><strong>Google</strong> — confirms your identity if you choose to continue with Google.</li>
    <li><strong>Google Play</strong> — handles subscriptions.</li>
    <li><strong>Google AdMob</strong> — shows a video ad only when you choose to watch one for extra searches. Ads are requested as non-personalized. AdMob receives device information such as the advertising ID and IP address, which Google uses to deliver the ad, measure it and prevent fraud, under <a href="https://policies.google.com/technologies/partner-sites">Google's own policy</a>. Nothing you track, search or budget is sent to it.</li>
  </ul>

  <h2>How long we keep it</h2>
  <p>
    Your data stays until you delete it. Price history for a product is kept
    beyond that, because it is public catalogue information about the item
    rather than about you, and other people watching the same product rely on
    it. Guest counters and hashed IP records reset daily.
  </p>

  <h2>Deleting your data</h2>
  <p>
    In the app: <strong>Profile → Delete my account</strong>. It is immediate and
    permanent, and removes your account, tracked products, lists, budget,
    radars, notification tokens and XP. Deals you found stay on the public feed
    but stop being attributed to you.
  </p>
  <p>
    If you have already uninstalled the app, use the
    <a href="/delete-account">account deletion page</a>.
  </p>

  <h2>Children</h2>
  <p>
    ${APP_NAME} is not directed at children under 13, and we do not knowingly
    collect their information. If you believe a child has created an account,
    contact us and we will remove it.
  </p>

  <h2>Your rights</h2>
  <p>
    Depending on where you live you may have the right to access, correct,
    export or delete your information. Deletion is available in the app; for
    anything else, email us and we will respond.
  </p>

  <h2>Changes</h2>
  <p>
    If this policy changes materially we will update the date above and notify
    you in the app before the change takes effect.
  </p>

  <h2>Contact</h2>
  <p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`;
}

function deletionBody() {
  return `
  <h1>Delete your ${APP_NAME} account</h1>
  <p class="updated">Last updated ${LAST_UPDATED}</p>

  <h2>If you still have the app</h2>
  <p>This is instant and needs no email:</p>
  <ol>
    <li>Open ${APP_NAME}</li>
    <li>Go to <strong>Profile</strong></li>
    <li>Tap <strong>Delete my account</strong></li>
    <li>Confirm</li>
  </ol>

  <h2>If you've already uninstalled it</h2>
  <p>
    Email <a href="mailto:${SUPPORT_EMAIL}?subject=Delete%20my%20account">${SUPPORT_EMAIL}</a>
    from the address you signed up with, asking us to delete your account. We
    will confirm within 30 days, usually much sooner.
  </p>
  <p class="note">
    We can only act on a request sent from the account's own email address —
    otherwise anyone could delete someone else's account.
  </p>

  <h2>What gets deleted</h2>
  <ul>
    <li>Your account and email address</li>
    <li>Everything you track, and its alert settings</li>
    <li>Your lists and any share links</li>
    <li>Your budget entries and limits</li>
    <li>Your Deal Radars</li>
    <li>Your notification tokens</li>
    <li>Your XP, badges and leaderboard entry</li>
  </ul>

  <h2>What stays, and why</h2>
  <ul>
    <li>
      <strong>Price history for products.</strong> This is public information
      about an item, not about you, and other people watching the same product
      depend on it.
    </li>
    <li>
      <strong>Deals you found</strong> remain on the public feed but are
      anonymised — your name is removed.
    </li>
  </ul>

  <h2>How long it takes</h2>
  <p>
    Deleting in the app is immediate and cannot be undone. There is no grace
    period and no way to recover the account afterwards. Emailed requests are
    handled within 30 days.
  </p>

  <h2>Deleting some of your data, without deleting your account</h2>
  <p>
    You do not have to delete your whole account to remove something. Each of
    these takes effect immediately and needs no request:
  </p>
  <ul>
    <li><strong>A tracked product and its price alerts</strong> — open it from
      Tracking and choose Stop tracking.</li>
    <li><strong>A budget entry</strong> — press and hold it in Budget.</li>
    <li><strong>A monthly budget or category limit</strong> — edit or clear it
      in Budget.</li>
    <li><strong>A list, or a single item on one</strong> — delete it in Lists.
      Turning off sharing also invalidates the share link.</li>
    <li><strong>A Deal Radar</strong> — delete it in Deal Radar.</li>
    <li><strong>Your public username</strong> — change it in Profile; leaving
      it blank shows you anonymously on the leaderboard.</li>
    <li><strong>Push notification tokens</strong> — turn off price alerts in
      Profile, or revoke the notification permission in Android settings.</li>
  </ul>
  <p class="note">
    If you would rather we removed something for you, email
    <a href="mailto:${SUPPORT_EMAIL}?subject=Delete%20some%20of%20my%20data">${SUPPORT_EMAIL}</a>
    from the address you signed up with.
  </p>

  <p><a href="/privacy">Privacy policy</a></p>`;
}

/**
 * Shared shell. Deliberately plain: these pages are read once, often on a phone,
 * sometimes by a reviewer, and they need to render everywhere without help.
 */
function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — ${APP_NAME}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 32px 20px 64px; max-width: 720px;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #16161a; background: #ffffff;
  }
  .brand { color: #C24A22; font-weight: 900; letter-spacing: .5px; text-transform: uppercase; font-size: 13px; }
  h1 { font-size: 30px; margin: 8px 0 4px; line-height: 1.2; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  h3 { font-size: 16px; margin: 20px 0 4px; }
  .updated { color: #6b6b73; font-size: 14px; margin-top: 0; }
  .note { color: #6b6b73; font-size: 14px; }
  ul, ol { padding-left: 22px; }
  li { margin: 6px 0; }
  a { color: #C24A22; }
  /* Big enough to hit with a thumb — this page is only ever read on a phone. */
  .cta { display: inline-block; margin: 8px 0 4px; padding: 13px 22px; border-radius: 10px;
         background: #C24A22; color: #fff; font-weight: 700; text-decoration: none; }
  footer { margin-top: 48px; border-top: 1px solid #e3e3e6; padding-top: 16px; color: #6b6b73; font-size: 13px; }
  @media (prefers-color-scheme: dark) {
    body { color: #ededf0; background: #0d0d0d; }
    .updated, .note, footer { color: #9a9aa2; }
    .brand, a { color: #E4733F; }
    .cta { background: #E4733F; color: #16161a; }
    footer { border-top-color: #2a2a2a; }
  }
</style>
</head>
<body>
<div class="brand">${APP_NAME}</div>
${body}
<footer>${APP_NAME} — your online shopping buddy · <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></footer>
</body>
</html>`;
}
