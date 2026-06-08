"use client";

/**
 * Search — finding people on the network.
 *
 *  ┌──────────────────────────────────────────────────────────┐
 *  │                                                          │
 *  │     ⌕  Search by name, ANS, or 0x address…              │
 *  │     ──────────────────────────────────────────────────   │
 *  │                                                          │
 *  │     ┌─ avatar  Display name                         ›    │
 *  │     │          0x1234…abcd                               │
 *  │     ├──────────────────────────────────────────────────  │
 *  │     ┌─ avatar  Another person                       ›    │
 *  │     │          0x5678…ef00                               │
 *  │     └──────────────────────────────────────────────────  │
 *  │                                                          │
 *  └──────────────────────────────────────────────────────────┘
 *
 *  Decisions:
 *   • No "Find people" heading. The active dot under "Search" in the
 *     nav is enough — the page is the search field.
 *   • paper-input style (border-bottom only) with a single magnifier
 *     glyph on the left. No box, no submit button.
 *   • Live, debounced query (250 ms). URL stays in sync via
 *     router.replace so links can be shared, but we don't fight
 *     history with one entry per keystroke.
 *   • Result rows are flat: hairline dividers between, no card
 *     borders. The name in display italic; address below in mono.
 *     A chevron and a 1px right-shift on hover signal navigability.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AvatarImage } from "@/components/AvatarImage";

type Profile = {
  address: string;
  displayName: string | null;
  ansName: string | null;
  avatarBlobName: string | null;
};

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function blobUrl(address: string, blobName: string) {
  const parts = blobName.split("/").map(encodeURIComponent).join("/");
  return `/api/blob/${address}/${parts}`;
}

function SearchInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initial = searchParams.get("q") ?? "";

  const [q, setQ] = useState(initial);
  const [results, setResults] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  // hasSearched stays false until the first real query lands. Lets us
  // distinguish "page just loaded, show nothing" from "we searched and
  // there were no matches, say so".
  const [hasSearched, setHasSearched] = useState(false);

  // Cancel-in-flight token: when the user types fast we don't want a
  // late response from an earlier query to clobber the newest results.
  const reqIdRef = useRef(0);

  const runSearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setHasSearched(false);
      setLoading(false);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    setHasSearched(true);
    try {
      const r = await fetch(
        `/api/profiles/search?q=${encodeURIComponent(trimmed)}`,
        { cache: "no-store" },
      );
      const j: { profiles: Profile[] } = await r.json();
      // Drop stale responses — only the latest request is allowed to
      // paint into the list.
      if (myId !== reqIdRef.current) return;
      setResults(j.profiles);
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }, []);

  // Debounced live search. 250 ms after the user stops typing we hit
  // the API and update the URL. Tight enough to feel instant, loose
  // enough that we don't query the server on every keystroke.
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      runSearch(q);
      const trimmed = q.trim();
      router.replace(
        trimmed
          ? `/search?q=${encodeURIComponent(trimmed)}`
          : "/search",
        { scroll: false },
      );
    }, 250);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [q, runSearch, router]);

  return (
    // min-h-0 unlocks flex shrink so the results area can scroll
    // internally if a query returns many rows, while the page itself
    // stays pinned to one viewport.
    <main className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col px-6 pb-10 pt-8 sm:px-10">
      {/* Search field — paper-input underline + magnifier glyph. */}
      <div className="relative">
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 text-[var(--color-mute)]"
        >
          <circle
            cx="6"
            cy="6"
            r="4.25"
            stroke="currentColor"
            strokeWidth="1"
          />
          <path
            d="M9.25 9.25L12.5 12.5"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
          />
        </svg>

        <input
          autoFocus
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, ANS, or 0x address…"
          aria-label="Search people"
          className="paper-input pl-7"
          // Esc clears so re-searching is one keystroke from done.
          onKeyDown={(e) => {
            if (e.key === "Escape") setQ("");
          }}
        />
      </div>

      {/* Results / states. Lives in its own scrolling region so a
          1000-row result list never pushes the search bar off-screen. */}
      <div className="mt-6 flex-1 overflow-y-auto">
        {!hasSearched && q.trim() === "" && (
          <p
            style={{ fontFamily: "var(--font-display)" }}
            className="mt-16 text-center text-lg italic text-[var(--color-mute)]"
          >
            Find someone you know.
          </p>
        )}

        {loading && (
          <p
            style={{ fontFamily: "var(--font-mono)" }}
            className="mt-12 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--color-mute)]"
          >
            · searching ·
          </p>
        )}

        {!loading && hasSearched && results.length === 0 && (
          <p className="mt-12 text-center text-sm text-[var(--color-mute)]">
            No matches for{" "}
            <span
              className="italic text-[var(--color-ink)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              «{q.trim()}»
            </span>
            .
          </p>
        )}

        {!loading && results.length > 0 && (
          <ul>
            {results.map((p, i) => (
              <li
                key={p.address}
                className={
                  i > 0 ? "border-t border-[var(--color-edge)]" : ""
                }
              >
                <Link
                  href={`/u/${p.address}`}
                  className="group flex items-center gap-4 py-4 transition"
                >
                  <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-[var(--color-whisper)] ring-1 ring-[var(--color-edge)]">
                    <AvatarImage
                      src={
                        p.avatarBlobName
                          ? blobUrl(p.address, p.avatarBlobName)
                          : null
                      }
                      className="h-full w-full object-cover"
                      fallback={
                        <span
                          className="flex h-full w-full items-center justify-center text-[10px] text-[var(--color-mute)]"
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          {p.address.slice(2, 4).toUpperCase()}
                        </span>
                      }
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-base italic text-[var(--color-ink)] transition group-hover:translate-x-[2px]"
                      style={{ fontFamily: "var(--font-display)" }}
                    >
                      {p.displayName ?? p.ansName ?? truncate(p.address)}
                    </p>
                    <p
                      className="truncate text-[11px] text-[var(--color-mute)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {truncate(p.address)}
                    </p>
                  </div>
                  <svg
                    aria-hidden
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className="text-[var(--color-mute)] opacity-0 transition group-hover:opacity-100"
                  >
                    <path
                      d="M4 2L8 6L4 10"
                      stroke="currentColor"
                      strokeLinecap="round"
                    />
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

export default function SearchPage() {
  // Chrome bar + h-screen wrapper supplied by ChromeShell. /search has
  // no right-slot action, so we don't portal anything into the chrome.
  return (
    <Suspense fallback={null}>
      <SearchInner />
    </Suspense>
  );
}
