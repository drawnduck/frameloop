import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Chronological feed of posts from accounts the session user follows.
// You see PUBLIC + FOLLOWERS posts (you're a follower of these accounts).
// PRIVATE never leaves the owner. Self-posts are NOT included — that's /me.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 100);
  const cursor = searchParams.get("cursor");

  // Who I follow.
  const follows = await prisma.follow.findMany({
    where: { followerAddress: session.address, status: "ACTIVE" },
    select: { followeeAddress: true },
  });
  const followeeAddresses = follows.map((f) => f.followeeAddress);

  if (followeeAddresses.length === 0) {
    return NextResponse.json({ posts: [], owners: {}, nextCursor: null });
  }

  const posts = await prisma.postCache.findMany({
    where: {
      ownerAddress: { in: followeeAddresses },
      visibility: { in: ["PUBLIC", "FOLLOWERS"] },
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  const hasMore = posts.length > limit;
  const trimmed = hasMore ? posts.slice(0, limit) : posts;
  const nextCursor = hasMore
    ? trimmed[trimmed.length - 1].createdAt.toISOString()
    : null;

  // Resolve owner profiles in one query.
  const ownerAddrs = [...new Set(trimmed.map((p) => p.ownerAddress))];
  const profiles = await prisma.profile.findMany({
    where: { address: { in: ownerAddrs } },
    select: {
      address: true,
      displayName: true,
      ansName: true,
      avatarBlobName: true,
    },
  });
  const owners = Object.fromEntries(profiles.map((p) => [p.address, p]));

  return NextResponse.json({
    posts: trimmed.map((p) => ({
      postId: p.postId,
      ownerAddress: p.ownerAddress,
      blobName: p.blobName,
      size: p.size,
      visibility: p.visibility,
      tag: p.tag,
      caption: p.caption,
      txHash: p.txHash,
      createdAt: p.createdAt.toISOString(),
    })),
    owners,
    nextCursor,
  });
}
