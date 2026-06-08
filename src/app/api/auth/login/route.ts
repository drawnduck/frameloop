import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { setSessionCookie, verifySiwa } from "@/lib/auth";

const LoginSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  publicKey: z.string().regex(/^(0x)?[0-9a-fA-F]+$/),
  signature: z.string().regex(/^(0x)?[0-9a-fA-F]+$/),
  fullMessage: z.string().min(1),
  issuedAtMs: z.number().int(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const address = data.address.toLowerCase();

  const v = verifySiwa({
    address,
    publicKey: data.publicKey,
    signature: data.signature,
    fullMessage: data.fullMessage,
    issuedAtMs: data.issuedAtMs,
  });
  if (!v.ok) {
    return NextResponse.json(
      { error: "siwa_failed", reason: v.reason },
      { status: 401 },
    );
  }

  // Auto-upsert profile row on first sign-in.
  await prisma.profile.upsert({
    where: { address },
    update: {},
    create: { address },
  });

  await setSessionCookie(address);

  return NextResponse.json({ ok: true, address });
}
