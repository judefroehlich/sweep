// lib/alertEmail.ts
//
// One way for the server to tell its owner something is wrong.
//
// Used to live inside health.ts, which was fine while scraper failures were
// the only thing worth an email. Credit alerts need the same thing, and two
// copies of an SMTP setup is two places for one of them to be misconfigured.

import nodemailer from "nodemailer";

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

/** Whether an alert would actually leave the server, rather than only be logged. */
export function isAlertEmailConfigured(): boolean {
  return mailer() !== null;
}

/**
 * Email the admin. Never throws.
 *
 * "logged" means SMTP isn't configured, so the alert went to the server log
 * and nowhere else — the caller can say so rather than implying it was sent.
 */
export async function sendAdminAlert(
  subject: string,
  body: string,
): Promise<{ result: "sent" | "logged" | "failed"; error?: string }> {
  const transport = mailer();
  if (!transport) {
    // Without SMTP configured the alert still has to be visible somewhere.
    console.error(`\n[alert] (SMTP not configured)\n${subject}\n${body}\n`);
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
