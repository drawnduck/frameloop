"use client";

import {
  ClayErasureCodingProvider,
  ShelbyBlobClient,
  ShelbyClient,
  defaultErasureCodingConfig,
  expectedTotalChunksets,
  generateCommitments,
} from "@shelby-protocol/sdk/browser";
import type { ErasureCodingProvider } from "@shelby-protocol/sdk/browser";
import { AccountAddress, Network } from "@aptos-labs/ts-sdk";

let _client: ShelbyClient | null = null;
let _providerPromise: Promise<ErasureCodingProvider> | null = null;

function getApiKey() {
  const key = process.env.NEXT_PUBLIC_SHELBY_API_KEY;
  if (!key) {
    throw new Error("NEXT_PUBLIC_SHELBY_API_KEY is not set");
  }
  return key;
}

function getProvider() {
  if (!_providerPromise) {
    _providerPromise = ClayErasureCodingProvider.create(
      defaultErasureCodingConfig(),
    );
  }
  return _providerPromise;
}

export async function getShelbyClient() {
  if (_client) return _client;
  const provider = await getProvider();
  _client = new ShelbyClient(
    {
      network: Network.SHELBYNET,
      apiKey: getApiKey(),
      aptos: {
        network: Network.SHELBYNET,
        clientConfig: { API_KEY: getApiKey() },
      },
    },
    provider,
  );
  return _client;
}

export type RegisterBlobInput = {
  ownerAddress: string;
  blobName: string;
  blobData: Uint8Array;
  expirationMicros: number;
};

export async function buildRegisterBlobPayload(input: RegisterBlobInput) {
  const provider = await getProvider();
  const commitments = await generateCommitments(provider, input.blobData);
  const config = defaultErasureCodingConfig();
  const chunksetSize = config.chunkSizeBytes * config.erasure_k;
  const numChunksets = expectedTotalChunksets(
    input.blobData.length,
    chunksetSize,
  );

  const payload = ShelbyBlobClient.createRegisterBlobPayload({
    account: AccountAddress.fromString(input.ownerAddress),
    blobName: input.blobName,
    blobSize: input.blobData.length,
    blobMerkleRoot: commitments.blob_merkle_root,
    numChunksets,
    expirationMicros: input.expirationMicros,
    useSponsoredUsdVariant: false,
    encoding: config.enumIndex,
  });

  return { payload, commitments, numChunksets };
}

export type PutBlobProgress = {
  uploadedBytes: number;
  totalBytes: number;
};

export async function putBlobToShelby(params: {
  ownerAddress: string;
  blobName: string;
  blobData: Uint8Array;
  onProgress?: (p: PutBlobProgress) => void;
}) {
  const client = await getShelbyClient();
  await client.rpc.putBlob({
    account: AccountAddress.fromString(params.ownerAddress),
    blobName: params.blobName,
    blobData: params.blobData,
    onProgress: (p) =>
      params.onProgress?.({
        uploadedBytes: p.uploadedBytes,
        totalBytes: p.totalBytes,
      }),
  });
}

export async function waitForAptosTx(hash: string) {
  const client = await getShelbyClient();
  await client.aptos.waitForTransaction({ transactionHash: hash });
}

/**
 * Client-side probe: is this blob's on-chain metadata still alive?
 *
 * We call this *before* asking the wallet to sign a `delete_blob` tx —
 * Shelbynet has gone through state-resets where the ledger keeps the
 * historic `register_blob` tx but the contract's `blob_metadata`
 * resource for that blob is gone. In that state a real delete tx would
 * fail (and many wallets refuse to even simulate it). Knowing the blob
 * is dead lets the UI offer a no-signing "clear from index" path
 * instead of wasting a wallet popup the user will see fail.
 */
export async function probeBlobAlive(
  ownerAddress: string,
  blobName: string,
): Promise<boolean> {
  const client = await getShelbyClient();
  // ShelbyClient.coordination is the ShelbyBlobClient that talks to the
  // Aptos chain. getBlobMetadata returns undefined when the on-chain
  // metadata resource is missing.
  const md = await client.coordination.getBlobMetadata({
    account: AccountAddress.fromString(ownerAddress),
    name: blobName,
  });
  return !!md;
}

/**
 * Build the on-chain payload to permanently delete a blob.
 *
 * Same signing flow as upload: the wallet user signs and submits the
 * transaction themselves — the storage contract checks that the sender is
 * the blob owner, so neither this app nor any third party can delete
 * somebody else's memory.
 *
 *   const payload = buildDeleteBlobPayload(post.blobName);
 *   const { hash } = await signAndSubmitTransaction({ data: payload });
 *   await waitForAptosTx(hash);
 *   await fetch("/api/posts", { method: "DELETE", body: ... });
 */
export function buildDeleteBlobPayload(blobName: string) {
  return ShelbyBlobClient.createDeleteBlobPayload({ blobName });
}

// Default blob TTL for any upload path that doesn't explicitly choose
// one (currently: avatar upload on /me). Long-term — Frameloop is an
// archive product, so the safe default for incidental uploads
// is "keep it". The dedicated upload page (/upload) lets the user pick
// a shorter duration when they actually want a transient memory.
//
//   10 years × 365 days × 24h × 60m × 60s × 1_000_000μs
//   = 3.1536e14 μs  — well within Number.MAX_SAFE_INTEGER (~9e15).
export function defaultExpirationMicros() {
  return Date.now() * 1000 + 10 * 365 * 24 * 60 * 60 * 1_000_000;
}

// Generate a UUID-ish blob name that is not guessable.
export function newBlobName(prefix = "posts") {
  const rand = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}/${hex}`;
}
