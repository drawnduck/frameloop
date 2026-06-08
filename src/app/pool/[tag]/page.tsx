"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { useInfiniteList } from "@/lib/useInfiniteList";

type Post = {
  postId: string;
  ownerAddress: string;
  blobName: string;
  caption: string | null;
  createdAt: string;
};
type Owner = {
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

export default function PoolTagPage() {
  const params = useParams<{ tag: string }>();
  const tag = decodeURIComponent(params.tag ?? "");

  const {
    items: posts,
    owners,
    loading,
    loadingMore,
    hasMore,
    error,
    sentinelRef,
  } = useInfiniteList<Post, Owner>({
    url: tag ? `/api/pool/${encodeURIComponent(tag)}` : "",
    enabled: !!tag,
  });

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <Link
              href="/pool"
              className="text-sm text-zinc-500 hover:text-zinc-300"
            >
              ← All tags
            </Link>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              #{tag}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {posts.length} card{posts.length === 1 ? "" : "s"}
              {hasMore && "+"}
            </p>
          </div>
        </div>

        {loading && <p className="text-zinc-500">Loading…</p>}

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
            Failed: {error}
          </div>
        )}

        {!loading && !error && posts.length === 0 && (
          <div className="rounded-2xl border border-dashed border-zinc-800 p-12 text-center text-zinc-500">
            No cards in this tag yet.
          </div>
        )}

        {posts.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {posts.map((p) => {
                const owner = owners[p.ownerAddress];
                const ownerName =
                  owner?.displayName ?? owner?.ansName ?? truncate(p.ownerAddress);
                return (
                  <article
                    key={p.postId}
                    className="group relative aspect-square overflow-hidden rounded-xl bg-zinc-900"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={blobUrl(p.ownerAddress, p.blobName)}
                      alt={p.caption ?? "card"}
                      className="h-full w-full object-cover transition group-hover:scale-105"
                    />
                    <Link
                      href={`/u/${p.ownerAddress}`}
                      className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-3 py-2 text-xs text-zinc-100 transition hover:text-fuchsia-300"
                    >
                      <div className="h-5 w-5 overflow-hidden rounded-full bg-zinc-800">
                        {owner?.avatarBlobName && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={blobUrl(p.ownerAddress, owner.avatarBlobName)}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        )}
                      </div>
                      <span className="truncate">{ownerName}</span>
                    </Link>
                  </article>
                );
              })}
            </div>

            {hasMore && <div ref={sentinelRef} className="h-8" aria-hidden />}
            {loadingMore && (
              <p className="mt-6 text-center text-sm text-zinc-500">
                Loading more…
              </p>
            )}
            {!hasMore && posts.length >= 60 && (
              <p className="mt-8 text-center text-xs text-zinc-600">
                You&apos;ve reached the end.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
