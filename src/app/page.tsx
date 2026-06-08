"use client";

/**
 * Home route — switches between the personal Vault (signed in) and a quiet
 * Landing (signed out / never connected). Both share the same ChromeBar and
 * the same paper-white aesthetic, so the transition between unauth and auth
 * states is a content swap rather than a theme change.
 *
 * Selection / delete contract:
 *   The Vault owns its scroll/snap mechanics but selection state is
 *   *lifted up* here so the trash action's stateful machinery (probing
 *   on-chain status, signing, indexing) lives next to the data fetch
 *   instead of inside the photo strip component. The flow is:
 *
 *     1. user double-clicks a card  → Vault calls onSelect(postId)
 *     2. we hand Vault a `selectionOverlay` (the trash pill); Vault
 *        position-fixes it above the chosen photo and tracks its
 *        coordinates across horizontal scrolls
 *     3. user clicks ✓ on the pill → probe on-chain status:
 *        • alive  → wallet signs delete_blob, wait for tx, then DELETE
 *                   /api/posts with {postId, txHash}
 *        • missing → no wallet step; DELETE /api/posts with
 *                    {postId, force:true} (server re-verifies missingness)
 *     4. remove the post from local state; selection clears via Vault's
 *        own "selected post is no longer in posts" effect, which reverts
 *        the chrome right slot back to the upload "+".
 */

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChromeRightSlot } from "@/components/ChromeShell";
import { Vault, type VaultPost } from "@/components/Vault";
import { useSession } from "@/lib/useSession";
import {
  buildDeleteBlobPayload,
  probeBlobAlive,
  waitForAptosTx,
} from "@/lib/shelby";

function UploadPlus() {
  return (
    <Link href="/upload" className="chrome-dot" aria-label="Upload a memory">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="M7 2.5V11.5M2.5 7H11.5"
          stroke="currentColor"
          strokeLinecap="round"
        />
      </svg>
    </Link>
  );
}

/** SVG glyph for the trash action. Shared between the icon button and the
 *  confirmation pill so the visual language stays consistent. */
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M3 4H11M5.5 4V2.75H8.5V4M4 4L4.5 11.5H9.5L10 4M6 6.5V9.5M8 6.5V9.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1"
      />
    </svg>
  );
}

type TrashPhase =
  | "idle"
  | "confirm"
  // probing the on-chain metadata between confirm-click and the actual
  // signing — fast (one view call) but worth surfacing so the pill
  // doesn't sit there silently for a second.
  | "probing"
  | "signing"
  | "confirming"
  // ghost mode: blob is missing on-chain (e.g. Shelbynet state reset),
  // so we skip signing entirely and just drop the cache row.
  | "ghost"
  | "indexing";

/**
 * The contextual top-right action when something is selected. Two visual
 * states:
 *   • idle  — a single trash icon styled like .chrome-dot
 *   • confirm — a small inline pill ("Forget forever?  ✕  ✓") so the
 *               irreversible action takes two deliberate taps
 *
 * During the signing/confirming/indexing phases the pill stays visible
 * with a quiet status word in place of the buttons, so the user
 * understands why the chrome hasn't snapped back yet.
 */
