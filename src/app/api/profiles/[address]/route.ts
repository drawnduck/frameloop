import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const AddressRe = /^0x[0-9a-fA-F]{1,64}$/;

function serializePost(p: {
  postId: string;
  ownerAddress: string;
  blobName: string;
  contentHash: string | null;
  size: number;
  visibility: "PRIVATE" | "FOLLOWERS" | "PUBLIC";
  tag: string | null;
  caption: string | null;
  txHash: string;
  expirationMicros: bigint;
  createdAt: Date;
}) {
  return {
    ...p,
    expirationMicros: p.expirationMicros.toString(),
    createdAt: p.createdAt.toISOString(),
  };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ address: string }> },
) {
  const { address: raw } = await ctx.params;
  const address = raw.toLowerCase();
  if (!AddressRe.test(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  const session = await getSession();
  const isOwn = session?.address === address;

  // Determine viewer relationship: own / follower / stranger.
  let isFollower = false;
  if (session && !isOwn) {
    const row = await prisma.follow.findUnique({
      where: {
        followerAddress_followeeAddress: {
          followerAddress: session.address,
          followeeAddress: address,
        },
      },
    });
    isFollower = row?.status === "ACTIVE";
  }

  // Build visibility filter for the viewer.
  // Own: all. Follower: PUBLIC + FOLLOWERS. Stranger: PUBLIC only.
  const allowed: Array<"PRIVATE" | "FOLLOWERS" | "PUBLIC"> = isOwn
    ? ["PRIVATE", "FOLLOWERS", "PUBLIC"]
    : isFollower
      ? ["FOLLOWERS", "PUBLIC"]
      : ["PUBLIC"];

  const profile = await prisma.profile.findUnique({
    where: { address },
  });

  // Profile is optional (a wallet might never have signed in). We still return
  // posts if any exist (legacy uploads created profile via the posts endpoint).
  const [posts, followerCount, followingCount] = await Promise.all([
    prisma.postCache.findMany({
      where: { ownerAddress: address, visibility: { in: allowed } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.follow.count({ where: { followeeAddress: address, status: "ACTIVE" } }),
    prisma.follow.count({ where: { followerAddress: address, status: "ACTIVE" } }),
  ]);

  return NextResponse.json({
    profile: profile && {
      address: profile.address,
      ansName: profile.ansName,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarBlobName: profile.avatarBlobName,
      createdAt: profile.createdAt.toISOString(),
    },
    viewer: {
      authenticated: session !== null,
      isOwn,
      isFollower,
    },
    counts: {
      followers: followerCount,
      following: followingCount,
      posts: posts.length,
    },
    posts: posts.map(serializePost),
  });
}
