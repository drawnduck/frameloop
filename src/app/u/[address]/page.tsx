"use client";

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AvatarImage } from "@/components/AvatarImage";
import { SiteHeader } from "@/components/SiteHeader";
import { WalletButton } from "@/components/WalletButton";
import { useSession } from "@/lib/useSession";

type Post = {
  postId: string;
  ownerAddress: string;
  blobName: string;
  size: number;
  visibility: "PRIVATE" | "FOLLOWERS" | "PUBLIC";
  tag: string | null;
  caption: string | null;
  txHash: string;
  createdAt: string;
};

type ProfilePayload = {
  profile: {
    address: string;
    ansName: string | null;
    displayName: string | null;
    bio: string | null;
    avatarBlobName: string | null;
    createdAt: string;
  } | null;
  viewer: {
    authenticated: boolean;
    isOwn: boolean;
    isFollower: boolean;
  };
  counts: {
    followers: number;
    following: number;
    posts: number;
  };
  posts: Post[];
};

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function blobUrl(address: string, blobName: string) {
  const parts = blobName.split("/").map(encodeURIComponent).join("/");
  return `/api/blob/${address}/${parts}`;
}

function VisibilityBadge({ v }: { v: Post["visibility"] }) {
  const styles: Record<Post["visibility"], string> = {
    PRIVATE: "bg-zinc-800 text-zinc-300",
    FOLLOWERS: "bg-amber-900/40 text-amber-300",
    PUBLIC: "bg-emerald-900/40 text-emerald-300",
  };
  const labels = { PRIVATE: "Private", FOLLOWERS: "Followers", PUBLIC: "Public" };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles[v]}`}
    >
      {labels[v]}
    </span>
  );
}

export default function ProfilePage() {
  const params = useParams<{ address: string }>();
  const target = (params.address ?? "").toLowerCase();
  const { connected } = useWallet();
  const { session, signIn, status } = useSession();
  const [data, setData] = useState<ProfilePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/profiles/${encodeURIComponent(target)}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: ProfilePayload = await r.json();
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    load();
  }, [load]);

  // Reload whenever the session changes so visibility filter is correct.
  useEffect(() => {
    load();
  }, [load, session?.address]);

  const handleFollow = useCallback(async () => {
    if (!data) return;
    setFollowBusy(true);
    try {
      if (!session) {
        const ok = await signIn();
        if (!ok) return;
      }
      if (data.viewer.isFollower) {
        await fetch(`/api/follows/${encodeURIComponent(target)}`, {
          method: "DELETE",
        });
      } else {
        await fetch(`/api/follows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target }),
        });
      }
      await load();
    } finally {
      setFollowBusy(false);
    }
  }, [data, session, signIn, target, load]);

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-5xl px-6 py-12">
        {loading && <p className="text-zinc-500">Loading…</p>}

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
            Failed to load profile: {error}
          </div>
        )}

        {data && (
          <>
            <section className="mb-10 flex items-start justify-between gap-6">
              <div className="flex items-start gap-4">
                <div className="h-20 w-20 overflow-hidden rounded-full bg-zinc-800">
                  <AvatarImage
                    src={
                      data.profile?.avatarBlobName
                        ? blobUrl(target, data.profile.avatarBlobName)
                        : null
                    }
                    className="h-full w-full object-cover"
                    fallback={null}
                  />
                </div>
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">
                    {data.profile?.displayName ??
                      data.profile?.ansName ??
                      truncate(target)}
                  </h1>
                  <p className="mt-0.5 font-mono text-xs text-zinc-500">
                    {truncate(target)}
                  </p>
                  {data.profile?.bio && (
                    <p className="mt-3 max-w-md text-sm text-zinc-300">
                      {data.profile.bio}
                    </p>
                  )}
                  <div className="mt-3 flex gap-4 text-sm text-zinc-400">
                    <span>
                      <strong className="text-zinc-100">{data.counts.posts}</strong>{" "}
                      posts
                    </span>
                    <span>
                      <strong className="text-zinc-100">
                        {data.counts.followers}
                      </strong>{" "}
                      followers
                    </span>
                    <span>
                      <strong className="text-zinc-100">
                        {data.counts.following}
                      </strong>{" "}
                      following
                    </span>
                  </div>
                </div>
              </div>

              {!data.viewer.isOwn && connected && (
                <button
                  type="button"
                  onClick={handleFollow}
                  disabled={followBusy || status === "signing"}
                  className={`rounded-full px-5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    data.viewer.isFollower
                      ? "border border-zinc-700 text-zinc-200 hover:bg-zinc-900"
                      : "bg-white text-black hover:bg-zinc-200"
                  }`}
                >
                  {followBusy
                    ? "…"
                    : status === "signing"
                      ? "Sign in your wallet…"
                      : data.viewer.isFollower
                        ? "Unfollow"
                        : !session
                          ? "Sign in to follow"
                          : "Follow"}
                </button>
              )}
            </section>

            {data.posts.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-800 p-12 text-center text-zinc-500">
                {data.viewer.isOwn
                  ? "No memories yet."
                  : "Nothing to see here yet."}
                {!data.viewer.authenticated && !data.viewer.isOwn && (
                  <p className="mt-2 text-xs">
                    There may be follower-only posts. Sign in and follow to view.
                  </p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {data.posts.map((p) => (
                  <article
                    key={p.postId}
                    className="group relative aspect-square overflow-hidden rounded-xl bg-zinc-900"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={blobUrl(p.ownerAddress, p.blobName)}
                      alt={p.caption ?? "memory"}
                      className="h-full w-full object-cover transition group-hover:scale-105"
                    />
                    <div className="absolute left-2 top-2">
                      <VisibilityBadge v={p.visibility} />
                    </div>
                    {(p.caption || p.tag) && (
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3">
                        {p.tag && (
                          <p className="text-[10px] uppercase tracking-wider text-fuchsia-300">
                            #{p.tag}
                          </p>
                        )}
                        {p.caption && (
                          <p className="line-clamp-2 text-xs text-zinc-100">
                            {p.caption}
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
