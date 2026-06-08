"use client";

/**
 * PoolStack — the tactile centrepiece of /pool.
 *
 * A literal stack of photo cards lying face-up on the paper. The top card
 * is the active one: you can drag it sideways or click anywhere on it to
 * send it flying off-screen. When it leaves, the card beneath rotates into
 * place, scales up to "active" size, and a new card is added to the bottom
 * of the deck so the stack never feels emptier than five-or-so.
 *
 * Random gentle rotations are seeded by the post id so each card keeps the
 * same angle across re-renders — otherwise the deck would jitter every
 * time React updated.
 *
 * The owner attribution chip stays tucked under the active card; it travels
 * with whichever card is on top.
 */

import { AnimatePresence, motion, type PanInfo } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type PoolCard = {
  postId: string;
  ownerAddress: string;
  blobName: string;
  caption: string | null;
};

export type PoolOwner = {
  address: string;
  displayName: string | null;
  ansName: string | null;
  avatarBlobName: string | null;
};

type Props = {
  initial: PoolCard[];
  owners: Record<string, PoolOwner>;
};

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function blobUrl(address: string, blobName: string) {
  const parts = blobName.split("/").map(encodeURIComponent).join("/");
  return `/api/blob/${address}/${parts}`;
}

// Cheap deterministic angle in [-8°, +8°] from a post id. No need for a real
// PRNG; we just want stable randomness across renders.
function seededAngle(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return ((h % 1000) / 1000) * 16 - 8;
}

// Three Instagram-style aspect buckets. We snap every photo into one of
// these on load — anything close to square becomes a square, otherwise we
// pick portrait (4:5) or landscape (1.91:1). The deck reads as a tactile
// mix of formats rather than a uniform grid.
type Aspect = "portrait" | "square" | "landscape";

const ASPECT_DIMS: Record<Aspect, { width: string; aspectRatio: string }> = {
  // Cards size themselves; the stack container only provides a positioning
  // origin. Widths clamp on small viewports so even a landscape card
  // doesn't blow past 90vw on a phone. Caps tuned to fit one viewport on
  // a 14" MacBook Pro at 100% zoom — portrait (tallest) maxes at 450px so
  // header + stack + breathing room comes in under 945vh.
  portrait: { width: "min(68vw, 360px)", aspectRatio: "4 / 5" },
  square: { width: "min(68vw, 420px)", aspectRatio: "1 / 1" },
  landscape: { width: "min(86vw, 520px)", aspectRatio: "1.91 / 1" },
};

function classifyAspect(w: number, h: number): Aspect {
  if (w === 0 || h === 0) return "square";
  const r = w / h;
  if (r >= 1.15) return "landscape";
  if (r <= 0.95) return "portrait";
  return "square";
}

const VISIBLE = 5; // how many cards from the top are rendered at once
const REFILL_AT = 4; // when the deck dips this low, fetch another batch

