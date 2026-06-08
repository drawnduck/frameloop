"use client";

/**
 * Pool / tags — secondary browse view for users who want categories rather
 * than the random card stack on /pool. Same paper aesthetic; a quiet grid
 * of tag preview tiles.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChromeRightSlot } from "@/components/ChromeShell";

type Sample = { postId: string; ownerAddress: string; blobName: string };
type TagSummary = { tag: string; count: number; samples: Sample[] };

function blobUrl(address: string, blobName: string) {
  const parts = blobName.split("/").map(encodeURIComponent).join("/");
  return `/api/blob/${address}/${parts}`;
}

function BackToStack() {
  return (
    <Link href="/pool" className="chrome-dot" aria-label="Back to the stack">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M9 3L5 7L9 11" stroke="currentColor" strokeLinecap="round" />
      </svg>
    </Link>
  );
}

export default function PoolTagsPage() {
  const [tags, setTags] = useState<TagSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    fetch("/api/pool", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: { tags: TagSummary[] } = await r.json();
        if (aborted) return;
        setTags(j.tags);
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
    // Chrome + flex-col wrapper supplied by ChromeShell.
    <>
      <ChromeRightSlot>
        <BackToStack />
      </ChromeRightSlot>

      <main className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto px-6 py-8">
        {tags === null && !error && (
          <p className="text-sm text-[var(--color-mute)]">Loading…</p>
        )}
        {error && (
          <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] p-6 text-center text-sm text-[var(--color-mute)]">
            Failed to load tags: {error}
          </div>
        )}
        {tags?.length === 0 && (
          <div className="rounded-lg border border-dashed border-[var(--color-edge)] p-12 text-center text-sm text-[var(--color-mute)]">
            No public cards in the pool yet.
          </div>
        )}
        {tags && tags.length > 0 && (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {tags.map((t) => (
              <Link
                key={t.tag}
                href={`/pool/${encodeURIComponent(t.tag)}`}
                className="group block overflow-hidden rounded-sm bg-[var(--color-surface)] shadow-[0_1px_2px_rgba(20,20,20,.04),0_12px_28px_-8px_rgba(20,20,20,.1)] transition hover:shadow-[0_2px_4px_rgba(20,20,20,.06),0_28px_60px_-16px_rgba(20,20,20,.2)]"
              >
                <div className="grid aspect-[3/2] grid-cols-3 gap-px bg-[var(--color-edge)]">
                  {t.samples.map((s) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={s.postId}
                      src={blobUrl(s.ownerAddress, s.blobName)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ))}
                  {Array.from({ length: 3 - t.samples.length }).map((_, i) => (
                    <div
                      key={`empty-${i}`}
                      className="bg-[var(--color-paper)]"
                    />
                  ))}
                </div>
                <div className="flex items-center justify-between px-4 py-4">
                  <p
                    style={{ fontFamily: "var(--font-display)" }}
                    className="text-lg italic text-[var(--color-ink)]"
                  >
                    {t.tag}
                  </p>
                  <p
                    className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-mute)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {t.count} {t.count === 1 ? "card" : "cards"}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
