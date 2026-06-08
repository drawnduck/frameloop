// One-off check: read back a freshly uploaded blob through the Shelby SDK.
// Run: node --env-file=.env.local scripts/verify-upload.ts <blobName>

import { AccountAddress, Network } from "@aptos-labs/ts-sdk";
import {
  ShelbyClient,
  getShelbyBlobExplorerUrl,
} from "@shelby-protocol/sdk/node";

const blobName = process.argv[2];
if (!blobName) {
  console.error("Usage: node --env-file=.env.local scripts/verify-upload.ts <blobName>");
  process.exit(1);
}

const ownerAddress = process.env.DEV_ACCOUNT_ADDRESS;
const apiKey = process.env.NEXT_PUBLIC_SHELBY_API_KEY;
if (!ownerAddress || !apiKey) {
  console.error("DEV_ACCOUNT_ADDRESS and NEXT_PUBLIC_SHELBY_API_KEY must be set in .env.local");
  process.exit(1);
}

const account = AccountAddress.fromString(ownerAddress);
const client = new ShelbyClient({
  network: Network.SHELBYNET,
  apiKey,
  aptos: {
    network: Network.SHELBYNET,
    clientConfig: { API_KEY: apiKey },
  },
});

console.log(`\nAccount: ${ownerAddress}`);
console.log(`Blob:    ${blobName}\n`);

console.log("→ Fetching blob metadata from Aptos…");
const meta = await client.coordination.getBlobMetadata({
  account,
  name: blobName,
});

if (!meta) {
  console.error("× Blob not found on-chain.");
  process.exit(1);
}

console.log("✓ On-chain record:");
console.log(`  size:        ${meta.size} bytes`);
console.log(`  merkleRoot:  ${Buffer.from(meta.blobMerkleRoot).toString("hex")}`);
console.log(`  expiration:  ${new Date(meta.expirationMicros / 1000).toISOString()}`);
console.log(`  written:     ${meta.isWritten}`);

console.log("\n→ Downloading bytes from Shelby RPC…");
const blob = await client.download({ account, blobName });
const reader = blob.readable.getReader();
let received = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (value) received += value.length;
}

console.log(`✓ Downloaded ${received} bytes (matches: ${received === meta.size})`);

console.log("\nShelby blob explorer:");
console.log(
  `  ${getShelbyBlobExplorerUrl("shelbynet", account.toString(), blobName)}\n`,
);
