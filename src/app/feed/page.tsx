"use client";

/**
 * Feed — vertical timeline of memories from accounts you follow.
 *
 * The layout mirrors Vault: ruler on the side, centre card in focus,
 * neighbours fade. Auto-triggers SIWA on mount when wallet is connected
 * but a matching session doesn't exist yet.
 */

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect } from "react";
import {
  FeedTimeline,
  type FeedOwner,
  type FeedPost,
} from "@/components/FeedTimeline";
import { useInfiniteList } from "@/lib/useInfiniteList";
import { useSession } from "@/lib/useSession";

// No right-slot action on /feed any more. We used to show a "filter by
// tag" trio of lines here, but tags as a first-class feature have been
// retired — keeping a non-functional control just because there's room
// for one is worse than letting the slot stay empty. The grid's 36px
// right column collapses to whitespace, which is fine — the side
// columns are still symmetric (both 36px wide) so the centred nav
// stays geometrically centred.

export default function FeedPage() {
  const { connected, account } = useWallet();
  const { session, status, signIn } = useSession();

  const myAddress = account?.address.toString().toLowerCase() ?? null;
  const hasSession =
    session !== null && (!myAddress || session.address === myAddress);

  // Auto-trigger SIWA when wallet connected but no matching session.
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

  const {
    items: posts,
    owners,
    loading,
    loadingMore,
    hasMore,
    error,
    sentinelRef,
  } = useInfiniteList<FeedPost, FeedOwner>({
    url: "/api/feed",
    enabled: hasSession,
  });

  return (
    // Chrome bar + h-screen wrapper now live in ChromeShell (root
    // layout). The page only contributes its main content — no right-
    // slot action on /feed any more (see comment above the import block
    // for the rationale).
    <>
      {/* min-h-0 unlocks flex shrink so the timeline can size itself by the
          available space rather than overflowing main. */}
      <main className="flex min-h-0 flex-1 flex-col">
        {!connected || !account ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="text-sm text-[var(--color-mute)]">
              Connect a wallet from the menu, top-left, to see your feed.
            </p>
          </div>
        ) : !hasSession ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="text-sm text-[var(--color-mute)]">
              {status === "signing"
                ? "Sign the message in your wallet…"
                : "Sign in from the menu, top-left."}
            </p>
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="text-sm text-[var(--color-mute)]">Loading…</p>
          </div>
        ) : error ? (
          <div className="mx-auto mt-12 max-w-sm rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] p-6 text-center text-sm text-[var(--color-mute)]">
            Failed to load: {error}
          </div>
        ) : (
          <FeedTimeline
            posts={posts}
            owners={owners}
            hasMore={hasMore}
            sentinelRef={sentinelRef}
            loadingMore={loadingMore}
          />
        )}
      </main>
    </>
  );
}
