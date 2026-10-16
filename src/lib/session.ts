import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";

/**
 * Session strategy: a signed, HTTP-only, SameSite=lax cookie holding a
 * long-lived JWT, backed by a server-side Session row (the "control"
 * layer). This gives us:
 *   - Real revocation ("log out everywhere" / manual logout invalidates
 *     the DB row, which is checked on every request)
 *   - A SLIDING idle window: every time the user is active the row's
 *     expiry is pushed forward, so someone who keeps using the system is
 *     never logged out. They are only signed out after SESSION_IDLE_DAYS
 *     (default 90) with no activity at all, or when they log out themselves.
 *
 * The JWT/cookie lifetime is deliberately much longer than the idle window
 * so the cookie itself never expires first — the DB row is the real gate.
 */

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "tecnoid_session";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Days of total inactivity before a session is dropped (sliding window). */
const IDLE_DAYS = Number(process.env.SESSION_IDLE_DAYS || 90);
/** Lifetime of the signed cookie / JWT. Kept far above IDLE_DAYS on purpose. */
const COOKIE_DAYS = Math.max(Number(process.env.SESSION_COOKIE_DAYS || 365), IDLE_DAYS);
/** Don't hit the DB to extend the window more often than this. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function getSecretKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Set a strong random value in .env"
    );
  }
  return new TextEncoder().encode(secret);
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface SessionPayload {
  sub: string; // userId
  sid: string; // session row id
  org: string; // organizationId
}

export async function createSession(params: {
  userId: string;
  organizationId: string;
  userAgent?: string;
  ipAddress?: string;
}): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + IDLE_DAYS * DAY_MS);

  const session = await db.session.create({
    data: {
      userId: params.userId,
      tokenHash,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
      expiresAt
    }
  });

  const jwt = await new SignJWT({
    sub: params.userId,
    sid: session.id,
    org: params.organizationId
  } satisfies SessionPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_DAYS}d`)
    .sign(getSecretKey());

  cookies().set(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // "lax" (not "strict"): strict drops the cookie on any link opened from
    // another app (WhatsApp, email, a bookmark in another browser tab…),
    // which made phones look logged-out. Lax still blocks cross-site POSTs.
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_DAYS * 24 * 60 * 60
  });

  return jwt;
}

export async function getSessionPayload(): Promise<SessionPayload | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    const parsed = payload as unknown as SessionPayload;

    // Verify the backing session row is still valid (not revoked/expired).
    const session = await db.session.findUnique({ where: { id: parsed.sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return null;
    }

    // Sliding window: record activity and push the expiry forward. Throttled
    // so a burst of API calls doesn't turn into a burst of DB writes.
    const now = new Date();
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await db.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + IDLE_DAYS * DAY_MS) }
      });
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const payload = await getSessionPayload();
  if (payload) {
    await db.session.update({
      where: { id: payload.sid },
      data: { revokedAt: new Date() }
    });
  }
  cookies().delete(COOKIE_NAME);
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}
