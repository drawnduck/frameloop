"use client";

/**
 * Pool — a tactile card stack of public memories.
 *
 * Replaces the old "grid of tags" landing. Instead, the user is dropped
 * straight into a deck of cards: top card is full, you can click or swipe
 * to send it flying, and the next surfaces. A whisper-thin link in the
 * top-right opens the tag index for those who'd rather browse by category.
 */

import { useEffect, useState } from "react";
import { PoolStack, type PoolCard, type PoolOwner } from "@/components/PoolStack";

// No right-slot action on /pool. We used to put a tag-index link here
// (the three-lines glyph that opened /pool/tags), but tags are no
// longer a first-class browse axis — the pool is just a shuffled deck
// now, no need for a category filter. Leaving the slot empty keeps
// the chrome's left/right side columns symmetric so the centred nav
// row stays centred.

export default function PoolPage() {
  const [initial, setInitial] = useState<{
    posts: PoolCard[];
    owners: Record<string, PoolOwner>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    fetch("/api/pool/random?limit=24", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as {
          posts: PoolCard[];
          owners: Record<string, PoolOwner>;
        };
        if (aborted) return;
        setInitial(j);
      })
      .catch((e) => {
        if (aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      aborted = true;
    };
  }, []);

  return (
    // Chrome + flex-col wrapper supplied by ChromeShell. Page only
    // provides its main — no right-slot action (see comment above the
    // import block).
    <>
      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 items-center justify-center px-6 py-4">
        {initial === null && !error && (
          <p className="text-sm text-[var(--color-mute)]">Shuffling the deck…</p>
        )}
        {error && (
          <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] p-6 text-center text-sm text-[var(--color-mute)]">
            Couldn't open the pool: {error}
          </div>
        )}
        {initial !== null && !error && (
          <PoolStack initial={initial.posts} owners={initial.owners} />
        )}
      </main>
    </>
  );
}
