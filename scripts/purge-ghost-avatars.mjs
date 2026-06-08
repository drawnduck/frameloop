// One-time cleanup: clear Profile.avatarBlobName for entries whose
// on-chain blob metadata is missing (typically after a Shelbynet state
// reset). Pair script to `purge-ghost-blobs.mjs` — same root cause,
// different table.
//
// Dry-run (default):
//   node -r dotenv/config scripts/purge-ghost-avatars.mjs \
//        dotenv_config_path=.env.local
//
// Actually clear:
//   node -r dotenv/config scripts/purge-ghost-avatars.mjs \
//        dotenv_config_path=.env.local --yes

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  Aptos,
  AptosConfig,
  Network,
  AccountAddress,
} from "@aptos-labs/ts-sdk";

const SHELBY_DEPLOYER =
  "0x85fdb9a176ab8ef1d9d9c1b60d60b3924f0800ac1de1cc2085fb0b8bb4988e6a";
const YES = process.argv.includes("--yes");

const connectionString = process.env.DATABASE_URL;
const apiKey = process.env.NEXT_PUBLIC_SHELBY_API_KEY;
if (!connectionString) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
const aptos = new Aptos(
  new AptosConfig({
    network: Network.SHELBYNET,
    ...(apiKey ? { clientConfig: { API_KEY: apiKey } } : {}),
  }),
);

const profiles = await prisma.profile.findMany({
  where: { avatarBlobName: { not: null } },
  select: { address: true, avatarBlobName: true, displayName: true },
});

console.log(`profiles with avatar set: ${profiles.length}`);

const ghosts = [];
for (const p of profiles) {
  try {
    const addr = AccountAddress.from(p.address, { maxMissingChars: 63 });
    const blobKey = `@${addr.toStringLongWithoutPrefix()}/${p.avatarBlobName}`;
    const raw = await aptos.view({
      payload: {
        function: `${SHELBY_DEPLOYER}::blob_metadata::get_blob_metadata`,
        functionArguments: [blobKey],
      },
    });
    const alive = !!raw?.[0]?.vec?.[0];
    if (!alive) ghosts.push(p);
  } catch (e) {
    // Skip rows we can't probe — better to under-clear than over-clear.
    console.warn(
      `probe failed for ${p.address}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

console.log(`\nFound ${ghosts.length} ghost avatar(s):`);
for (const g of ghosts) {
  console.log(`  ${g.displayName ?? "(no name)"}  ${g.address}  ${g.avatarBlobName}`);
}

if (ghosts.length === 0) {
  console.log("\nNothing to clear.");
  await prisma.$disconnect();
  process.exit(0);
}

if (!YES) {
  console.log("\nDry-run. Re-run with --yes to null these avatarBlobName fields.");
  await prisma.$disconnect();
  process.exit(0);
}

const addrs = ghosts.map((g) => g.address);
const result = await prisma.profile.updateMany({
  where: { address: { in: addrs } },
  data: { avatarBlobName: null },
});
console.log(`\nCleared ${result.count} avatarBlobName field(s).`);
await prisma.$disconnect();
