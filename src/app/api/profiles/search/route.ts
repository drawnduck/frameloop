import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const AddressRe = /^0x[0-9a-fA-F]+$/;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Number(searchParams.get("limit") ?? 20), 50);

  if (q.length < 1) {
    return NextResponse.json({ profiles: [] });
  }

  // Address-prefix branch: when the query looks like a hex prefix.
  if (AddressRe.test(q)) {
    const profiles = await prisma.profile.findMany({
      where: { address: { startsWith: q.toLowerCase() } },
      take: limit,
      select: {
        address: true,
        displayName: true,
        ansName: true,
        avatarBlobName: true,
      },
    });
    return NextResponse.json({ profiles });
  }

  // Name branch: case-insensitive substring match on displayName or ansName.
  const profiles = await prisma.profile.findMany({
    where: {
      OR: [
        { displayName: { contains: q, mode: "insensitive" } },
        { ansName: { contains: q, mode: "insensitive" } },
      ],
    },
    take: limit,
    select: {
      address: true,
      displayName: true,
      ansName: true,
      avatarBlobName: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ profiles });
}
