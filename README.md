# Frameloop

A private photo album on Aptos and Shelby. Your wallet is your account; your
photos live on a decentralized blob network; this app is just one way to look
at them.

Live at **[frameloop.xyz](https://frameloop.xyz)**.

## What it is

Three views over one set of photos:

- **Vault** — your personal horizontal timeline, scrubbable like a film strip.
  PRIVATE photos live here and nowhere else.
- **Look at Friends** — chronological feed from the accounts you follow.
  No ranking, no "for you", no algorithm.
- **Look at Everyone** — opt-in public pool. A photo joins by being tagged
  with a category (`landscape`, `street`, etc.) at upload time.

Sign in with the [Petra wallet](https://petra.app/) — your Aptos address
is your account. There's no email, no password, no phone number, no
"recover via Facebook".

## What's different from Instagram and Facebook

|                       | Instagram / Facebook                          | Frameloop                                                    |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Account               | Email + password tied to the platform         | Your wallet; we never know your real name                    |
| Identity portability  | None — moving means losing your followers     | Address is yours forever; any frontend over the same chain shows the same follow graph |
| Where photos live     | Their servers                                 | Shelby decentralized blobs, anchored by your on-chain `register_blob` tx |
| Feed ordering         | Engagement-maximizing algorithm               | Strictly chronological, newest first                         |
| Ads & tracking        | Pixels, third-party SDKs, cross-site profile  | None. No analytics SDK ships in this code.                   |
| Shadow ban / dimming  | Possible and undetectable                     | Not possible — feed query is in [`src/app/api/feed/route.ts`](src/app/api/feed/route.ts), read it |
| Censorship of content | Platform decides                              | Anyone can run their own frontend over the same Shelby blobs and see whatever they want |
| Account loss          | "Reset password"                              | Lose your wallet → lose your account. Real risk, not a feature. |

The point isn't "better than Instagram in every way" — it's **a different
deal**. You get ownership of your identity and your data, in exchange for
managing keys yourself.

## Honest trade-offs

Things to know before you trust this with anything you care about:

- **The frontend at `frameloop.xyz` is centralized today.** I host it; if I
  go offline, the site goes down. The *data* still exists on Shelby and
  Aptos and anyone can spin up another frontend over it — but right now
  there's only one frontend, and that's mine.
- **Privacy is access-control, not end-to-end encryption.** Photos sit on
  Shelby as plaintext bytes. The proxy at
  [`src/app/api/blob/[address]/[...blobName]/route.ts`](src/app/api/blob/[address]/[...blobName]/route.ts)
  gates who can ask for which bytes, and the blob name is a 128-bit
  unguessable random token. But: as the operator I can technically read
  any photo, including PRIVATE ones. If you need cryptographic privacy
  against the operator, this isn't your app — yet.
- **Currently on Shelbynet (devnet).** The Shelby team periodically wipes
  blob bytes during testing. When that happens, broken-image placeholders
  show up and you'd need to re-upload. Treat anything you post as
  ephemeral until mainnet.
- **Petra is the only wallet supported.** Backpack, OKX, and the
  Aptos Keyless social-login flows are intentionally excluded — Shelbynet
  doesn't ship the Keyless verification module today, so "Continue with
  Google" would work right up to the first transaction and then fail.
  Petra is the simplest path that actually works end-to-end.

## Architecture

```
            ┌──────────────── Aptos chain ──────────────────────┐
            │   account address  ·  follows  ·  register_blob   │
            │                                                   │
   Petra ──────────── sign messages, register blobs             │
            │                                                   │
            │                                                   │
   Browser ────── frameloop.xyz (Next.js)                       │
            │           │                                       │
            │           ├──── Shelby ──── blob bytes ───────────┘
            │           │
            │           └──── Postgres ── index cache
            │                              (feeds, profiles, follow graph)
```

Source of truth is **on-chain + on-Shelby**. Postgres is a queryable
cache — it lets the app answer "show me Alice's last 50 posts" without
streaming every Aptos event from genesis. If our Postgres dies, the data
is still on Shelby and can be re-indexed.

Auth uses **Sign-In with Aptos (SIWA)**: the user signs a structured
message with their wallet, we verify the Ed25519 signature on the server,
and issue a 30-day session JWT in an `httpOnly` cookie.

## Stack

- **Frontend**: Next.js 16 (App Router) + React 19 + Tailwind v4
- **Wallet**: `@aptos-labs/wallet-adapter-react` v8 (Petra only)
- **Blob storage**: `@shelby-protocol/sdk` (server-side)
- **Chain**: Aptos Shelbynet
- **Database**: PostgreSQL via Prisma 7 with `@prisma/adapter-pg`
- **Auth**: SIWA → JWT in httpOnly cookie

## Local development

```bash
npm install

cat > .env.local <<EOF
DATABASE_URL=postgresql://...
SESSION_SECRET=$(openssl rand -hex 32)
NEXT_PUBLIC_SHELBY_API_KEY=<from Shelbynet portal>
EOF

npx prisma generate
npx prisma db push
npm run dev
# → http://localhost:3000
```

You need a Shelbynet-funded account to upload (faucet on the Aptos
devnet portal) and Petra installed pointed at Shelbynet.

## Scripts

All scripts default to **dry-run**; pass `--yes` to apply.

| Script                         | Purpose                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `purge-dead-blobs.mjs`         | Drop `PostCache` rows whose Shelby bytes are gone (post-state-reset).    |
| `purge-dead-avatars.mjs`       | Same, for `Profile.avatarBlobName`.                                      |
| `purge-ghost-blobs.mjs`        | Drop rows whose on-chain metadata was wiped (rarer; module redeploy).    |
| `purge-ghost-avatars.mjs`      | Same, for avatars.                                                       |
| `check-expirations.mjs`        | List posts approaching their Shelby TTL.                                 |
| `check-onchain.mjs`            | Verify on-chain state of a specific `(address, blobName)` pair.          |

Run with `node --env-file=.env scripts/<name>.mjs`.

## Status

Personal project, actively built on Shelbynet. Expect data loss. No SLA.
Not production-grade. **If you upload something irreplaceable, keep a
local copy.**

## License

Not chosen yet — treat as all rights reserved until that lands.