function TrashAction({
  phase,
  onArm,
  onCancel,
  onConfirm,
  errorMessage,
}: {
  phase: TrashPhase;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  errorMessage: string | null;
}) {
  if (phase === "idle") {
    return (
      <button
        type="button"
        onClick={onArm}
        className="chrome-dot"
        aria-label="Forget this memory"
        title="Forget this memory"
      >
        <TrashIcon />
      </button>
    );
  }

  // Confirmation pill — paper-style, sized to be reachable by the same
  // mouse that just clicked the trash icon. The destructive "Forget"
  // sits to the right so a quick double-click-through doesn't trigger
  // it; cancel (✕) is the default focus.
  const busy =
    phase === "probing" ||
    phase === "signing" ||
    phase === "confirming" ||
    phase === "indexing" ||
    phase === "ghost";

  const busyLabel =
    phase === "probing"
      ? "Checking…"
      : phase === "signing"
        ? "Sign in wallet…"
        : phase === "confirming"
          ? "Confirming on chain…"
          : phase === "ghost"
            ? "Already gone — clearing from index…"
            : "Forgetting…";

  return (
    <div
      role="group"
      aria-label="Forget this memory — confirm"
      className="flex h-9 items-center gap-1 rounded-full border border-[var(--color-edge)] bg-[var(--color-surface)] pl-3 pr-1 shadow-[0_1px_2px_rgba(20,20,20,.04)]"
    >
      <span
        className="text-[12px] tracking-tight text-[var(--color-ink)]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {busy ? busyLabel : "Forget forever?"}
      </span>
      {!busy && (
        <>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-mute)] transition hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 2L8 8M8 2L2 8"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.2"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={onConfirm}
            aria-label="Confirm — delete permanently"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-ink)] text-[var(--color-surface)] transition hover:opacity-90"
          >
            <TrashIcon />
          </button>
        </>
      )}
      {busy && (
        // Tiny breathing dot while the on-chain tx settles. Same
        // ".searching." voice we use elsewhere on the site.
        <span
          className="ml-1 mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-ink)]"
          aria-hidden
        />
      )}
      {errorMessage && (
        <span
          role="alert"
          className="mr-2 text-[10px] text-[var(--color-mute)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {errorMessage}
        </span>
      )}
    </div>
  );
}

