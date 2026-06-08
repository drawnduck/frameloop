import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const AddressRe = /^0x[0-9a-fA-F]{1,64}$/;

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ target: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { target: raw } = await ctx.params;
  const target = raw.toLowerCase();
  if (!AddressRe.test(target)) {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }

  await prisma.follow.deleteMany({
    where: {
      followerAddress: session.address,
      followeeAddress: target,
    },
  });

  return NextResponse.json({ ok: true });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ target: string }> },
) {
  const session = await getSession();
  const { target: raw } = await ctx.params;
  const target = raw.toLowerCase();
  if (!AddressRe.test(target)) {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }
  if (!session) {
    return NextResponse.json({ following: false, anonymous: true });
  }
  const row = await prisma.follow.findUnique({
    where: {
      followerAddress_followeeAddress: {
        followerAddress: session.address,
        followeeAddress: target,
      },
    },
  });
  return NextResponse.json({ following: row !== null && row.status === "ACTIVE" });
}
