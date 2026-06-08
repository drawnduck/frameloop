import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Top tags in the public pool, with sample blob refs for previews.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 24), 100);

  // groupBy is the cleanest way to get top tags by count.
  const groups = await prisma.postCache.groupBy({
    by: ["tag"],
    where: { visibility: "PUBLIC", tag: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { tag: "desc" } },
    take: limit,
  });

  // For each tag, pull 3 sample posts for the preview thumbnails.
  const tags = await Promise.all(
    groups
      .filter((g): g is typeof g & { tag: string } => g.tag !== null)
      .map(async (g) => {
        const samples = await prisma.postCache.findMany({
          where: { tag: g.tag, visibility: "PUBLIC" },
          orderBy: { createdAt: "desc" },
          take: 3,
          select: { postId: true, ownerAddress: true, blobName: true },
        });
        return {
          tag: g.tag,
          count: g._count._all,
          samples,
        };
      }),
  );

  return NextResponse.json({ tags });
}
