"use client";

/**
 * ProfileEditModal — paper-aesthetic profile editor.
 *
 *   ┌─────────────────────────────────────────────┐
 *   │  Edit profile                               │
 *   │  How you appear to others.                  │
 *   │                                             │
 *   │  ╭──────╮                                   │
 *   │  │  ◯   │   Click the circle to pick a new  │
 *   │  ╰──────╯   image. Max 2 MB.                │
 *   │                                             │
 *   │  NAME                                       │
 *   │  ─────────────────────────                  │
 *   │  Anna                                       │
 *   │                                             │
 *   │  ─────────────────────────                  │
 *   │              Close          Save name       │
 *   └─────────────────────────────────────────────┘
 *
 * Two independent save paths inside one modal:
 *
 *   • Display name → simple PATCH /api/me { displayName }
 *   • Avatar       → the full Shelby pipeline (build → sign →
 *                    confirm → upload → PATCH /api/me { avatarBlobName }),
 *                    mirrored from the old /me page so the on-chain
 *                    semantics are unchanged.
 *
 * The two are deliberately not bundled into one "Save" button — they
 * involve very different commitments (a free DB update vs. an on-chain
 * signature + Shelby upload), and a user editing their name shouldn't
 * have to sign a transaction.
 *
 * Rendered via createPortal into <body> so it can never be clipped or
 * intercepted by anything in the page tree — same defensive pattern
 * used by the wallet dropdown next door (see ChromeBar.tsx).
 */

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AvatarImage } from "@/components/AvatarImage";
import {
  buildRegisterBlobPayload,
  defaultExpirationMicros,
  newBlobName,
  putBlobToShelby,
  waitForAptosTx,
} from "@/lib/shelby";
import { useSession } from "@/lib/useSession";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

type AvatarPhase =
  | "idle"
  | "committing"
  | "signing"
  | "confirming"
  | "uploading"
  | "saving";

type Props = {
  open: boolean;
  onClose: () => void;
  /**
   * Fired after a successful save (name or avatar). The host typically
   * uses this to re-fetch the avatar shown in the chrome bar so it
   * updates without a page reload.
   */
  onSaved?: () => void;
};

function blobUrl(address: string, blobName: string) {
  const parts = blobName.split("/").map(encodeURIComponent).join("/");
  return `/api/blob/${address}/${parts}`;
}