export default function HomePage() {
  const { connected, account, signAndSubmitTransaction } = useWallet();
  const { session, status, signIn } = useSession();

  const myAddress = account?.address.toString().toLowerCase() ?? null;
  const hasSession =
    session !== null && (!myAddress || session.address === myAddress);

  // Same auto-SIWA pattern used on /feed: when the wallet is connected but
  // no matching session exists yet, prompt the user to sign in.
  useEffect(() => {
    if (
      status === "ready" &&
      connected &&
      myAddress &&
      (!session || session.address !== myAddress)
    ) {
      signIn();
    }
  }, [status, connected, myAddress, session, signIn]);

  const [posts, setPosts] = useState<VaultPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Selection + delete machinery. Both live here (not in Vault) so the
  // ChromeBar's right slot can render the contextual trash UI without
  // any prop drilling through Vault.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trashPhase, setTrashPhase] = useState<TrashPhase>("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Guard against double-fire if the user mashes the confirm button.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!hasSession || !session) {
      setPosts(null);
      return;
    }
    let aborted = false;
    setError(null);
    fetch(`/api/profiles/${session.address}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { posts: VaultPost[] };
        if (aborted) return;
        setPosts(j.posts ?? []);
      })
      .catch((e) => {
        if (aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      aborted = true;
    };
  }, [hasSession, session]);

  // Whenever the selection clears (Esc, Vault auto-clear after delete,
  // or our own onCancel), the trash UI must reset too — otherwise a
  // stale "confirm" pill could outlive its referent.
  useEffect(() => {
    if (selectedId === null) {
      setTrashPhase("idle");
      setDeleteError(null);
    }
  }, [selectedId]);

  async function runDelete() {
    if (inFlightRef.current) return;
    const post = posts?.find((p) => p.postId === selectedId);
    if (!post || !account) return;

    inFlightRef.current = true;
    setDeleteError(null);
    try {
      // ── Step 0: probe on-chain status ─────────────────────────────
      // Shelbynet has had state resets that drop blob_metadata while
      // the historical register_blob tx survives. If we naively ask
      // the wallet to sign delete_blob for a missing blob, the user
      // sees a wallet popup that then fails. Probing first lets us
      // pick the right path with zero confusion.
      setTrashPhase("probing");
      const alive = await probeBlobAlive(post.ownerAddress, post.blobName);

      if (alive) {
        // ── Normal path ─────────────────────────────────────────────
        setTrashPhase("signing");
        const payload = buildDeleteBlobPayload(post.blobName);
        const submitted = await signAndSubmitTransaction({ data: payload });

        setTrashPhase("confirming");
        await waitForAptosTx(submitted.hash);

        setTrashPhase("indexing");
        const r = await fetch("/api/posts", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            postId: post.postId,
            txHash: submitted.hash,
          }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(j?.error ?? `HTTP ${r.status}`);
        }
      } else {
        // ── Ghost path ──────────────────────────────────────────────
        // No wallet signing — the on-chain blob is already gone, so
        // there's nothing to authorise. The server re-verifies the
        // missingness itself before honouring `force: true`.
        setTrashPhase("ghost");
        const r = await fetch("/api/posts", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            postId: post.postId,
            force: true,
          }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(j?.error ?? `HTTP ${r.status}`);
        }
      }

      // Drop locally — Vault's own "selectedId no longer in posts"
      // effect will clear selection, which resets the trash UI.
      setPosts((prev) =>
        prev ? prev.filter((p) => p.postId !== post.postId) : prev,
      );
      // Note: trashPhase resets to "idle" inside the selectedId effect,
      // not here, so we don't flash "idle" for one frame before the
      // selection actually clears.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDeleteError(msg.slice(0, 80));
      // Stay armed so the user can retry or cancel — don't jump back
      // to "idle" and silently drop the error.
      setTrashPhase("confirm");
    } finally {
      inFlightRef.current = false;
    }
  }

  // The trash UI is now an overlay floating above the selected photo
  // (not in the chrome bar). The chrome's right slot always shows the
  // upload "+" — selection no longer steals it.
  const selectionOverlay =
    selectedId !== null ? (
      <TrashAction
        phase={trashPhase}
        onArm={() => setTrashPhase("confirm")}
        onCancel={() => {
          setSelectedId(null);
        }}
        onConfirm={runDelete}
        errorMessage={deleteError}
      />
    ) : null;

  // -------- Signed in: full Vault ----------------------------------------
  // The page no longer owns the chrome bar or the flex-col wrapper —
  // those live in ChromeShell (src/app/layout.tsx). The page just
  // contributes its right-slot action via <ChromeRightSlot> portal and
  // its main content.
  if (hasSession) {
    return (
      <>
        <ChromeRightSlot>
          <UploadPlus />
        </ChromeRightSlot>

        {posts === null && !error && (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-[var(--color-mute)]">
              Opening the album…
            </p>
          </div>
        )}
        {error && (
          <div className="mx-auto mt-12 max-w-sm rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] p-6 text-center text-sm text-[var(--color-mute)]">
            Couldn&apos;t open the vault: {error}
          </div>
        )}
        {posts !== null && !error && (
          <main className="flex min-h-0 flex-1 items-center">
            <Vault
              posts={posts}
              selectedId={selectedId}
              onSelect={setSelectedId}
              selectionOverlay={selectionOverlay}
              deleting={
                trashPhase === "probing" ||
                trashPhase === "signing" ||
                trashPhase === "confirming" ||
                trashPhase === "ghost" ||
                trashPhase === "indexing"
              }
            />
          </main>
        )}
      </>
    );
  }

  // -------- Signed out: quiet landing ------------------------------------
  // No ChromeRightSlot — the chrome's right slot stays empty on the
  // landing. Just provide the main + the bottom ruler.
  return (
    <>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-6 pb-20 text-center">
        <p
          className="mb-6 font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--color-mute)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          · An album that belongs to you ·
        </p>

        <h1
          style={{ fontFamily: "var(--font-display)" }}
          className="max-w-3xl text-5xl leading-[1.05] tracking-tight text-[var(--color-ink)] sm:text-7xl"
        >
          Memories,{" "}
          <span style={{ fontStyle: "italic" }}>kept</span>
          <br />
          on the chain.
        </h1>

        <p className="mt-8 max-w-md text-base leading-relaxed text-[var(--color-mute)]">
          A private photo journal stored on Shelby, signed by your Aptos
          wallet. Share what you want into the pool — keep the rest to
          yourself.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-6">
          <p className="text-sm text-[var(--color-ink)]">
            {connected
              ? status === "signing"
                ? "Sign the message in your wallet…"
                : "Sign in from the menu, top-left."
              : "Open the menu, top-left, to connect."}
          </p>
        </div>

        <div className="mt-16 flex items-center gap-6 text-xs text-[var(--color-mute)]">
          <Link href="/pool" className="hover:text-[var(--color-ink)]">
            Browse the public pool →
          </Link>
        </div>
      </main>

      {/* A whisper-thin ruler along the bottom so the landing visually rhymes
          with the Vault. */}
      <div className="ruler-draw mx-auto mb-10 w-full max-w-3xl px-6">
        <div className="ruler-h opacity-60" />
      </div>
    </>
  );
}
