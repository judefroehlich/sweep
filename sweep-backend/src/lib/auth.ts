import { createClient } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";

const supabaseAuthClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    /**
     * Anonymous per-install id, sent by guests so their daily search cap can
     * be enforced server-side. Never trusted for anything a real account can
     * do — it identifies a device, it does not authenticate a person.
     */
    guestDeviceId?: string;
  }
}

/**
 * Hard gate: no valid Supabase session, no access. Use on everything that
 * reads or writes user-owned data.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Missing authorization token" });
  }

  const token = authHeader.slice(7);
  const { data, error } = await supabaseAuthClient.auth.getUser(token);

  if (error || !data.user) {
    return reply.status(401).send({ error: "Invalid or expired session" });
  }

  request.userId = data.user.id;
}

/**
 * Soft gate for endpoints guests may use (compiled search, deals feed).
 * Populates userId when a valid token is present, falls back to the device id
 * otherwise, and never rejects — the route decides what a guest may do.
 *
 * An invalid token is treated as "guest", not as an error, so an expired
 * session degrades to the guest experience instead of a wall.
 */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const { data } = await supabaseAuthClient.auth.getUser(authHeader.slice(7));
    if (data?.user) {
      request.userId = data.user.id;
      return;
    }
  }

  const deviceId = request.headers["x-device-id"];
  if (typeof deviceId === "string" && isValidDeviceId(deviceId)) {
    request.guestDeviceId = deviceId;
  }
}

/**
 * Device ids are client-generated UUIDs. Validate the shape so a caller can't
 * spray arbitrary strings and mint a fresh quota row per request.
 */
function isValidDeviceId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Confirm a password belongs to an email, without disturbing the caller's
 * session.
 *
 * Used to re-authenticate before irreversible actions. A bearer token proves a
 * device was signed in at some point; it does not prove who is holding that
 * device now, which is exactly the gap that matters when the action is
 * "delete everything, permanently".
 *
 * Deliberately its own client: signInWithPassword mutates the session on the
 * instance it's called on, and the shared one is used to VERIFY tokens for
 * every request. Reusing it would let one user's password check disturb
 * everyone else's auth.
 */
export async function verifyPassword(email: string, password: string) {
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  return { error };
}

/**
 * Seconds since this token's holder last actually signed in.
 *
 * Read from the JWT's `amr` claim, which records the authentication event
 * itself — a password entered, a Google account chosen — and is carried
 * forward unchanged when the session silently refreshes. That is what makes it
 * useful: `iat` resets on every refresh and says nothing about when anybody
 * last proved who they were.
 *
 * ONLY SAFE AFTER requireAuth. This decodes the payload without checking the
 * signature, because Supabase already checked it in getUser(); on a token that
 * has not been through that, anybody could write any timestamp they liked.
 *
 * Null when there is no usable claim, which callers must treat as "not recent"
 * rather than as a pass.
 */
export function secondsSinceSignIn(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
      amr?: { method?: string; timestamp?: number }[];
    };
    const stamps = (payload.amr ?? [])
      .map((entry) => entry.timestamp)
      .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    if (stamps.length === 0) return null;
    return Math.max(0, Date.now() / 1000 - Math.max(...stamps));
  } catch {
    return null;
  }
}