export function ProfileEditModal({ open, onClose, onSaved }: Props) {
  const { account, signAndSubmitTransaction } = useWallet();
  const { signIn } = useSession();
  const address = account?.address.toString().toLowerCase() ?? null;

  // Loaded profile state (what the server thinks the profile is right
  // now). Used to seed drafts and to disable the Save button when the
  // user hasn't actually changed anything.
  const [currentName, setCurrentName] = useState<string>("");
  const [currentAvatarBlob, setCurrentAvatarBlob] = useState<string | null>(
    null,
  );

  // Draft name input.
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Avatar pick + upload state.
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarPhase, setAvatarPhase] = useState<AvatarPhase>("idle");
  const [avatarError, setAvatarError] = useState<string | null>(null);
  // Resume state for the rare Shelby-side 500.
  //
  // The avatar pipeline has two distinct halves:
  //   1. on-chain  (committing → signing → confirming): we ask the wallet
  //      to register a brand-new blob_name with merkle commitments. THIS
  //      COSTS A SIGNATURE and the user just paid for it.
  //   2. off-chain (uploading → saving): we push the bytes to Shelby's
  //      RPC node and tell our own DB about the new avatar.
  //
  // The Shelby `complete-multipart` endpoint sometimes returns a 500 on
  // Shelbynet — a known operational hiccup, not anything wrong with the
  // user's blob. When that happens the on-chain register_blob is already
  // confirmed: the blob_name is reserved, the merkle root is committed,
  // the upload just didn't complete server-side. We DO NOT want the user
  // to sign a fresh register_blob — that would burn a second signature
  // and create a second, unused blob_name. Instead we keep the already-
  // approved (blobName, buf) pair around and offer a "Retry upload"
  // button that skips straight to the off-chain half.
  //
  // approvedRef is non-null only after step 1 finishes. Cleared after a
  // successful upload, after the user discards the pick, or after they
  // pick a different file. While it's set, the Approve button is
  // replaced with a Retry button.
  const approvedRef = useRef<{
    blobName: string;
    buf: Uint8Array;
  } | null>(null);
  // Mirror approvedRef.current in state purely so the JSX re-renders
  // when it changes (refs alone don't trigger re-renders).
  const [hasApproved, setHasApproved] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  // Load the current profile when the modal opens. Re-fetching every
  // open (rather than caching across opens) keeps the modal in sync if
  // the user changed things in another tab.
  useEffect(() => {
    if (!open || !address) return;
    let aborted = false;
    fetch(`/api/profiles/${encodeURIComponent(address)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          j:
            | {
                profile?: {
                  displayName?: string | null;
                  avatarBlobName?: string | null;
                };
              }
            | null,
        ) => {
          if (aborted) return;
          const name = j?.profile?.displayName ?? "";
          setCurrentName(name);
          setDraftName(name);
          setCurrentAvatarBlob(j?.profile?.avatarBlobName ?? null);
        },
      )
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, [open, address]);

  // Esc closes — but only when no on-chain work is in flight. We don't
  // want a stray keystroke to dismiss the modal while a Shelby upload
  // is mid-stream.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && avatarPhase === "idle" && !savingName) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, avatarPhase, savingName]);

  // When the preview blob URL changes, revoke the old one. Object URLs
  // pin a copy of the file in memory until revoked.
  useEffect(() => {
    return () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    };
  }, [avatarPreview]);

  if (!open || typeof document === "undefined") return null;

  function pickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setAvatarError(null);
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    if (f && f.size > MAX_AVATAR_BYTES) {
      setAvatarError("Avatar must be 2 MB or smaller.");
      setAvatarFile(null);
      setAvatarPreview(null);
      return;
    }
    setAvatarFile(f);
    setAvatarPreview(f ? URL.createObjectURL(f) : null);
    // Picking a different file invalidates any previously-approved blob
    // — the on-chain commitments don't match the new bytes, so we
    // must restart from scratch.
    approvedRef.current = null;
    setHasApproved(false);
    // Reset the input's value so picking the same file twice in a row
    // still fires onChange (browsers suppress the change event when the
    // chosen file is identical to the previous one).
    if (e.target) e.target.value = "";
  }

  function discardAvatarPick() {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(null);
    setAvatarFile(null);
    setAvatarError(null);
    approvedRef.current = null;
    setHasApproved(false);
  }

  /**
   * Take an already-uploaded blobName and persist it as the user's
   * avatar via PATCH /api/me. Pulled out of saveAvatar so the retry
   * path can call it directly without re-uploading.
   */
  async function persistAvatarBlob(blobName: string) {
    let r = await fetch("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatarBlobName: blobName }),
    });
    // Same 401 → sign in → retry dance as the post upload — covers
    // the case where the SIWA session expired mid-flow.
    if (r.status === 401) {
      const signed = await signIn();
      if (signed) {
        r = await fetch("/api/me", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ avatarBlobName: blobName }),
        });
      }
    }
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
  }

  /**
   * Turn Shelby/SDK errors into one-line copy the user can act on.
   *
   * The SDK's verbose "Failed to complete multipart upload! status:
   * 500, body: {...}" is technically informative but reads as a system
   * crash dump. We translate the well-known ones; everything else gets
   * trimmed to 120 chars so the modal doesn't break out of its box.
   */
  function friendlyShelbyError(raw: string, registered: boolean): string {
    if (raw.includes("rejected") || raw.includes("User has rejected")) {
      return "You cancelled the signature in your wallet.";
    }
    if (raw.includes("multipart upload") && raw.includes("500")) {
      return registered
        ? "Shelby couldn't store the avatar (server hiccup). Your on-chain approval is already done — tap Retry upload, no new signature needed."
        : "Shelby couldn't store the avatar (server hiccup). Try again in a moment.";
    }
    if (raw.includes("Failed to start multipart upload")) {
      return "Shelby is refusing new uploads right now. Try again in a moment.";
    }
    if (raw.includes("Failed to upload part")) {
      return registered
        ? "Connection to Shelby dropped mid-upload. Tap Retry upload to resume — no new signature needed."
        : "Connection to Shelby dropped. Try again in a moment.";
    }
    return raw.slice(0, 120);
  }

  /**
   * Full pipeline: on-chain register_blob (wallet signature) → upload
   * bytes to Shelby → PATCH /api/me. Used when the user first clicks
   * Approve. If anything past the wallet signature breaks, the
   * approved (blobName, buf) is parked in approvedRef so the user can
   * retry the upload half without another signature — see saveAvatar
   * retry path below.
   */
  async function saveAvatar() {
    if (!avatarFile || !account || !address) return;
    setAvatarError(null);

    // ── On-chain half ─────────────────────────────────────────────
    // We only run this when there's no already-approved blob waiting
    // for an upload retry. The retry button calls this same function
    // but skips straight to the off-chain half via the approvedRef
    // short-circuit above.
    let blobName: string;
    let buf: Uint8Array;
    if (approvedRef.current) {
      // Retry path — bytes and blob name are already approved on-chain.
      blobName = approvedRef.current.blobName;
      buf = approvedRef.current.buf;
    } else {
      try {
        buf = new Uint8Array(await avatarFile.arrayBuffer());

        setAvatarPhase("committing");
        blobName = newBlobName("avatars");
        const expirationMicros = defaultExpirationMicros();
        const { payload } = await buildRegisterBlobPayload({
          ownerAddress: address,
          blobName,
          blobData: buf,
          expirationMicros,
        });

        setAvatarPhase("signing");
        const submitted = await signAndSubmitTransaction({ data: payload });

        setAvatarPhase("confirming");
        await waitForAptosTx(submitted.hash);

        // On-chain half done — park the approved pair so any future
        // failure surfaces a "retry, no signature" button instead of
        // making the user re-sign.
        approvedRef.current = { blobName, buf };
        setHasApproved(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setAvatarError(friendlyShelbyError(msg, false));
        setAvatarPhase("idle");
        return;
      }
    }

    // ── Off-chain half ────────────────────────────────────────────
    // Same code path whether we just signed or we're retrying after a
    // previous Shelby 500. Wrapped in its own try/catch so on-chain
    // failures (above) don't get the friendlier "no signature needed"
    // hint that only makes sense once the signature is already in.
    try {
      setAvatarPhase("uploading");
      await putBlobToShelby({
        ownerAddress: address,
        blobName,
        blobData: buf,
      });

      setAvatarPhase("saving");
      await persistAvatarBlob(blobName);

      // Success — clean up the picker state, clear the approved pair,
      // and reflect the new avatar as "current".
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
      setAvatarPreview(null);
      setAvatarFile(null);
      approvedRef.current = null;
      setHasApproved(false);
      setCurrentAvatarBlob(blobName);
      setAvatarPhase("idle");
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAvatarError(friendlyShelbyError(msg, true));
      setAvatarPhase("idle");
      // Leave approvedRef.current intact so the retry button stays
      // available. The user's signature is not lost.
    }
  }

  async function saveName() {
    const trimmed = draftName.trim();
    if (trimmed === currentName.trim()) return;
    setSavingName(true);
    setNameError(null);
    try {
      let r = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: trimmed }),
      });
      if (r.status === 401) {
        const signed = await signIn();
        if (signed) {
          r = await fetch("/api/me", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ displayName: trimmed }),
          });
        }
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setCurrentName(trimmed);
      setDraftName(trimmed);
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNameError(msg.slice(0, 120));
    } finally {
      setSavingName(false);
    }
  }

  const busyUpload = avatarPhase !== "idle";
  const nameChanged = draftName.trim() !== currentName.trim();
  const nameValid = draftName.trim().length > 0 && draftName.trim().length <= 50;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-edit-title"
      className="fixed inset-0 z-[1100] flex items-center justify-center"
    >
      {/* Backdrop — soft veil + click-to-close. We use a button so it
          carries semantics for screen readers; disabled while an
          on-chain step is in flight so the user can't accidentally
          dismiss mid-upload. */}
      <button
        type="button"
        aria-label="Close"
        onClick={busyUpload || savingName ? undefined : onClose}
        className="absolute inset-0 bg-[rgba(20,20,20,0.22)] backdrop-blur-[2px] transition"
      />

      {/* Card */}
      <div className="relative mx-6 w-full max-w-md animate-[paper-rise_280ms_var(--ease-paper)_both] rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] shadow-[0_1px_2px_rgba(0,0,0,.04),0_24px_60px_-12px_rgba(0,0,0,.2)]">
        <div className="px-8 pt-8 pb-6">
          <h2
            id="profile-edit-title"
            style={{ fontFamily: "var(--font-display)" }}
            className="text-2xl tracking-tight text-[var(--color-ink)]"
          >
            Edit profile
          </h2>
          <p className="mt-1 text-xs text-[var(--color-mute)]">
            How you appear to others.
          </p>

          {/* AVATAR — click the circle to pick a new image. Preview
              shows in-place; commit happens on the "Upload" pill which
              only appears once a file is staged. */}
          <div className="mt-6 flex items-start gap-5">
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              disabled={busyUpload}
              className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-[var(--color-whisper)] ring-1 ring-[var(--color-edge)] transition hover:ring-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Change avatar"
            >
              {avatarPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarPreview}
                  alt="Preview"
                  className="h-full w-full object-cover"
                />
              ) : (
                <AvatarImage
                  src={
                    currentAvatarBlob && address
                      ? blobUrl(address, currentAvatarBlob)
                      : null
                  }
                  className="h-full w-full object-cover"
                  fallback={
                    <span
                      className="flex h-full w-full items-center justify-center text-xs text-[var(--color-mute)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {address?.slice(2, 4).toUpperCase()}
                    </span>
                  }
                />
              )}
              {!busyUpload && (
                <span className="absolute inset-0 hidden items-center justify-center bg-[rgba(20,20,20,0.55)] text-[10px] uppercase tracking-wider text-[var(--color-paper)] group-hover:flex">
                  Change
                </span>
              )}
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                onChange={pickAvatar}
                className="hidden"
              />
            </button>

            <div className="min-w-0 flex-1 pt-1">
              {avatarFile ? (
                <>
                  <p className="text-xs text-[var(--color-mute)]">
                    {busyUpload
                      ? avatarPhaseLabel(avatarPhase)
                      : hasApproved
                        ? "Approved on-chain. Just need to push the bytes to Shelby."
                        : "Ready. Saving an avatar requires a wallet signature."}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={saveAvatar}
                      disabled={busyUpload}
                      className="inline-flex h-8 items-center rounded-full bg-[var(--color-ink)] px-4 text-[11px] uppercase tracking-[0.15em] text-[var(--color-paper)] transition hover:opacity-90 disabled:opacity-50"
                    >
                      {busyUpload ? "…" : hasApproved ? "Retry upload" : "Approve"}
                    </button>
                    <button
                      type="button"
                      onClick={discardAvatarPick}
                      disabled={busyUpload}
                      className="text-[11px] uppercase tracking-[0.15em] text-[var(--color-mute)] transition hover:text-[var(--color-ink)] disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs leading-relaxed text-[var(--color-mute)]">
                  Click the circle to pick a new image.
                  <br />
                  Max 2&nbsp;MB. Square crops best.
                </p>
              )}
              {avatarError && (
                <p
                  className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink)]"
                  role="alert"
                >
                  {avatarError}
                </p>
              )}
            </div>
          </div>

          {/* NAME — paper-input underline style. Saved by its own
              dedicated button at the bottom of the card so the user
              can edit the name without affecting the avatar pick. */}
          <div className="mt-8">
            <label
              htmlFor="profile-edit-name"
              className="block text-[10px] uppercase tracking-[0.22em] text-[var(--color-mute)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Name
            </label>
            <input
              id="profile-edit-name"
              type="text"
              maxLength={50}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="What to call you"
              className="paper-input mt-1"
              disabled={savingName}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  nameChanged &&
                  nameValid &&
                  !savingName
                ) {
                  e.preventDefault();
                  saveName();
                }
              }}
            />
            {nameError && (
              <p
                className="mt-1 text-[11px] text-[var(--color-ink)]"
                style={{ fontFamily: "var(--font-mono)" }}
                role="alert"
              >
                {nameError}
              </p>
            )}
          </div>
        </div>

        {/* Footer — close (always allowed unless we're mid-signature)
            on the left, Save name on the right. */}
        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-edge)] px-8 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busyUpload || savingName}
            className="text-sm text-[var(--color-mute)] transition hover:text-[var(--color-ink)] disabled:opacity-40"
          >
            Close
          </button>
          <button
            type="button"
            onClick={saveName}
            disabled={
              savingName || busyUpload || !nameChanged || !nameValid
            }
            className="inline-flex items-center rounded-full bg-[var(--color-ink)] px-5 py-2 text-sm text-[var(--color-paper)] transition hover:opacity-90 disabled:opacity-40"
          >
            {savingName ? "Saving…" : "Save name"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function avatarPhaseLabel(p: AvatarPhase): string {
  switch (p) {
    case "committing":
      return "Hashing locally…";
    case "signing":
      return "Sign in your wallet…";
    case "confirming":
      return "Confirming on Aptos…";
    case "uploading":
      return "Uploading to Shelby…";
    case "saving":
      return "Saving profile…";
    default:
      return "";
  }
}
