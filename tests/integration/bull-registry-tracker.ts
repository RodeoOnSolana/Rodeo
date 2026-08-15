import { BN, web3 } from "@coral-xyz/anchor";
import type { Program, AnchorProvider } from "@coral-xyz/anchor";
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

const { PublicKey, Keypair } = web3;

const SEED_BULL_PROOF_BUFFER = Buffer.from("bull-proof-buffer", "utf8");
const SEED_BULL_REGISTRY = Buffer.from("bull-registry", "utf8");
const CHUNK_SIZE = 800;

/**
 * Tracks the off-chain mirror of the on-chain BullRegistry.
 * The test must call registerBull() after each successful Bull reveal
 * and unregisterBull() after each successful Bull unstake.
 */
export class BullRegistryTracker {
  private entries: Map<string, BullLeaf[]> = new Map();

  clear(): void {
    this.entries.clear();
  }

  registerBull(owner: web3.PublicKey, bull: BullLeaf): void {
    const key = owner.toBase58();
    const bulls = this.entries.get(key) ?? [];
    // Avoid duplicates
    if (bulls.some((b) => b.position.equals(bull.position))) {
      throw new Error(`Bull at ${bull.position.toBase58()} already registered for owner ${key}`);
    }
    bulls.push(bull);
    this.entries.set(key, bulls);
  }

  unregisterBull(owner: web3.PublicKey, position: web3.PublicKey): void {
    const key = owner.toBase58();
    const bulls = this.entries.get(key);
    if (!bulls) return;
    const idx = bulls.findIndex((b) => b.position.equals(position));
    if (idx === -1) return;
    bulls.splice(idx, 1);
    if (bulls.length === 0) {
      this.entries.delete(key);
    } else {
      this.entries.set(key, bulls);
    }
  }

  getEntries(): RegistryEntry[] {
    return Array.from(this.entries.entries()).map(([ownerKey, bulls]) => ({
      owner: new PublicKey(ownerKey),
      bulls,
    }));
  }

  buildRegistry(): BuiltRegistry {
    return buildRegistry(this.getEntries());
  }

  hasOwner(owner: web3.PublicKey): boolean {
    return this.entries.has(owner.toBase58());
  }

  hasBull(owner: web3.PublicKey, position: web3.PublicKey): boolean {
    const bulls = this.entries.get(owner.toBase58());
    return bulls?.some((b) => b.position.equals(position)) ?? false;
  }

  getBulls(owner: web3.PublicKey): BullLeaf[] {
    return this.entries.get(owner.toBase58()) ?? [];
  }
}

/**
 * Derive the BullProofBuffer PDA.
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

export interface StagedBullProof {
  bufferPda: web3.PublicKey;
  refundRecipient: web3.PublicKey;
  nonce: BN;
  prover: web3.PublicKey;
  payloadBytes: Buffer;
  payloadLength: number;
}

/**
 * Stage a BullProofBuffer on-chain: initialize, append in chunks, finalize.
 */
export async function stageBullProofBuffer(
  program: Program<Idl>,
  globalConfig: web3.PublicKey,
  position: web3.PublicKey,
  pendingRandomness: web3.PublicKey,
  prover: web3.Keypair,
  nonce: BN,
  actionType: { reveal?: {}; unstake?: {} },
  payloadBytes: Buffer,
): Promise<StagedBullProof> {
  const [bufferPda] = deriveBullProofBufferPda(
    program.programId,
    pendingRandomness,
    prover.publicKey,
    nonce,
  );

  await program.methods
    .initializeBullProof(actionType, payloadBytes.length, nonce)
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
    prover: prover.publicKey,
    payloadBytes,
    payloadLength: payloadBytes.length,
  };
}

/**
 * Build and stage a Bull reveal proof for a new Bull position.
 * Uses the tracker to build a non-membership proof for the owner/position.
 */
export async function stageRevealProofForBull(
  program: Program<Idl>,
  globalConfig: web3.PublicKey,
  position: web3.PublicKey,
  pendingRandomness: web3.PublicKey,
  prover: web3.Keypair,
  nonce: BN,
  tracker: BullRegistryTracker,
  newBull: BullLeaf,
): Promise<StagedBullProof> {
  const registry = tracker.buildRegistry();
  const payload = buildRevealPayload(registry, newBull);
  const payloadBytes = serializeBullProofPayload(payload);
  return stageBullProofBuffer(
    program,
    globalConfig,
    position,
    pendingRandomness,
    prover,
    nonce,
    { reveal: {} },
    payloadBytes,
  );
}

/**
 * Build and stage a Bull unstake proof for removing a Bull.
 * Uses the tracker to build a membership proof for the owner/position.
 */
export async function stageUnstakeProofForBull(
  program: Program<Idl>,
  globalConfig: web3.PublicKey,
  position: web3.PublicKey,
  pendingRandomness: web3.PublicKey,
  prover: web3.Keypair,
  nonce: BN,
  tracker: BullRegistryTracker,
  owner: web3.PublicKey,
  bullPosition: web3.PublicKey,
): Promise<StagedBullProof> {
  const registry = tracker.buildRegistry();
  const payload = buildUnstakePayload(registry, owner, bullPosition);
  const payloadBytes = serializeBullProofPayload(payload);
  return stageBullProofBuffer(
    program,
    globalConfig,
    position,
    pendingRandomness,
    prover,
    nonce,
    { unstake: {} },
    payloadBytes,
  );
}

/**
 * Close a BullProofBuffer and refund lamports.
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
 * Get lamport balance of an account.
 */
export async function getLamportBalance(
  provider: AnchorProvider,
  pubkey: web3.PublicKey,
): Promise<number> {
  const account = await provider.connection.getAccountInfo(pubkey);
  return account?.lamports ?? 0;
}

/**
 * Check if an account exists on-chain.
 */
export async function accountExists(
  provider: AnchorProvider,
  pubkey: web3.PublicKey,
): Promise<boolean> {
  const account = await provider.connection.getAccountInfo(pubkey);
  return account !== null;
}
