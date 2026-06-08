import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ tag: string }> },
) {
  const { tag: raw } = await ctx.params;
  const tag = decodeURIComponent(raw).trim();
  if (!tag) {
    return NextResponse.json({ error: "invalid_tag" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 60), 200);
  const cursor = searchParams.get("cursor");

  const posts = await prisma.postCache.findMany({
    where: {
      visibility: "PUBLIC",
      tag,
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

  // Owner profiles for tile attribution.
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

  return NextResponse.json({
    tag,
    posts: trimmed.map((p) => ({
      postId: p.postId,
      ownerAddress: p.ownerAddress,
      blobName: p.blobName,
      caption: p.caption,
      createdAt: p.createdAt.toISOString(),
    })),
    owners: Object.fromEntries(profiles.map((p) => [p.address, p])),
    nextCursor,
  });
}
