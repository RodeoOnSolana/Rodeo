import { BN, web3 } from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  buildRegistry,
  buildRevealPayload,
  buildUnstakePayload,
  serializeBullProofPayload,
  type BullLeaf,
  type RegistryEntry,
  type BuiltRegistry,
} from "./sparse-tree.js";

const SEED_BULL_PROOF_BUFFER = Buffer.from("bull-proof-buffer", "utf8");
const SEED_BULL_REGISTRY = Buffer.from("bull-registry", "utf8");
const SEED_GLOBAL_CONFIG = Buffer.from("global-config", "utf8");
const MAX_PAYLOAD = 16384;
const CHUNK_SIZE = 800; // Safe chunk size for transaction limits

export interface BullProofBufferParams {
  program: Program<Idl>;
  provider: AnchorProvider;
  globalConfig: web3.PublicKey;
  position: web3.PublicKey;
  pendingRandomness: web3.PublicKey;
  prover: web3.Keypair;
  nonce: BN;
  actionType: number; // 0 = Reveal, 1 = Unstake
  payloadBytes: Buffer;
}

export interface StagedBullProofBuffer {
  bufferPda: web3.PublicKey;
  refundRecipient: web3.PublicKey;
  nonce: BN;
  prover: web3.Keypair;
}

/**
 * Derive the BullProofBuffer PDA from the production seeds.
 * Seeds: SEED_BULL_PROOF_BUFFER, pending_randomness, prover, nonce
 */
export function deriveBullProofBufferPda(
  programId: web3.PublicKey,
  pendingRandomness: web3.PublicKey,
  prover: web3.PublicKey,
  nonce: BN,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [
      SEED_BULL_PROOF_BUFFER,
      pendingRandomness.toBuffer(),
      prover.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

/**
 * Derive the BullRegistry PDA.
 */
export function deriveBullRegistryPda(
  programId: web3.PublicKey,
  globalConfig: web3.PublicKey,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [SEED_BULL_REGISTRY, globalConfig.toBuffer()],
    programId,
  );
}

/**
 * Read the current BullRegistry state from chain.
 */
export async function fetchBullRegistry(
  program: Program<Idl>,
  globalConfig: web3.PublicKey,
): Promise<{
  ownerTreeRoot: Uint8Array;
  totalBullCount: bigint;
  totalBuckPower: bigint;
  registryVersion: bigint;
}> {
  const [bullRegistryPda] = deriveBullRegistryPda(program.programId, globalConfig);
  const registry = await (program.account as any).bullRegistry.fetch(bullRegistryPda);
  return {
    ownerTreeRoot: registry.ownerTreeRoot,
    totalBullCount: registry.totalBullCount.toBigInt(),
    totalBuckPower: registry.totalBuckPower.toBigInt(),
    registryVersion: registry.registryVersion.toBigInt(),
  };
}

/**
 * Stage a BullProofBuffer on-chain: initialize, append payload in chunks,
 * and finalize. Returns the buffer PDA and refund recipient for passing
 * to SettleReveal or SettleUnstake.
 */
export async function stageBullProofBuffer(
  params: BullProofBufferParams,
): Promise<StagedBullProofBuffer> {
  const {
    program,
    provider,
    globalConfig,
    position,
    pendingRandomness,
    prover,
    nonce,
    actionType,
    payloadBytes,
  } = params;

  const [bufferPda] = deriveBullProofBufferPda(
    program.programId,
    pendingRandomness,
    prover.publicKey,
    nonce,
  );

  // 1. Initialize the buffer
  await program.methods
    .initializeBullProof(
      actionType,
      payloadBytes.length,
      nonce,
    )
    .accounts({
      prover: prover.publicKey,
      globalConfig,
      position,
      pendingRandomness,
      bullProofBuffer: bufferPda,
      systemProgram: web3.SystemProgram.programId,
      rent: web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([prover])
    .rpc();

  // 2. Append payload in chunks
  let offset = 0;
  while (offset < payloadBytes.length) {
    const chunk = payloadBytes.subarray(offset, offset + CHUNK_SIZE);
    await program.methods
      .appendBullProof(nonce, offset, Buffer.from(chunk))
      .accounts({
        prover: prover.publicKey,
        bullProofBuffer: bufferPda,
      })
      .signers([prover])
      .rpc();
    offset += chunk.length;
  }

  // 3. Finalize the buffer
  await program.methods
    .finalizeBullProof(nonce)
    .accounts({
      prover: prover.publicKey,
      bullProofBuffer: bufferPda,
    })
    .signers([prover])
    .rpc();

  return {
    bufferPda,
    refundRecipient: prover.publicKey,
    nonce,
    prover,
  };
}

/**
 * Close a BullProofBuffer and refund lamports to the committed recipient.
 */
export async function closeBullProofBuffer(
  program: Program<Idl>,
  bufferPda: web3.PublicKey,
  prover: web3.PublicKey,
  refundRecipient: web3.PublicKey,
  nonce: BN,
): Promise<void> {
  await program.methods
    .closeBullProof(nonce)
    .accounts({
      prover,
      bullProofBuffer: bufferPda,
      refundRecipient,
      clock: web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();
}

/**
 * Build and stage a Bull reveal proof buffer for a new Bull position.
 * The registry state must reflect the state BEFORE this Bull is added.
 */
export async function stageRevealProof(
  program: Program<Idl>,
  provider: AnchorProvider,
  globalConfig: web3.PublicKey,
  position: web3.PublicKey,
  pendingRandomness: web3.PublicKey,
  prover: web3.Keypair,
  nonce: BN,
  registryEntries: RegistryEntry[],
  newBull: BullLeaf,
): Promise<StagedBullProofBuffer> {
  const registry = buildRegistry(registryEntries);
  const payload = buildRevealPayload(registry, newBull);
  const payloadBytes = serializeBullProofPayload(payload);

  return stageBullProofBuffer({
    program,
    provider,
    globalConfig,
    position,
    pendingRandomness,
    prover,
    nonce,
    actionType: 0, // Reveal
    payloadBytes,
  });
}

/**
 * Build and stage a Bull unstake proof buffer for removing a Bull.
 * The registry entries must reflect the CURRENT live state.
 */
export async function stageUnstakeProof(
  program: Program<Idl>,
  provider: AnchorProvider,
  globalConfig: web3.PublicKey,
  position: web3.PublicKey,
  pendingRandomness: web3.PublicKey,
  prover: web3.Keypair,
  nonce: BN,
  registryEntries: RegistryEntry[],
  owner: web3.PublicKey,
  bullPosition: web3.PublicKey,
): Promise<StagedBullProofBuffer> {
  const registry = buildRegistry(registryEntries);
  const payload = buildUnstakePayload(registry, owner, bullPosition);
  const payloadBytes = serializeBullProofPayload(payload);

  return stageBullProofBuffer({
    program,
    provider,
    globalConfig,
    position,
    pendingRandomness,
    prover,
    nonce,
    actionType: 1, // Unstake
    payloadBytes,
  });
}

/**
 * Get the lamport balance of an account.
 */
export async function getLamportBalance(
  provider: AnchorProvider,
  pubkey: web3.PublicKey,
): Promise<number> {
  const account = await provider.connection.getAccountInfo(pubkey);
  return account?.lamports ?? 0;
}
