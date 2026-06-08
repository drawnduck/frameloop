import {
  AccountAddress,
  AuthenticationKey,
  Ed25519PublicKey,
  Ed25519Signature,
} from "@aptos-labs/ts-sdk";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "moc_session";
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "SESSION_SECRET must be set in .env.local (>= 32 chars). Generate with: openssl rand -hex 32",
    );
  }
  return new TextEncoder().encode(s);
}

export type Session = {
  address: string;
};

export async function signSession(address: string): Promise<string> {
  return await new SignJWT({ address })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload }: { payload: JWTPayload & { address?: string } } =
      await jwtVerify(token, getSecret());
    if (typeof payload.address === "string") {
      return { address: payload.address.toLowerCase() };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Server-side helper: read the moc_session cookie and return the Session, or null.
 * Use this in API routes and server components.
 */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return await verifySessionToken(token);
}

export async function setSessionCookie(address: string) {
  const token = await signSession(address);
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

// ─────────────────────────────────────────────
// Sign-In with Aptos (SIWA) verification
// ─────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Verify a Sign-In with Aptos signed message.
 *
 * Wallet adapters that follow AIP-62 return { fullMessage, signature, publicKey, address }
 * after calling `signMessage`. We:
 *   1. Verify the Ed25519 signature against fullMessage with the claimed publicKey.
 *   2. Verify the publicKey derives (via AuthenticationKey) to the claimed address.
 *   3. Reject if the embedded timestamp is older than CLOCK_SKEW_MS or in the future.
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes either side

export type SignedSiwa = {
  fullMessage: string;
  signature: string;
  publicKey: string;
  address: string;
  /** Unix ms timestamp included in the message body. */
  issuedAtMs: number;
};

export function verifySiwa(input: SignedSiwa): { ok: true } | { ok: false; reason: string } {
  // Time check
  const now = Date.now();
  if (input.issuedAtMs > now + CLOCK_SKEW_MS) {
    return { ok: false, reason: "issuedAt is in the future" };
  }
  if (input.issuedAtMs < now - CLOCK_SKEW_MS) {
    return { ok: false, reason: "issuedAt is too old" };
  }
  // Ensure the issuedAt is actually inside the signed message, otherwise the
  // client could lie about it.
  if (!input.fullMessage.includes(String(input.issuedAtMs))) {
    return { ok: false, reason: "issuedAt not present in fullMessage" };
  }

  let pk: Ed25519PublicKey;
  let sig: Ed25519Signature;
  try {
    pk = new Ed25519PublicKey(hexToBytes(input.publicKey));
    sig = new Ed25519Signature(hexToBytes(input.signature));
  } catch {
    return { ok: false, reason: "malformed publicKey or signature" };
  }

  const msgBytes = new TextEncoder().encode(input.fullMessage);
  const sigOk = pk.verifySignature({ message: msgBytes, signature: sig });
  if (!sigOk) return { ok: false, reason: "signature verification failed" };

  // Derive address from publicKey via AuthenticationKey.
  const authKey = AuthenticationKey.fromPublicKey({ publicKey: pk });
  const derived = authKey.derivedAddress();
  const claimed = AccountAddress.fromString(input.address);
  if (!derived.equals(claimed)) {
    return { ok: false, reason: "publicKey does not match address" };
  }

  return { ok: true };
}
