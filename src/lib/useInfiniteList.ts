"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Hook for paginated lists where the API returns:
 *   { posts: T[]; owners?: Record<string, U>; nextCursor: string | null }
 *
 * Mounts an IntersectionObserver on a sentinel element so the caller just
 * renders `<div ref={sentinelRef} />` at the bottom of its list. Resets when
 * `url` or `enabled` changes — pass the bare endpoint URL (e.g. `/api/feed`)
 * and the hook appends `?cursor=…` (or `&cursor=…`) automatically.
 *
 * 401 responses are treated as "soft empty" (no items, no error) so a page
 * waiting on SIWA can show its own gated UI without an angry red banner.
 */
export type InfinitePage<TItem, TOwner> = {
  posts: TItem[];
  owners?: Record<string, TOwner>;
  nextCursor: string | null;
};

function appendCursor(url: string, cursor: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

export function useInfiniteList<TItem, TOwner = unknown>(args: {
  url: string;
  enabled?: boolean;
}) {
  const enabled = args.enabled ?? true;
  const [items, setItems] = useState<TItem[]>([]);
  const [owners, setOwners] = useState<Record<string, TOwner>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Cancel stale responses when url/enabled changes mid-flight.
  const reqSeq = useRef(0);

  const loadInitial = useCallback(async () => {
    const mySeq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    setItems([]);
    setOwners({});
    setCursor(null);
    setHasMore(true);
    if (!enabled) {
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(args.url, { cache: "no-store" });
      if (r.status === 401) {
        if (mySeq !== reqSeq.current) return;
        setHasMore(false);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as InfinitePage<TItem, TOwner>;
      if (mySeq !== reqSeq.current) return;
      setItems(j.posts);
      setOwners(j.owners ?? {});
      setCursor(j.nextCursor);
      setHasMore(j.nextCursor !== null);
    } catch (e) {
      if (mySeq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mySeq === reqSeq.current) setLoading(false);
    }
  }, [args.url, enabled]);

  const loadMore = useCallback(async () => {
    if (!enabled || !cursor || loadingMore || loading) return;
    const mySeq = reqSeq.current;
    setLoadingMore(true);
    try {
      const r = await fetch(appendCursor(args.url, cursor), {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as InfinitePage<TItem, TOwner>;
      if (mySeq !== reqSeq.current) return;
      setItems((prev) => [...prev, ...j.posts]);
      if (j.owners) {
        const incoming = j.owners;
        setOwners((prev) => ({ ...prev, ...incoming }));
      }
      setCursor(j.nextCursor);
      setHasMore(j.nextCursor !== null);
    } catch (e) {
      if (mySeq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mySeq === reqSeq.current) setLoadingMore(false);
    }
  }, [enabled, args.url, cursor, loadingMore, loading]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // Observe the sentinel — when it scrolls into view, fetch the next page.
  // We re-run when items.length changes so the observer re-attaches if the
  // sentinel element is replaced (e.g. when items are cleared on reset).
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, items.length]);

  return {
    items,
    owners,
    loading,
    loadingMore,
    error,
    hasMore,
    sentinelRef,
    reload: loadInitial,
  };
}