export function PoolStack({ initial, owners: initialOwners }: Props) {
  const [deck, setDeck] = useState<PoolCard[]>(initial);
  const [owners, setOwners] = useState<Record<string, PoolOwner>>(initialOwners);
  // Aspect bucket per postId, populated on <img onLoad>. While loading, a
  // card defaults to "square" — the CSS transition on width/aspect-ratio
  // smooths the snap into the real bucket once the natural dimensions
  // arrive.
  const [aspects, setAspects] = useState<Record<string, Aspect>>({});
  const fetchingRef = useRef(false);

  // Refill the deck from /api/pool/random whenever it gets short. The merge
  // is done with a set on postId so we never accidentally show the same card
  // twice when the API happens to return one we already had.
  const refill = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const r = await fetch("/api/pool/random?limit=20", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as {
        posts: PoolCard[];
        owners: Record<string, PoolOwner>;
      };
      setDeck((prev) => {
        const seen = new Set(prev.map((p) => p.postId));
        const fresh = j.posts.filter((p) => !seen.has(p.postId));
        return [...prev, ...fresh];
      });
      setOwners((prev) => ({ ...prev, ...j.owners }));
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (deck.length <= REFILL_AT) refill();
  }, [deck.length, refill]);

  // Pop the top card with a chosen fly-off direction. Called by drag-release
  // and click.
  const popTop = useCallback((direction: 1 | -1) => {
    setDeck((prev) => prev.slice(1));
    return direction;
  }, []);

  // The active card needs an "exit direction" stored *outside* AnimatePresence
  // so the framer exit variant can read it. We stash it in a ref keyed by id.
  const exitDirRef = useRef<Record<string, 1 | -1>>({});

  const onDragEnd = (id: string, _e: unknown, info: PanInfo) => {
    const threshold = 80;
    if (Math.abs(info.offset.x) > threshold || Math.abs(info.velocity.x) > 400) {
      exitDirRef.current[id] = info.offset.x > 0 ? 1 : -1;
      popTop(exitDirRef.current[id]);
    }
  };

  const onClickCard = (id: string) => {
    // Alternate left/right on click so the same card doesn't always fly the
    // same way. Mild personality, no real signal.
    const dir: 1 | -1 = Math.random() > 0.5 ? 1 : -1;
    exitDirRef.current[id] = dir;
    popTop(dir);
  };

  // Top card → bottom card. We reverse so the topmost is painted last (it
  // sits visually on top because of source order + z-index).
  const visible = useMemo(() => deck.slice(0, VISIBLE), [deck]);

  if (visible.length === 0) {
    return (
      <div className="flex h-full min-h-[60vh] flex-col items-center justify-center text-center">
        <p
          style={{ fontFamily: "var(--font-display)" }}
          className="text-3xl text-[var(--color-ink)]"
        >
          The pool is empty.
        </p>
        <p className="mt-3 text-sm text-[var(--color-mute)]">
          Be the first to share something public.
        </p>
      </div>
    );
  }

  const top = visible[0];
  const topOwner = owners[top.ownerAddress];
  const topOwnerName =
    topOwner?.displayName ?? topOwner?.ansName ?? truncate(top.ownerAddress);

  return (
    <div className="relative flex flex-col items-center">
      {/* The stack itself. Sized to comfortably hold the largest of the    */}
      {/* three aspect buckets in either dimension (landscape is widest,    */}
      {/* portrait is tallest), so cards never get clipped as they tilt.    */}
      <div className="relative h-[min(68vh,470px)] min-h-[340px] w-[min(88vw,560px)]">
        <AnimatePresence initial={false}>
          {visible.map((card, depth) => {
            const isTop = depth === 0;
            const baseAngle = seededAngle(card.postId);
            // Steep opacity falloff: only the top card reads as fully alive.
            // Under-cards are deliberately faint so that when one is promoted
            // to the top — its opacity climbing from ~0.45 to 1.0 over the
            // slow 0.9s transition — the "rising out of the fade" reads as a
            // real reveal, not a subtle tint change. Painting order is
            // handled by zIndex below, so we can keep the source order
            // natural (top first) without a reverse().
            const yOffset = depth * 8;
            const rotation = baseAngle * (1 - depth * 0.2);
            const scale = 1 - depth * 0.04;
            const opacity =
              depth === 0 ? 1 : Math.max(0.08, 0.55 - depth * 0.2);
            const exitDir = exitDirRef.current[card.postId] ?? 1;
            // Each card takes the size of its own aspect bucket. Defaults
            // to "square" until the image's natural dimensions land and we
            // re-classify it; the CSS transition below smooths that snap.
            const aspect = aspects[card.postId] ?? "square";
            const dims = ASPECT_DIMS[aspect];

            return (
              <motion.div
                key={card.postId}
                className="absolute left-1/2 top-1/2"
                style={{
                  width: dims.width,
                  aspectRatio: dims.aspectRatio,
                  transformOrigin: "50% 60%",
                  cursor: isTop ? "grab" : "default",
                  // Higher z-index for shallower cards — the topmost paints
                  // above all others regardless of DOM order.
                  zIndex: VISIBLE - depth,
                  // CSS-driven (not Motion-driven) transition between aspect
                  // buckets — Motion handles transforms/opacity, CSS handles
                  // the dimensional snap so the two don't fight.
                  transition:
                    "width 450ms var(--ease-paper), aspect-ratio 450ms var(--ease-paper)",
                }}
                initial={{
                  x: "-50%",
                  y: `calc(-50% + ${yOffset}px)`,
                  rotate: rotation,
                  scale,
                  opacity,
                }}
                animate={{
                  x: "-50%",
                  y: `calc(-50% + ${yOffset}px)`,
                  rotate: rotation,
                  scale,
                  opacity,
                }}
                exit={{
                  x: `calc(-50% + ${exitDir * 140}vw)`,
                  rotate: baseAngle + exitDir * 18,
                  opacity: 0,
                  transition: {
                    // A relaxed, chill flight — the card drifts off rather
                    // than zips. Long ease-out so it carries the eye with
                    // it instead of yanking it.
                    duration: 1.2,
                    ease: [0.22, 1, 0.36, 1],
                    // Fade finishes just before the slide does, so the card
                    // dissolves into the paper rather than abruptly cutting
                    // out at the end of its travel.
                    opacity: { duration: 1.0, ease: [0.33, 0, 0.67, 1] },
                  },
                }}
                transition={{
                  // Position / rotation / scale settle quickly so the next
                  // card snaps forward without dawdling.
                  duration: 0.55,
                  ease: [0.22, 1, 0.36, 1],
                  // Opacity gets its own, deliberately slower curve. When a
                  // card promotes from depth 1 to depth 0 (becomes the new
                  // top), this is what lets it "unhurriedly emerge from the
                  // fade" instead of cutting straight to fully opaque.
                  opacity: { duration: 0.9, ease: [0.22, 1, 0.36, 1] },
                }}
                drag={isTop ? "x" : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.6}
                onDragEnd={
                  isTop
                    ? (e, info) => onDragEnd(card.postId, e, info)
                    : undefined
                }
                onClick={isTop ? () => onClickCard(card.postId) : undefined}
                whileTap={isTop ? { scale: 0.99 } : undefined}
              >
                <div className="photo-card flex h-full w-full select-none flex-col">
                  <div className="relative flex-1 overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={blobUrl(card.ownerAddress, card.blobName)}
                      alt={card.caption ?? ""}
                      className="h-full w-full object-cover"
                      draggable={false}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        const next = classifyAspect(
                          img.naturalWidth,
                          img.naturalHeight,
                        );
                        // Skip the setState if the bucket isn't actually
                        // changing (cached/repeat loads), otherwise we burn
                        // a render for nothing.
                        setAspects((prev) =>
                          prev[card.postId] === next
                            ? prev
                            : { ...prev, [card.postId]: next },
                        );
                      }}
                    />
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Owner attribution sits below the stack — small avatar dot + name. */}
      <Link
        href={`/u/${top.ownerAddress}`}
        className="mt-10 flex items-center gap-3 text-[var(--color-mute)] transition hover:text-[var(--color-ink)]"
      >
        <div className="h-7 w-7 overflow-hidden rounded-full bg-[var(--color-whisper)]">
          {topOwner?.avatarBlobName && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={blobUrl(top.ownerAddress, topOwner.avatarBlobName)}
              alt=""
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <span className="text-sm">{topOwnerName}</span>
      </Link>

      {/* Caption — small text in the display serif, optional. */}
      {top.caption && (
        <p
          style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}
          className="mt-4 max-w-md text-center text-base text-[var(--color-ink)]/80"
        >
          “{top.caption}”
        </p>
      )}

      {/* Quiet hint. */}
      <p className="mt-12 text-[10px] uppercase tracking-[0.3em] text-[var(--color-mute)]">
        · Click or swipe ·
      </p>
    </div>
  );
}
