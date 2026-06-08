import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const PatchProfileSchema = z.object({
  displayName: z.string().trim().max(50).nullable().optional(),
  bio: z.string().trim().max(280).nullable().optional(),
  avatarBlobName: z.string().trim().min(1).max(200).nullable().optional(),
});

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await prisma.profile.findUnique({
    where: { address: session.address },
  });
  return NextResponse.json({
    profile: profile && {
      address: profile.address,
      ansName: profile.ansName,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarBlobName: profile.avatarBlobName,
      createdAt: profile.createdAt.toISOString(),
    },
  });
}

export async function PATCH(req: Request) {
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
  const parsed = PatchProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Empty strings normalize to null so users can clear fields.
  const data = parsed.data;
  const update = {
    ...(data.displayName !== undefined && {
      displayName: data.displayName?.length ? data.displayName : null,
    }),
    ...(data.bio !== undefined && { bio: data.bio?.length ? data.bio : null }),
    ...(data.avatarBlobName !== undefined && {
      avatarBlobName: data.avatarBlobName?.length ? data.avatarBlobName : null,
    }),
  };

  const profile = await prisma.profile.upsert({
    where: { address: session.address },
    update,
    create: { address: session.address, ...update },
  });

  return NextResponse.json({
    profile: {
      address: profile.address,
      ansName: profile.ansName,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarBlobName: profile.avatarBlobName,
      createdAt: profile.createdAt.toISOString(),
    },
  });
}
