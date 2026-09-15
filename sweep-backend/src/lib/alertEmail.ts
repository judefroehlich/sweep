// lib/alertEmail.ts
//
// One way for the server to tell its owner something is wrong.
//
// Used to live inside health.ts, which was fine while scraper failures were
// the only thing worth an email. Credit alerts need the same thing, and two
// copies of a mail setup is two places for one of them to be misconfigured.
//
// Resend first, SMTP second. Railway blocks outbound SMTP below its Pro plan:
// the test alert timed out connecting, with correct credentials. Resend is an
// HTTPS call, which nothing blocks. SMTP stays for running this anywhere that
// allows it.

import nodemailer from "nodemailer";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Resend's shared test sender. Works with no domain set up, but only delivers
 * to the email address the Resend account was created with — which, for alerts
 * to the one person who runs this, is exactly the address wanted.
 */
const RESEND_DEFAULT_FROM = "Sweep alerts <onboarding@resend.dev>";

function mailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Nodemailer's defaults wait two minutes for a server that never answers,
    // which is what a blocked SMTP port looks like. Fail in seconds instead.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function resendKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}

/** Whether an alert would actually leave the server, rather than only be logged. */
export function isAlertEmailConfigured(): boolean {
  return resendKey() !== null || mailer() !== null;
}

type SendResult = { result: "sent" | "logged" | "failed"; error?: string };

/**
 * Email the admin. Never throws.
 *
 * "logged" means no mail is configured, so the alert went to the server log
 * and nowhere else — the caller can say so rather than implying it was sent.
 */
export async function sendAdminAlert(subject: string, body: string): Promise<SendResult> {
  const key = resendKey();
  if (key) return sendViaResend(key, subject, body);

  const transport = mailer();
  if (!transport) {
    // Without mail configured the alert still has to be visible somewhere.
    console.error(`\n[alert] (email not configured)\n${subject}\n${body}\n`);
    return { result: "logged" };
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: process.env.ALERT_EMAIL ?? process.env.SMTP_USER!,
      subject,
      text: body,
    });
    console.log(`[alert] sent: ${subject}`);
    return { result: "sent" };
  } catch (err) {
    console.error("[alert] failed to send:", err);
    // Also logged in full above. This short version is for the dashboard, so
    // "connection timeout" and "invalid login" don't both read as "failed".
    return { result: "failed", error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

async function sendViaResend(key: string, subject: string, body: string): Promise<SendResult> {
  const to = process.env.ALERT_EMAIL?.trim();
  if (!to) {
    console.error(`\n[alert] (RESEND_API_KEY is set but ALERT_EMAIL isn't)\n${subject}\n${body}\n`);
    return { result: "failed", error: "Set ALERT_EMAIL on Railway to the address alerts should go to." };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.ALERT_FROM?.trim() || RESEND_DEFAULT_FROM,
        to: [to],
        subject,
        text: body,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      // Resend's messages are specific and worth passing on as they are, e.g.
      // "You can only send testing emails to your own email address".
      const detail = await res.json().catch(() => null) as { message?: string } | null;
      const error = `Resend ${res.status}: ${detail?.message ?? "no reason given"}`;
      console.error(`[alert] failed to send: ${error}`);
      return { result: "failed", error: error.slice(0, 300) };
    }

    console.log(`[alert] sent: ${subject}`);
    return { result: "sent" };
  } catch (err) {
    console.error("[alert] failed to send:", err);
    return { result: "failed", error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}
