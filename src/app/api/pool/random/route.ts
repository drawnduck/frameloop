import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Pool/random — a shuffled batch of public posts for the card-stack view.
 *
 * The Pool page is intentionally serendipitous: nothing is sorted, no tag
 * filter, no chronology. We pull a random sample of PUBLIC posts plus their
 * owner profiles for the tiny attribution chip on each card.
 *
 * Postgres `random()` is fine at our scale. If the table grows past a million
 * rows we'd switch to TABLESAMPLE; for now this is the simplest, prettiest
 * query.
 */

type RandomPostRow = {
  postId: string;
  ownerAddress: string;
  blobName: string;
  caption: string | null;
  createdAt: Date;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 20), 60);

  // Raw query so we can use `random()`. Prisma's findMany has no shuffle.
  const posts = await prisma.$queryRaw<RandomPostRow[]>`
    SELECT "postId", "ownerAddress", "blobName", "caption", "createdAt"
    FROM "PostCache"
    WHERE "visibility" = 'PUBLIC'::"Visibility"
    ORDER BY random()
    LIMIT ${limit}
  `;

  const ownerAddrs = [...new Set(posts.map((p) => p.ownerAddress))];
  const profiles = ownerAddrs.length
    ? await prisma.profile.findMany({
        where: { address: { in: ownerAddrs } },
        select: {
          address: true,
          displayName: true,
          ansName: true,
          avatarBlobName: true,
        },
      })
    : [];

  return NextResponse.json({
    posts: posts.map((p) => ({
      postId: p.postId,
      ownerAddress: p.ownerAddress,
      blobName: p.blobName,
      caption: p.caption,
      createdAt: p.createdAt.toISOString(),
    })),
    owners: Object.fromEntries(profiles.map((p) => [p.address, p])),
  });
}
