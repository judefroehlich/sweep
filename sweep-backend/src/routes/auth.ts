import type { FastifyInstance } from "fastify";
import { requireAuth, secondsSinceSignIn, verifyPassword } from "../lib/auth.js";
import { SENSITIVE_LIMIT } from "../lib/rateLimit.js";
import { deleteAccount } from "../lib/deleteAccount.js";
import { prisma } from "../lib/prisma.js";

/**
 * How recent a sign-in has to be to stand in for a password.
 *
 * Ten minutes: long enough to sign in, find the setting and read the warning,
 * short enough that a phone left unlocked on a table has aged out of it.
 */
const RECENT_SIGN_IN_SECONDS = 10 * 60;

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/auth/sync-user",
    {
      preHandler: requireAuth,
      config: { rateLimit: SENSITIVE_LIMIT },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const { email } = request.body as { email: string };

      const user = await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: {
          id: userId,
          email,
          wallet: { create: {} },
        },
      });

      return { user };
    },
  );

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.userId!;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });

    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }

    return { user };
  });

  // ---- delete this account, permanently ----
  //
  // Required by Google Play for any app with accounts, and scoped strictly to
  // the caller: the user id comes from the verified token, never from the body,
  // so there is no id here for anyone to tamper with.
  app.delete(
    "/me",
    { preHandler: requireAuth, config: { rateLimit: SENSITIVE_LIMIT } },
    async (request, reply) => {
      const userId = request.userId!;
      const { confirm, password } = (request.body ?? {}) as {
        confirm?: unknown;
        password?: unknown;
      };

      // A deliberate second step. This is irreversible and there is no undo,
      // so it should not be reachable by a single malformed request.
      if (confirm !== true) {
        return reply.status(400).send({
          error: "Send { confirm: true } to delete this account.",
          code: "CONFIRMATION_REQUIRED",
        });
      }

      // Re-authenticate. A valid token only proves this phone was signed in at
      // some point — it says nothing about who is holding it right now, and an
      // unlocked phone is the realistic threat for an irreversible action.
      //
      // Checked here rather than in the app so it can't be skipped by calling
      // the API directly with a stolen token.
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (!user) return reply.status(404).send({ error: "Account not found" });

      // Two ways to pass, because an account made with Google has no password
      // to type. Either give the right password, or have signed in within the
      // last few minutes — for a Google account that means choosing it again
      // in the Google sheet immediately before deleting.
      //
      // Both prove the same thing: that whoever is holding the phone right now
      // can authenticate as this person. A token from last week cannot, which
      // is the case this check exists for. And it is still enforced here rather
      // than in the app, so calling the API directly with an old token fails.
      //
      // Before this, the route required a password outright, which made
      // deletion impossible for Google accounts — and in-app deletion is a Play
      // requirement, not a nicety.
      const token = (request.headers.authorization ?? "").slice(7);
      const hasPassword = typeof password === "string" && password.length > 0;

      if (!hasPassword) {
        const age = secondsSinceSignIn(token);
        if (age === null || age > RECENT_SIGN_IN_SECONDS) {
          return reply.status(403).send({
            error: "Sign in again to confirm it's you, then delete your account.",
            code: "REAUTH_REQUIRED",
          });
        }
      }

      const { error: reauthError } = hasPassword
        ? await verifyPassword(user.email, password as string)
        : { error: null };
      if (reauthError) {
        // 403, not 401. The session IS valid — the caller simply failed a
        // second check. The app treats any 401-with-a-token as a dead session
        // and signs the user out, so returning 401 here would log someone out
        // for mistyping their password, which looks exactly like the deletion
        // succeeding.
        return reply.status(403).send({
          error: "That password isn't right.",
          code: "PASSWORD_INCORRECT",
        });
      }

      const summary = await deleteAccount(userId);
      request.log.info({ userId, ...summary }, "account deleted");

      return { ok: true, ...summary };
    },
  );
}
