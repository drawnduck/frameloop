"use client";

/**
 * Upload — paper-aesthetic, Instagram-style cropping flow.
 *
 *  Three stages, all on one page (no navigation between them):
 *    1. Drop zone — drag a file or click to pick. Image previews load
 *       into the cropper as soon as a file lands.
 *    2. Crop + form — square/portrait/landscape tabs over a drag-pan
 *       frame, zoom slider, plus the caption / visibility / tag form
 *       to the right (or below, on narrow viewports).
 *    3. Done — small confirmation panel with a link back to the vault.
 *
 *  At submit time the cropper renders its current viewport to a canvas
 *  and produces a re-encoded JPEG at canonical IG resolution; that file
 *  (not the original) is what gets hashed, registered on Aptos, and
 *  uploaded to Shelby. Two side effects of that choice:
 *    • The on-chain content hash matches the visible crop, so the
 *      indexing step never has to reconcile the source with what feeds
 *      and pools display.
 *    • Storage cost stays sensible — a 12-MP HEIC straight off a phone
 *      would otherwise dominate the bill for memories that are only
 *      ever displayed at 1080px.
 */

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChromeRightSlot } from "@/components/ChromeShell";
import { PhotoCropper, type CropperHandle } from "@/components/PhotoCropper";
import {
  buildRegisterBlobPayload,
  newBlobName,
  putBlobToShelby,
  waitForAptosTx,
} from "@/lib/shelby";
import { useSession } from "@/lib/useSession";

type Visibility = "PRIVATE" | "FOLLOWERS" | "PUBLIC";

/**
 * How long the blob stays on Shelby before it expires. The choice is
 * the user's at upload time — Frameloop pays for storage by
 * `size × duration`, so a passing thought costs less than something
 * meant to live a decade.
 *
 * NB: Shelby has no `extend_blob` op (yet). Picking "ephemeral" today
 * is final — when 30 days pass the blob is gone and we can't renew it.
 * The UI states that explicitly under the option.
 */
type Duration = "ephemeral" | "year" | "long";

/** TTL in microseconds for each duration tier. */
const DURATION_MICROS: Record<Duration, number> = {
  ephemeral: 30 * 24 * 60 * 60 * 1_000_000, // 30 days
  year: 365 * 24 * 60 * 60 * 1_000_000, // 1 year
  long: 10 * 365 * 24 * 60 * 60 * 1_000_000, // 10 years
};

const DURATION_OPTIONS: {
  value: Duration;
  label: string;
  hint: string;
}[] = [
  {
    value: "ephemeral",
    label: "Ephemeral",
    hint: "Disappears in 30 days. Can't be extended.",
  },
  {
    value: "year",
    label: "A year",
    hint: "Kept for one year.",
  },
  {
    value: "long",
    label: "Long-term",
    hint: "Stored for 10 years.",
  },
];

type UploadPhase =
  | "idle"
  | "cropping"
  | "reading"
  | "committing"
  | "signing"
  | "confirming"
  | "uploading"
  | "indexing"
  | "done"
  | "error";

type UploadResult = {
  blobName: string;
  ownerAddress: string;
  txHash: string;
  size: number;
};

const VISIBILITY_OPTIONS: {
  value: Visibility;
  label: string;
  hint: string;
}[] = [
  { value: "PRIVATE", label: "Private", hint: "Only you can see it." },
  {
    value: "FOLLOWERS",
    label: "Followers",
    hint: "Visible to people who follow you.",
  },
  {
    value: "PUBLIC",
    label: "Public pool",
    hint: "Shared with everyone, sorted by tag.",
  },
];

function BackHome() {
  return (
    <Link href="/" className="chrome-dot" aria-label="Cancel upload">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M2 2L10 10M10 2L2 10"
          stroke="currentColor"
          strokeLinecap="round"
        />
      </svg>
    </Link>
  );
}

