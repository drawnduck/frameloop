import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const AddressRe = /^0x[0-9a-fA-F]{1,64}$/;

const CreateFollowSchema = z.object({
  target: z
    .string()
    .regex(AddressRe)
    .transform((s) => s.toLowerCase()),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = CreateFollowSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const target = parsed.data.target;
  if (target === session.address) {
    return NextResponse.json({ error: "cannot_follow_self" }, { status: 400 });
  }

  // Ensure target profile exists (lazy create on first interaction).
  await prisma.profile.upsert({
    where: { address: target },
    update: {},
    create: { address: target },
  });

  await prisma.follow.upsert({
    where: {
      followerAddress_followeeAddress: {
        followerAddress: session.address,
        followeeAddress: target,
      },
    },
    update: {},
    create: {
      followerAddress: session.address,
      followeeAddress: target,
      status: "ACTIVE",
    },
  });

  return NextResponse.json({ ok: true, follower: session.address, followee: target });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const direction = searchParams.get("direction"); // "following" | "followers"
  const address = searchParams.get("address")?.toLowerCase();
  if (!address || !AddressRe.test(address)) {
    return NextResponse.json({ error: "missing_or_invalid_address" }, { status: 400 });
  }

  if (direction === "following") {
    const rows = await prisma.follow.findMany({
      where: { followerAddress: address, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      include: { followee: true },
    });
    return NextResponse.json({
      direction,
      profiles: rows.map((r) => r.followee),
    });
  }
  if (direction === "followers") {
    const rows = await prisma.follow.findMany({
      where: { followeeAddress: address, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      include: { follower: true },
    });
    return NextResponse.json({
      direction,
      profiles: rows.map((r) => r.follower),
    });
  }
  return NextResponse.json(
    { error: "direction must be 'following' or 'followers'" },
    { status: 400 },
  );
}
