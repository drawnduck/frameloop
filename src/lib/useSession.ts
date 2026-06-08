"use client";

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

export type Session = { address: string } | null;

type SessionStatus = "loading" | "ready" | "signing";

type SessionValue = {
  session: Session;
  status: SessionStatus;
  error: string | null;
  signIn: () => Promise<string | null>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

/**
 * Single shared session state for the whole app.
 *
 * Why a context: useSession() used to be a vanilla hook with its own
 * useState + fetch-on-mount, called independently from every page and
 * from ChromeBar. ChromeBar lives inside ChromeShell and never
 * unmounts between routes, so its private session state was set once
 * at app start (`null`, before any wallet was connected) and stayed
 * stale forever. The page-level useSession on /upload would happily
 * sign the user in, set the cookie, and update its own copy of the
 * state — but ChromeBar's copy never refetched, so its dropdown kept
 * offering "Sign in" while the rest of the app considered the user
 * signed in (and uploads worked end-to-end).
 *
 * Lifting state into a provider makes signIn / signOut / refresh
 * propagate to every consumer in one shot.
 */
const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { account, connected, signMessage } = useWallet();
  const [session, setSession] = useState<Session>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/session", { cache: "no-store" });
      const data: { session: Session } = await r.json();
      setSession(data.session);
    } catch {
      setSession(null);
    } finally {
      setStatus("ready");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // If a session exists but for a different address than the connected wallet,
  // drop it. Common when switching accounts in Petra.
  useEffect(() => {
    if (!connected || !account || !session) return;
    const walletAddr = account.address.toString().toLowerCase();
    if (session.address !== walletAddr) {
      fetch("/api/auth/logout", { method: "POST" }).finally(() =>
        setSession(null),
      );
    }
  }, [connected, account, session]);

  const signIn = useCallback(async (): Promise<string | null> => {
    if (!connected || !account) {
      setError("Connect a wallet first");
      return null;
    }
    setError(null);
    setStatus("signing");
    try {
      const issuedAtMs = Date.now();
      const nonce = (globalThis.crypto.randomUUID?.() ?? `${issuedAtMs}`).replace(/-/g, "");
      const message =
        `Sign in to Frameloop.\n\n` +
        `Wallet: ${account.address.toString()}\n` +
        `Issued at: ${issuedAtMs}`;

      const result = await signMessage({ message, nonce });
      // publicKey isn't returned by signMessage; pull it from the connected
      // account. signature is a Signature object — .toString() yields hex.
      const publicKey = normalizeHex(account.publicKey);
      const signature = normalizeHex(result.signature);

      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: account.address.toString().toLowerCase(),
          publicKey,
          signature,
          fullMessage: result.fullMessage,
          issuedAtMs,
        }),
      });

      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        throw new Error(body.reason ?? body.error ?? `HTTP ${resp.status}`);
      }

      await refresh();
      return account.address.toString().toLowerCase();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("ready");
      return null;
    }
  }, [connected, account, signMessage, refresh]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession(null);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ session, status, error, signIn, signOut, refresh }),
    [session, status, error, signIn, signOut, refresh],
  );

  return createElement(SessionContext.Provider, { value }, children);
}

/**
 * Client-side session hook. Reads the shared session state from
 * SessionProvider — same return shape it had before the provider
 * refactor, so every call site works unchanged.
 *
 * Throws if used outside SessionProvider. The provider is mounted
 * inside <Providers> in src/app/providers.tsx, so anything rendered
 * under the root layout has access.
 */
export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used inside <SessionProvider>");
  }
  return ctx;
}

function normalizeHex(v: unknown): string {
  if (typeof v === "string") {
    return v.startsWith("0x") ? v : `0x${v}`;
  }
  if (v && typeof v === "object") {
    const obj = v as {
      toString?: () => string;
      data?: { data?: Uint8Array } | Uint8Array;
    };
    // Ed25519PublicKey / Signature classes from ts-sdk: { data: { data: Uint8Array } }
    const inner = obj.data;
    if (inner instanceof Uint8Array) return bytesToHex(inner);
    if (inner && "data" in inner && inner.data instanceof Uint8Array) {
      return bytesToHex(inner.data);
    }
    if (typeof obj.toString === "function") {
      const s = obj.toString();
      if (typeof s === "string" && /^(0x)?[0-9a-fA-F]+$/.test(s)) {
        return s.startsWith("0x") ? s : `0x${s}`;
      }
    }
  }
  throw new Error("Cannot normalize value to hex");
}

function bytesToHex(b: Uint8Array): string {
  return (
    "0x" +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")
  );
}