export default function UploadPage() {
  const { connected, account, signAndSubmitTransaction } = useWallet();
  const { session, status, signIn, error: signInError } = useSession();

  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("PRIVATE");
  // Default to "long" — the archive case. The user can downgrade per
  // upload, but the safe choice is "keep it".
  const [duration, setDuration] = useState<Duration>("long");

  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState<{
    uploaded: number;
    total: number;
  } | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [dragOver, setDragOver] = useState(false);

  const cropperRef = useRef<CropperHandle | null>(null);

  const myAddress = account?.address.toString().toLowerCase() ?? null;

  // Auto-trigger SIWA: /api/posts requires a session matching ownerAddress,
  // so the cookie should be in place by the time the user reaches submit.
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

  const acceptFile = useCallback((f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("That doesn't look like an image.");
      setPhase("error");
      return;
    }
    setFile(f);
    setError(null);
    setResult(null);
    setProgress(null);
    setPhase("idle");
  }, []);

  // Whole-window drag handlers — the user can drop the file anywhere on
  // the page after the chrome bar, not just on the dashed zone. The
  // dashed zone still works as a click target / visible affordance.
  useEffect(() => {
    function onWindowDragOver(e: DragEvent) {
      if (file) return; // already have a file; ignore further drops
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      setDragOver(true);
    }
    function onWindowDrop(e: DragEvent) {
      if (file) return;
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) acceptFile(f);
    }
    function onWindowDragLeave(e: DragEvent) {
      // Only clear when the cursor actually leaves the window — single
      // dragleave events fire across child boundaries inside the page.
      if (e.relatedTarget === null) setDragOver(false);
    }
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    window.addEventListener("dragleave", onWindowDragLeave);
    return () => {
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", onWindowDrop);
      window.removeEventListener("dragleave", onWindowDragLeave);
    };
  }, [file, acceptFile]);

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    acceptFile(e.target.files?.[0]);
    // Reset the input so picking the same file again re-fires onChange.
    e.target.value = "";
  }

  function resetForNewFile() {
    setFile(null);
    setCaption("");
    setVisibility("PRIVATE");
    setDuration("long");
    setPhase("idle");
    setProgress(null);
    setResult(null);
    setError(null);
  }

  async function handleUpload() {
    if (!file || !account || !cropperRef.current) return;
    setError(null);
    setResult(null);
    try {
      setPhase("cropping");
      const cropped = await cropperRef.current.getCroppedFile();

      setPhase("reading");
      const buf = new Uint8Array(await cropped.arrayBuffer());
      const contentHash = await sha256Hex(buf);

      setPhase("committing");
      const ownerAddress = account.address.toString().toLowerCase();
      const blobName = newBlobName("posts");
      // User-chosen TTL. Anchored to "now" at submit time so a user who
      // sat on the form for a while still gets the full duration they
      // selected, not a duration relative to when they opened the page.
      const expirationMicros =
        Date.now() * 1000 + DURATION_MICROS[duration];
      const { payload } = await buildRegisterBlobPayload({
        ownerAddress,
        blobName,
        blobData: buf,
        expirationMicros,
      });

      setPhase("signing");
      const submitted = await signAndSubmitTransaction({ data: payload });

      setPhase("confirming");
      await waitForAptosTx(submitted.hash);

      setPhase("uploading");
      setProgress({ uploaded: 0, total: buf.length });
      await putBlobToShelby({
        ownerAddress,
        blobName,
        blobData: buf,
        onProgress: (p) =>
          setProgress({ uploaded: p.uploadedBytes, total: p.totalBytes }),
      });

      setPhase("indexing");
      // NB: `tag` is intentionally not collected on the upload form
      // anymore — pool sorting will be reworked separately. The API
      // accepts a missing tag and stores null for PUBLIC posts.
      const postBody = {
        ownerAddress,
        blobName,
        contentHash,
        size: buf.length,
        visibility,
        caption: caption.trim() || undefined,
        txHash: submitted.hash,
        expirationMicros: expirationMicros.toString(),
      };
      let indexResp = await fetch("/api/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(postBody),
      });
      // Retry once if the cookie wasn't in place yet — happens when the
      // user lands on /upload via a deep link.
      if (indexResp.status === 401) {
        const signed = await signIn();
        if (signed) {
          indexResp = await fetch("/api/posts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(postBody),
          });
        }
      }
      if (!indexResp.ok) {
        const body = await indexResp.text();
        throw new Error(`Index failed: ${indexResp.status} ${body}`);
      }

      setResult({
        blobName,
        ownerAddress,
        txHash: submitted.hash,
        size: buf.length,
      });
      setPhase("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(friendlyError(msg));
      setPhase("error");
    }
  }

  const busy = phaseInFlight(phase);

  return (
    // Chrome + h-screen wrapper supplied by ChromeShell. main is
    // internally scrollable for the rare cropper-phase that exceeds
    // viewport height.
    <>
      <ChromeRightSlot>
        <BackHome />
      </ChromeRightSlot>

      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-y-auto px-6 pb-12 sm:px-10">
        {!connected || !account ? (
          // ── Not connected: nudge to the menu ─────────────────────────
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="text-sm text-[var(--color-mute)]">
              Connect a wallet from the menu, top-left, to upload a memory.
            </p>
          </div>
        ) : phase === "done" && result ? (
          // ── Done ─────────────────────────────────────────────────────
          // DonePanel doesn't need `result` any more — we used to show
          // the blob name + tx hash there, but cut them to keep the
          // confirmation calm. `result` is still kept in state so the
          // outer condition can decide when to show DonePanel at all.
          <DonePanel onAgain={resetForNewFile} />
        ) : !file ? (
          // ── Drop zone (no file yet) ──────────────────────────────────
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center pt-6">
            <p
              style={{ fontFamily: "var(--font-display)" }}
              className="mb-2 text-3xl italic tracking-tight text-[var(--color-ink)]"
            >
              A new memory.
            </p>
            <p className="mb-8 text-sm text-[var(--color-mute)]">
              Drop a photo, or pick one from your device.
            </p>

            <label
              htmlFor="file"
              className={`paper-drop${dragOver ? " is-dragging" : ""}`}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 32 32"
                fill="none"
                aria-hidden
              >
                <path
                  d="M16 22V8M16 8L10 14M16 8L22 14M6 24H26"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span
                style={{ fontFamily: "var(--font-display)" }}
                className="text-lg italic"
              >
                {dragOver ? "Release to add" : "Drop a photo"}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.25em]">
                or click to choose
              </span>
              <input
                id="file"
                type="file"
                accept="image/*"
                onChange={onFileInput}
                className="hidden"
              />
            </label>

            {phase === "error" && error && (
              <p className="mt-6 text-center text-sm text-[var(--color-ink)]">
                {error}
              </p>
            )}
          </div>
        ) : (
          // ── Crop + form ──────────────────────────────────────────────
          <div className="grid flex-1 grid-cols-1 gap-10 pt-2 lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
            {/* Cropper column. Container width controls frame width via
                the cropper's ResizeObserver. */}
            <div className="flex flex-col">
              <PhotoCropper ref={cropperRef} file={file} />

              <button
                type="button"
                onClick={resetForNewFile}
                disabled={busy}
                className="mt-4 self-center font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--color-mute)] transition hover:text-[var(--color-ink)] disabled:opacity-40"
              >
                · choose a different photo ·
              </button>
            </div>

            {/* Form column. */}
            <div className="flex flex-col">
              <label
                htmlFor="caption"
                className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--color-mute)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                Caption
              </label>
              <textarea
                id="caption"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                maxLength={280}
                rows={2}
                placeholder="What is this memory?"
                className="paper-input"
                disabled={busy}
              />

              <p
                className="mt-8 mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--color-mute)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                Visibility
              </p>
              <div>
                {VISIBILITY_OPTIONS.map((opt) => {
                  const active = visibility === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className={`paper-radio${active ? " is-active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="visibility"
                        value={opt.value}
                        checked={active}
                        onChange={() => setVisibility(opt.value)}
                        className="sr-only"
                        disabled={busy}
                      />
                      <span className="paper-radio__dot" aria-hidden />
                      <span className="flex flex-col">
                        <span
                          className="text-sm text-[var(--color-ink)]"
                          style={{ fontFamily: "var(--font-display)" }}
                        >
                          {opt.label}
                        </span>
                        <span className="text-xs text-[var(--color-mute)]">
                          {opt.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {/* KEEP FOR — storage duration. Sits between Visibility
                  and the Save action because it's the same kind of
                  decision: a property of the memory the user is about
                  to commit, not a transient form preference. */}
              <p
                className="mt-8 mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--color-mute)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                Keep for
              </p>
              <div>
                {DURATION_OPTIONS.map((opt) => {
                  const active = duration === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className={`paper-radio${active ? " is-active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="duration"
                        value={opt.value}
                        checked={active}
                        onChange={() => setDuration(opt.value)}
                        className="sr-only"
                        disabled={busy}
                      />
                      <span className="paper-radio__dot" aria-hidden />
                      <span className="flex flex-col">
                        <span
                          className="text-sm text-[var(--color-ink)]"
                          style={{ fontFamily: "var(--font-display)" }}
                        >
                          {opt.label}
                        </span>
                        <span className="text-xs text-[var(--color-mute)]">
                          {opt.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {status === "signing" && (
                <p className="mt-6 text-xs text-[var(--color-mute)]">
                  Sign the message in your wallet to authorize uploads…
                </p>
              )}

              {signInError && (
                <div className="mt-6 flex items-center justify-between gap-3 border-l-2 border-[var(--color-ink)] pl-3 text-xs text-[var(--color-ink)]">
                  <span>Sign-in needed: {signInError}</span>
                  <button
                    type="button"
                    onClick={() => signIn()}
                    className="font-mono text-[10px] uppercase tracking-[0.2em] underline underline-offset-2"
                  >
                    Retry
                  </button>
                </div>
              )}

              <div className="mt-10 flex flex-col items-stretch gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleUpload}
                  className="paper-button"
                >
                  {buttonLabel(phase, progress)}
                </button>

                {phase === "error" && error && (
                  <p className="text-center text-xs text-[var(--color-ink)]">
                    {error}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────

function DonePanel({ onAgain }: { onAgain: () => void }) {
  // Intentionally minimal: just the confirmation line + two ways
  // forward. We used to render BLOB / TX hash rows here for the
  // "look at all this on-chain plumbing!" feeling, but in practice
  // those long mono strings were just noise — the user has just
  // signed a transaction, they know it happened. If they need the
  // tx hash later they can pull it from the post's Vault card.
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center text-center">
      <p
        style={{ fontFamily: "var(--font-display)" }}
        className="text-4xl italic tracking-tight text-[var(--color-ink)]"
      >
        Saved.
      </p>
      <p className="mt-3 max-w-sm text-sm text-[var(--color-mute)]">
        Your memory is registered on Aptos and stored on Shelby.
      </p>

      <div className="mt-10 flex items-center gap-6">
        <Link
          href="/"
          className="paper-button"
          style={{ textDecoration: "none" }}
        >
          Back to the album
        </Link>
        <button
          type="button"
          onClick={onAgain}
          className="font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--color-mute)] transition hover:text-[var(--color-ink)]"
        >
          Upload another
        </button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

async function sha256Hex(data: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function phaseInFlight(p: UploadPhase) {
  return p !== "idle" && p !== "done" && p !== "error";
}

function buttonLabel(
  p: UploadPhase,
  progress: { uploaded: number; total: number } | null,
) {
  switch (p) {
    case "cropping":
      return "Cropping…";
    case "reading":
      return "Reading file…";
    case "committing":
      return "Hashing locally…";
    case "signing":
      return "Sign in your wallet…";
    case "confirming":
      return "Confirming on Aptos…";
    case "uploading":
      return progress
        ? `Uploading… ${Math.round((progress.uploaded / progress.total) * 100)}%`
        : "Uploading…";
    case "indexing":
      return "Saving…";
    default:
      return "Save memory";
  }
}

function friendlyError(msg: string) {
  if (msg.includes("EBLOB_WRITE_CHUNKSET_ALREADY_EXISTS")) {
    return "This exact file is already uploaded under that name.";
  }
  if (msg.includes("INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE")) {
    return "Not enough APT in your wallet to pay gas. Use the Aptos faucet for Shelbynet.";
  }
  if (msg.includes("EBLOB_WRITE_INSUFFICIENT_FUNDS")) {
    return "Not enough ShelbyUSD to pay for storage. Use the ShelbyUSD faucet.";
  }
  if (msg.includes("User has rejected") || msg.includes("rejected")) {
    return "You cancelled the signature in your wallet.";
  }
  if (msg.includes("Index failed: 401")) {
    return "Sign in to your wallet first (the popup may have been dismissed).";
  }
  if (msg.includes("forbidden_owner_mismatch")) {
    return "Your wallet doesn't match the signed-in session. Reconnect the wallet you signed in with.";
  }
  if (msg.includes("tx_verification_failed")) {
    return "The Aptos network couldn't confirm your register_blob transaction. Try again in a moment.";
  }
  if (msg.includes("429")) {
    return "Rate limited by the Shelby RPC. Wait a moment and retry.";
  }
  return msg;
}
