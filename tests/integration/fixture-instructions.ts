// Raw transaction helpers for test-only fixture instructions.
//
// The production IDL intentionally omits these methods, so the localnet suites
// build the instructions manually using Anchor instruction discriminators.
// This mirrors the pre-Phase-4A canonical harness and keeps test fixtures out
// of the production SDK.

import { BN, web3 } from "@coral-xyz/anchor";
import { createHash } from "node:crypto";

const PROGRAM_ID = new web3.PublicKey(
  "CdEU5FfgsPgrPMMLsDAPY29sN4sWqZpMetAXVY633NhA",
);

function discriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
}

export function deriveGlobalConfig(): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    PROGRAM_ID,
  );
}

export function deriveGlobalGameState(globalConfig: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global-game-state"), globalConfig.toBuffer()],
    PROGRAM_ID,
  );
}

export function deriveRewardState(globalConfig: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("reward-state"), globalConfig.toBuffer()],
    PROGRAM_ID,
  );
}

export function deriveBullRegistry(globalConfig: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("bull-registry"), globalConfig.toBuffer()],
    PROGRAM_ID,
  );
}

function u64LE(n: BN): Buffer {
  return n.toArrayLike(Buffer, "le", 8);
}

export function buildTestFixtureSetGlobalGameStateIx(
  authority: web3.PublicKey,
  globalConfig: web3.PublicKey,
  globalGameState: web3.PublicKey,
  totalCompletedReveals: BN,
  nextPositionId: BN,
  activeBullCount: BN,
  totalActiveBullPower: BN,
): web3.TransactionInstruction {
  const data = Buffer.concat([
    discriminator("test_fixture_set_global_game_state"),
    u64LE(totalCompletedReveals),
    u64LE(nextPositionId),
    u64LE(activeBullCount),
    u64LE(totalActiveBullPower),
  ]);
  return new web3.TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: globalGameState, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

export function buildTestFixtureSetRewardStateIx(
  authority: web3.PublicKey,
  globalConfig: web3.PublicKey,
  rewardState: web3.PublicKey,
  recognizedRewardBalanceAtomic: BN,
): web3.TransactionInstruction {
  const data = Buffer.concat([
    discriminator("test_fixture_set_reward_state"),
    u64LE(recognizedRewardBalanceAtomic),
  ]);
  return new web3.TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: rewardState, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

export function buildTestFixtureSetBullRegistryIx(
  authority: web3.PublicKey,
  globalConfig: web3.PublicKey,
  bullRegistry: web3.PublicKey,
  ownerTreeRoot: Buffer,
  totalBullCount: BN,
  totalBuckPower: BN,
  registryVersion: BN,
): web3.TransactionInstruction {
  if (ownerTreeRoot.length !== 32) {
    throw new Error("ownerTreeRoot must be 32 bytes");
  }
  const data = Buffer.concat([
    discriminator("test_fixture_set_bull_registry"),
    ownerTreeRoot,
    u64LE(totalBullCount),
    u64LE(totalBuckPower),
    u64LE(registryVersion),
  ]);
  return new web3.TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: bullRegistry, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

export function buildTestFixtureCreateReceiptFunderIx(
  authority: web3.PublicKey,
  position: web3.PublicKey,
  funder: web3.PublicKey,
  fundingLamports: BN,
): web3.TransactionInstruction {
  const data = Buffer.concat([
    discriminator("test_fixture_create_receipt_funder"),
    u64LE(fundingLamports),
  ]);
  return new web3.TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: false },
      { pubkey: funder, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

export function buildTestFixtureCloseReceiptFunderIx(
  authority: web3.PublicKey,
  position: web3.PublicKey,
  funder: web3.PublicKey,
  beneficiary: web3.PublicKey,
): web3.TransactionInstruction {
  const data = discriminator("test_fixture_close_receipt_funder");
  return new web3.TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: false },
      { pubkey: funder, isSigner: false, isWritable: true },
      { pubkey: beneficiary, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

export function buildTestFixtureForceTransferPositionReceiptInCollectionIx(
  authority: web3.PublicKey,
  globalConfig: web3.PublicKey,
  position: web3.PublicKey,
  receiptAsset: web3.PublicKey,
  collection: web3.PublicKey,
  receiptAuthority: web3.PublicKey,
  newOwner: web3.PublicKey,
): web3.TransactionInstruction {
  const data = Buffer.concat([
    discriminator("test_fixture_force_transfer_position_receipt_in_collection"),
    newOwner.toBuffer(),
  ]);
  return new web3.TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: false },
      { pubkey: receiptAsset, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: receiptAuthority, isSigner: false, isWritable: false },
      { pubkey: newOwner, isSigner: false, isWritable: false },
      { pubkey: new web3.PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"), isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}
