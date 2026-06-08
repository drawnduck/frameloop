"use client";

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AvatarImage } from "@/components/AvatarImage";
import { SiteHeader } from "@/components/SiteHeader";
import { WalletButton } from "@/components/WalletButton";
import {
  buildRegisterBlobPayload,
  defaultExpirationMicros,
  newBlobName,
  putBlobToShelby,
  waitForAptosTx,
} from "@/lib/shelby";
import { useSession } from "@/lib/useSession";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

type AvatarPhase =
  | "idle"
  | "committing"
  | "signing"
  | "confirming"
  | "uploading"
  | "saving";

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
    displayName: string | null;
    bio: string | null;
    avatarBlobName: string | null;
  } | null;
  counts: { followers: number; following: number; posts: number };
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

export default function MePage() {
  const { connected, account, signAndSubmitTransaction } = useWallet();
  const { session, status, signIn, error: signInError } = useSession();
  const [data, setData] = useState<ProfilePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftBio, setDraftBio] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  // Avatar editing state.
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarPhase, setAvatarPhase] = useState<AvatarPhase>("idle");
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const myAddress = account?.address.toString().toLowerCase() ?? null;

  // Auto-trigger SIWA once the wallet is connected and we know there's no
  // matching session yet. The signIn call shows the wallet popup; if the user
  // dismisses it, we leave them on the page with limited visibility.
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

  const load = useCallback(async () => {
    if (!myAddress) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/profiles/${encodeURIComponent(myAddress)}`, {
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
  }, [myAddress]);

  useEffect(() => {
    load();
  }, [load, session?.address]);

  function startEditing() {
    setDraftName(data?.profile?.displayName ?? "");
    setDraftBio(data?.profile?.bio ?? "");
    setProfileError(null);
    setEditing(true);
  }

  function startEditingAvatar() {
    setAvatarFile(null);
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(null);
    setAvatarPhase("idle");
    setAvatarError(null);
    setEditingAvatar(true);
  }

  function cancelEditingAvatar() {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(null);
    setAvatarFile(null);
    setAvatarPhase("idle");
    setAvatarError(null);
    setEditingAvatar(false);
  }

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
  }

  async function saveAvatar() {
    if (!avatarFile || !account || !myAddress) return;
    setAvatarError(null);
    try {
      // Mirror the post-upload pipeline but use the `avatars/` prefix and skip
      // the /api/posts indexing step — avatars are just a profile field.
      const buf = new Uint8Array(await avatarFile.arrayBuffer());

      setAvatarPhase("committing");
      const blobName = newBlobName("avatars");
      const expirationMicros = defaultExpirationMicros();
      const { payload } = await buildRegisterBlobPayload({
        ownerAddress: myAddress,
        blobName,
        blobData: buf,
        expirationMicros,
      });

      setAvatarPhase("signing");
      const submitted = await signAndSubmitTransaction({ data: payload });

      setAvatarPhase("confirming");
      await waitForAptosTx(submitted.hash);

      setAvatarPhase("uploading");
      await putBlobToShelby({
        ownerAddress: myAddress,
        blobName,
        blobData: buf,
      });

      setAvatarPhase("saving");
      let r = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avatarBlobName: blobName }),
      });
      // Same 401 → sign in → retry dance as the post upload page.
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

      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
      setAvatarPreview(null);
      setAvatarFile(null);
      setEditingAvatar(false);
      setAvatarPhase("idle");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("rejected") || msg.includes("User has rejected")) {
        setAvatarError("You cancelled the signature in your wallet.");
      } else {
        setAvatarError(msg);
      }
      setAvatarPhase("idle");
    }
  }

  async function saveProfile() {
    setSavingProfile(true);
    setProfileError(null);
    try {
      const r = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: draftName, bio: draftBio }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setEditing(false);
      await load();
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingProfile(false);
    }
  }

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-5xl px-6 py-12">
        {!connected || !account ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-12 text-center">
            <p className="text-zinc-400">Connect a wallet to see your memories.</p>
            <div className="mt-4 inline-block">
              <WalletButton />
            </div>
          </div>
        ) : (
          <>
            <section className="mb-10 flex items-end justify-between gap-6">
              <div className="flex flex-1 items-start gap-4">
                <button
                  type="button"
                  onClick={session ? startEditingAvatar : undefined}
                  disabled={!session}
                  className={`group relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-zinc-800 ${
                    session ? "cursor-pointer" : "cursor-default"
                  }`}
                  aria-label="Change avatar"
                >
                  <AvatarImage
                    src={
                      data?.profile?.avatarBlobName && myAddress
                        ? blobUrl(myAddress, data.profile.avatarBlobName)
                        : null
                    }
                    className="h-full w-full object-cover"
                    fallback={null}
                  />
                  {session && (
                    <span className="absolute inset-0 hidden items-center justify-center bg-black/50 text-[10px] font-medium uppercase tracking-wider text-white group-hover:flex">
                      Change
                    </span>
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <h1 className="text-3xl font-semibold tracking-tight">
                    {data?.profile?.displayName ?? "My memories"}
                  </h1>
                  <p className="mt-1 font-mono text-sm text-zinc-500">
                    {truncate(account.address.toString())}
                  </p>
                  {data?.profile?.bio && (
                    <p className="mt-3 max-w-md text-sm text-zinc-300">
                      {data.profile.bio}
                    </p>
                  )}
                  {data && (
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
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {session && !editing && !editingAvatar && (
                  <button
                    type="button"
                    onClick={startEditing}
                    className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
                  >
                    Edit profile
                  </button>
                )}
                <Link
                  href="/upload"
                  className="rounded-full bg-white px-5 py-2 text-sm font-medium text-black hover:bg-zinc-200"
                >
                  Upload new
                </Link>
              </div>
            </section>

            {editingAvatar && (
              <section className="mb-10 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
                <h2 className="mb-4 text-lg font-medium">Change avatar</h2>
                <div className="flex items-start gap-6">
                  <label
                    htmlFor="avatarFile"
                    className="flex h-32 w-32 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-zinc-800 bg-zinc-950 transition hover:border-zinc-700"
                  >
                    {avatarPreview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={avatarPreview}
                        alt="preview"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <AvatarImage
                        src={
                          data?.profile?.avatarBlobName && myAddress
                            ? blobUrl(myAddress, data.profile.avatarBlobName)
                            : null
                        }
                        alt="current"
                        className="h-full w-full object-cover opacity-50"
                        fallback={
                          <span className="text-xs text-zinc-500">
                            Pick image
                          </span>
                        }
                      />
                    )}
                    <input
                      id="avatarFile"
                      type="file"
                      accept="image/*"
                      onChange={pickAvatar}
                      className="hidden"
                    />
                  </label>
                  <div className="flex-1 space-y-3">
                    <p className="text-sm text-zinc-300">
                      Stored on Shelby, signed by your wallet. Max 2 MB. Square
                      images crop best.
                    </p>
                    {avatarPhase !== "idle" && (
                      <p className="text-xs text-zinc-500">
                        {avatarPhaseLabel(avatarPhase)}
                      </p>
                    )}
                    {avatarError && (
                      <p className="text-sm text-red-400">{avatarError}</p>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={cancelEditingAvatar}
                        disabled={avatarPhase !== "idle"}
                        className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={saveAvatar}
                        disabled={!avatarFile || avatarPhase !== "idle"}
                        className="rounded-full bg-white px-5 py-2 text-sm font-medium text-black hover:bg-zinc-200 disabled:opacity-50"
                      >
                        {avatarPhase === "idle" ? "Save avatar" : "Working…"}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {editing && (
              <section className="mb-10 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
                <h2 className="mb-4 text-lg font-medium">Edit profile</h2>
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="displayName"
                      className="mb-1 block text-xs uppercase tracking-wide text-zinc-500"
                    >
                      Display name
                    </label>
                    <input
                      id="displayName"
                      type="text"
                      maxLength={50}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="What to call you"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="bio"
                      className="mb-1 block text-xs uppercase tracking-wide text-zinc-500"
                    >
                      Bio
                    </label>
                    <textarea
                      id="bio"
                      rows={3}
                      maxLength={280}
                      value={draftBio}
                      onChange={(e) => setDraftBio(e.target.value)}
                      placeholder="Anything you'd like other people to know"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                    />
                    <p className="mt-1 text-right text-xs text-zinc-600">
                      {draftBio.length}/280
                    </p>
                  </div>
                  {profileError && (
                    <p className="text-sm text-red-400">{profileError}</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      disabled={savingProfile}
                      className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveProfile}
                      disabled={savingProfile}
                      className="rounded-full bg-white px-5 py-2 text-sm font-medium text-black hover:bg-zinc-200 disabled:opacity-50"
                    >
                      {savingProfile ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              </section>
            )}

            {status === "signing" && (
              <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-400">
                Sign in your wallet to view private and follower-only posts…
              </div>
            )}

            {signInError && (
              <div className="mb-6 rounded-xl border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-300">
                Sign-in error: {signInError}. Showing public posts only.
                <button
                  type="button"
                  onClick={() => signIn()}
                  className="ml-2 underline"
                >
                  Retry
                </button>
              </div>
            )}

            {loading && <p className="text-zinc-500">Loading…</p>}

            {error && (
              <div className="rounded-xl border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
                Failed to load: {error}
              </div>
            )}

            {!loading && !error && data && data.posts.length === 0 && (
              <div className="rounded-2xl border border-dashed border-zinc-800 p-12 text-center">
                <p className="text-zinc-500">No memories yet.</p>
                <Link
                  href="/upload"
                  className="mt-4 inline-block rounded-full bg-white px-5 py-2 text-sm font-medium text-black hover:bg-zinc-200"
                >
                  Upload your first →
                </Link>
              </div>
            )}

            {data && data.posts.length > 0 && (
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

function avatarPhaseLabel(p: AvatarPhase) {
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
