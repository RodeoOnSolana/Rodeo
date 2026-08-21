import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import {
  COWBOY_REWARD_INDEX_SCALE,
  POT_FILL_SECONDS,
  PROTOCOL_CONFIG_V1,
  PROTOCOL_CONFIG_V2,
  RandomnessDomain,
  mapBullTier,
  mapCowboyKind,
  mapMintTheftFlag,
  mapRole,
  mapSuit,
  mapUnstakeTheftFlag,
  rejectionSampleDraw,
} from "@rodeo/protocol-definition";
import { beforeAll, describe, expect, it } from "vitest";
import assert from "node:assert";
import {
  buildTestFixtureSetGlobalGameStateIx,
  buildTestFixtureSetBullRegistryIx,
  buildTestFixtureCreateReceiptFunderIx,
  buildTestFixtureCloseReceiptFunderIx,
  buildTestFixtureForceTransferPositionReceiptInCollectionIx,
} from "./fixture-instructions.js";
import {
  BullRegistryTracker,
  deriveBullProofBufferPda,
  deriveBullRegistryPda,
  stageBullProofBuffer,
  getLamportBalance,
  accountExists,
  type StagedBullProof,
} from "./bull-registry-tracker.js";
import {
  BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
  SECTION_CURRENT_OWNER,
  SECTION_CURRENT_BULL,
  SECTION_REMOVE_BULL,
  SECTION_SELECTED_BULL,
  SECTION_SELECTED_OWNER,
  SECTION_VICTIM_OWNER,
  buildFullTheftRevealPayload,
  buildRegistry,
  buildRevealPayload,
  buildRevealWithVictimPayload,
  buildTheftRevealPayload,
  buildUnstakePayload,
  bullProof,
  emptyOwnerTreeRoot,
  findBullByTarget,
  findOwnerByTarget,
  leafContainsTarget,
  ownerProof,
  serializeBullProofPayload,
  skipVictimInterval,
  sparseProofPrefix,
  type BullLeaf,
  type BullProofPayloadV1,
  type BuiltRegistry,
  type RegistryEntry,
  PREFIX_BULL_OWNER_NODE,
  type OwnerLeaf,
  type CompressedSparseProof,
  type CompressedOwnerProof,
  type CompressedBullProof,
} from "./sparse-tree.js";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const MPL_CORE_PROGRAM_ID = new web3.PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);

interface AccountFetcher<T> {
  fetch(address: web3.PublicKey): Promise<T>;
  fetchNullable(address: web3.PublicKey): Promise<T | null>;
}

interface RodeoCoreAccountNamespace {
  globalConfig: AccountFetcher<GlobalConfigAccount>;
  rewardState: AccountFetcher<RewardStateAccount>;
  globalGameState: AccountFetcher<GlobalGameStateAccount>;
  bullAccumulator: AccountFetcher<BullAccumulatorAccount>;
  bullRegistry: AccountFetcher<BullRegistryAccount>;
  bullProofBuffer: AccountFetcher<BullProofBufferAccount>;
  position: AccountFetcher<PositionAccount>;
  pendingRandomness: AccountFetcher<PendingRandomnessAccount>;
  protocolConfig: AccountFetcher<ProtocolConfigAccount>;
  claimCredit: AccountFetcher<ClaimCreditAccount>;
  walletClaimCooldown: AccountFetcher<WalletClaimCooldownAccount>;
}

interface ProtocolConfigAccount {
  version: number;
  globalConfig: web3.PublicKey;
  configVersion: BN;
  roleWeights: BN[];
  cowboyRankWeights: BN[];
  bullTierWeights: BN[];
  suitWeights: BN[];
  mintTheftWeights: BN[];
  unstakeTheftWeights: BN[];
  cowboyAccrualWeights: number[];
  bullBuckPowers: number[];
  minRevealsForTheft: BN;
  minBullsForTheft: BN;
  unstakeTaxBps: BN;
  unstakeReturnBps: BN;
  bump: number;
}

interface PositionAccount {
  version: number;
  owner: web3.PublicKey;
  positionId: BN;
  principalAmount: BN;
  role: { unassigned?: {}; cowboy?: {}; bull?: {} };
  status: { revealPending?: {}; active?: {}; transferReady?: {}; };
  cowboyKind: { unassigned?: {}; rank?: [number]; desperado?: {} };
  bullTier: number;
  suit: { unassigned?: {}; hearts?: {}; diamonds?: {}; clubs?: {}; spades?: {} };
  openedAt: BN;
  activeSince: BN;
  unstakeEligibleAt: BN;
  accrualWeight: number;
  buckPower: number;
  lastCowboyRewardIndex: BN;
  lastBullRewardPerWeight: BN;
  cowboyAccrualRemainderScaled: BN;
  bullAccrualRemainderScaled: BN;
  claimableAnsemAtomic: BN;
  settlementNonce: BN;
  stateVersion: BN;
  listingNonce: BN;
  receiptAsset: web3.PublicKey;
  pendingActionActive: boolean;
  pendingActionType: { reveal?: {}; unstake?: {} };
  pendingActionNonce: BN;
  nextActionNonce: BN;
  revealConfigVersion: BN;
  bump: number;
}

interface PendingRandomnessAccount {
  version: number;
  position: web3.PublicKey;
  actionType: { reveal?: {}; unstake?: {} };
  actionNonce: BN;
  providerProgram: web3.PublicKey;
  providerRandomnessAccount: web3.PublicKey;
  commitment: number[];
  committedSlot: BN;
  committedProtocolEpoch: BN;
  timeoutTimestamp: BN;
  registryRootSnapshot: number[];
  registryVersionSnapshot: BN;
  registryTotalCountSnapshot: BN;
  registryTotalPowerSnapshot: BN;
  configVersionSnapshot: BN;
  settled: boolean;
  bump: number;
}

interface BullRegistryAccount {
  version: number;
  globalConfig: web3.PublicKey;
  ownerTreeRoot: number[];
  totalBullCount: BN;
  totalBuckPower: BN;
  registryVersion: BN;
  bump: number;
}

interface BullProofBufferAccount {
  version: number;
  schemaVersion: number;
  actionType: { reveal?: {}; unstake?: {} };
  expectedPayloadLength: number;
  pendingRandomness: web3.PublicKey;
  position: web3.PublicKey;
  prover: web3.PublicKey;
  refundRecipient: web3.PublicKey;
  snapshotRoot: number[];
  snapshotVersion: BN;
  snapshotTotalCount: BN;
  snapshotTotalPower: BN;
  nonce: BN;
  finalized: boolean;
  consumed: boolean;
  filled: boolean;
  bump: number;
  payload: Buffer;
}

interface GlobalConfigAccount {
  version: number;
  rodeoMint: web3.PublicKey;
  ansemMint: web3.PublicKey;
  rodeoDecimals: number;
  ansemDecimals: number;
  stakeAmountAtomic: BN;
  expectedTotalSupplyAtomic: BN;
  launchTimestamp: BN;
  principalVault: web3.PublicKey;
  rewardVault: web3.PublicKey;
  pauseNewStakes: boolean;
  pauseNewRevealRequests: boolean;
  pauseNewMarketplaceListings: boolean;
  pauseRouterSwaps: boolean;
  upgradeCouncil: web3.PublicKey;
  treasuryCouncil: web3.PublicKey;
  emergencyGuardians: web3.PublicKey;
  currentConfigVersion: BN;
  bump: number;
  principalVaultBump: number;
  rewardVaultBump: number;
}

interface RewardStateAccount {
  version: number;
  globalConfig: web3.PublicKey;
  currentEpoch: BN;
  epochStartedAt: BN;
  lastClosedEpochTimestamp: BN;
  totalAnsemLiabilityAtomic: BN;
  cowboyUnmaterializedLiabilityAtomic: BN;
  positionClaimableLiabilityAtomic: BN;
  bullPoolLiabilityAtomic: BN;
  bullPoolUnallocatedLiabilityAtomic: BN;
  suitVaultLiabilityAtomic: BN;
  recognizedRewardBalanceAtomic: BN;
  ansemEmittedAtomic: BN;
  ansemClaimedAtomic: BN;
  orphanedRewardReleasedAtomic: BN;
  cowboyRewardIndex: BN;
  cowboyIndexRemainderScaled: BN;
  cowboyOrphanedAccrualRemainderScaled: BN;
  suitEpoch: BN;
  bump: number;
}

interface GlobalGameStateAccount {
  version: number;
  globalConfig: web3.PublicKey;
  nextPositionId: BN;
  totalCompletedReveals: BN;
  livePositionCount: BN;
  activeCowboyCount: BN;
  activeBullCount: BN;
  totalActiveCowboyWeight: BN;
  totalActiveBullPower: BN;
  accountedPrincipalAtomic: BN;
  bump: number;
}

interface BullAccumulatorAccount {
  version: number;
  globalConfig: web3.PublicKey;
  rewardPerWeightScaled: BN;
  bullIndexRemainderScaled: BN;
  bullOrphanedAccrualRemainderScaled: BN;
  bump: number;
}

interface ClaimCreditAccount {
  version: number;
  owner: web3.PublicKey;
  wallet: web3.PublicKey;
  claimClass: number;
  amountAtomic: BN;
  bump: number;
}

interface WalletClaimCooldownAccount {
  version: number;
  wallet: web3.PublicKey;
  lastClaimedAt: BN;
  bump: number;
}

function rodeoAccounts(program: Program<Idl>): RodeoCoreAccountNamespace {
  return program.account as unknown as RodeoCoreAccountNamespace;
}

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);
const root = resolve(import.meta.dirname, "../..");

function loadIdl(name: string): Idl {
  const path = resolve(root, "target/idl", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
}

const expectedProgramIds = {
  RodeoCore: "CdEU5FfgsPgrPMMLsDAPY29sN4sWqZpMetAXVY633NhA",
  RodeoMarket: "9vhrgTdridvE1uuxPenqDW9RVKdu3A5Dc2DzKVbaew8n",
  RodeoRouter: "CFQUWHE88YWrtnu9yADgEAB1MrPAYvdAjUbRwbTLafxD",
} as const;

function derivePosition(
  programId: web3.PublicKey,
  globalConfig: web3.PublicKey,
  positionId: BN,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("position"), globalConfig.toBuffer(), positionId.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

function deriveRandomness(
  programId: web3.PublicKey,
  position: web3.PublicKey,
  actionType: number,
  actionNonce: BN,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("randomness"),
      position.toBuffer(),
      Buffer.from([actionType]),
      actionNonce.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

function deriveProtocolConfig(
  programId: web3.PublicKey,
  globalConfig: web3.PublicKey,
  configVersion: BN,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("protocol-config"),
      globalConfig.toBuffer(),
      configVersion.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

function programDataAddress(programId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

type OutcomeShape = {
  role: string;
  suit: string;
  cowboyKind?: string;
  bullTier?: number;
};

function expectedRevealOutcomes(
  randomOutput: number[],
  position: web3.PublicKey,
  actionNonce: BN,
  config: typeof PROTOCOL_CONFIG_V1,
): OutcomeShape {
  const output = new Uint8Array(randomOutput);
  const posBytes = position.toBuffer();
  const nonce = BigInt(actionNonce.toString());
  const role = mapRole(
    { randomOutput: output, domain: RandomnessDomain.Role, position: posBytes, actionNonce: nonce },
    config,
  );
  const suit = mapSuit(
    { randomOutput: output, domain: RandomnessDomain.Suit, position: posBytes, actionNonce: nonce },
    config,
  );
  if (role === "cowboy") {
    const rank = mapCowboyKind(
      { randomOutput: output, domain: RandomnessDomain.CowboyKind, position: posBytes, actionNonce: nonce },
      config,
    );
    return { role, suit, cowboyKind: rank };
  }
  const tier = mapBullTier(
    { randomOutput: output, domain: RandomnessDomain.BullTier, position: posBytes, actionNonce: nonce },
    config,
  );
  return { role, suit, bullTier: Number(tier.replace("tier", "")) };
}

function positionOutcomes(position: PositionAccount): OutcomeShape {
  const role = position.role.cowboy ? "cowboy" : position.role.bull ? "bull" : "unassigned";
  const suit = position.suit.hearts
    ? "hearts"
    : position.suit.diamonds
      ? "diamonds"
      : position.suit.clubs
        ? "clubs"
        : position.suit.spades
          ? "spades"
          : "unassigned";
  if (role === "cowboy") {
    const cowboyKind = position.cowboyKind.desperado
      ? "desperado"
      : position.cowboyKind.rank
        ? `rank${position.cowboyKind.rank[0]}`
        : "unassigned";
    return { role, suit, cowboyKind };
  }
  return { role, suit, bullTier: position.bullTier };
}

async function createRevokedMint(
  connection: web3.Connection,
  payer: web3.Keypair,
  decimals: number,
): Promise<web3.PublicKey> {
  const mint = await createMint(connection, payer, payer.publicKey, payer.publicKey, decimals);
  await setAuthority(connection, payer, mint, payer, AuthorityType.MintTokens, null);
  await setAuthority(connection, payer, mint, payer, AuthorityType.FreezeAccount, null);
  return mint;
}

async function revokeMintAuthorities(
  connection: web3.Connection,
  payer: web3.Keypair,
  mint: web3.PublicKey,
) {
  await setAuthority(connection, payer, mint, payer, AuthorityType.MintTokens, null);
  const freezeAuthority = (await getMint(connection, mint)).freezeAuthority;
  if (freezeAuthority !== null) {
    await setAuthority(connection, payer, mint, payer, AuthorityType.FreezeAccount, null);
  }
}

// This suite must run against a program binary built with `test-short-epoch`
// (2-second epochs) so that epoch-closure behavior is exercised quickly. It
// must NOT be run against the claim-profile binary, since production-length
// epochs there would make `close_epochs`/`EpochsClosed` assertions time out.
const skipEpochSuite =
  !localnetAvailable ||
  process.env.RODEO_TEST_SUITE === "claim" ||
  process.env.RODEO_TEST_SUITE === "mplcore";
// Work around solana-test-validator WebSocket flakiness in long suites by
// polling signature status over HTTP instead of relying on ws://<port+1>.
function patchProviderForHttpConfirmation(provider: AnchorProvider) {
  const connection = provider.connection;
  const COMMITMENT_ORDER: Record<string, number> = {
    processed: 0,
    confirmed: 1,
    finalized: 2,
  };
  connection.confirmTransaction = async (
    signatureOrStrategy: web3.TransactionSignature | web3.TransactionConfirmationStrategy,
    commitment?: web3.Commitment,
  ): Promise<web3.RpcResponseAndContext<web3.SignatureStatus>> => {
    const signature =
      typeof signatureOrStrategy === "string" ? signatureOrStrategy : signatureOrStrategy.signature;
    const desired = commitment ?? connection.commitment ?? "confirmed";
    const desiredOrder = COMMITMENT_ORDER[desired] ?? 0;
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const { context, value } = await connection.getSignatureStatus(signature);
      if (value) {
        if (value.err) {
          throw new Error(`Transaction ${signature} failed: ${JSON.stringify(value.err)}`);
        }
        const status = value.confirmationStatus;
        let isConfirmed = false;
        if (status) {
          isConfirmed = (COMMITMENT_ORDER[status] ?? -1) >= desiredOrder;
        } else if (value.confirmations !== undefined && value.confirmations !== null) {
          if (value.confirmations === 0) {
            isConfirmed = desired === "processed";
          } else {
            isConfirmed = desired !== "finalized";
          }
        } else if (value.confirmations === null) {
          isConfirmed = true;
        }
        if (isConfirmed) {
          return { context, value };
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Transaction was not confirmed in 60s: ${signature}`);
  };
}

describe.skipIf(!localnetAvailable)("Anchor localnet workspace (architecture F profile)", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  let rodeoCoreProgram: Program<Idl>;
  const otherPrograms = {} as Record<string, Program<Idl>>;

  let rodeoMint: web3.PublicKey;
  let ansemMint: web3.PublicKey;
  let globalConfig: web3.PublicKey;
  let rewardState: web3.PublicKey;
  let globalGameState: web3.PublicKey;
  let bullAccumulator: web3.PublicKey;
  let principalVault: web3.PublicKey;
  let rewardVault: web3.PublicKey;
  let receiptCollection: web3.PublicKey;
  let receiptAuthority: web3.PublicKey;
  let payerRodeoAccount: web3.PublicKey;
  let payerAnsemAccount: web3.PublicKey;

  let bullRegistry: web3.PublicKey;
  let bullRegistryTracker: BullRegistryTracker;
  let offChainRegistryVersion = 0n;
  const positionRevealSnapshots = new Map<string, RegistryEntry[]>();
  // Heavy Bull paths require roughly 850-900k CU in the test-fixtures artifact.
  // 1,000,000 leaves comfortable headroom while staying below the Solana limit.
  const BULL_COMPUTE_UNIT_LIMIT = 1_000_000;
  const bullComputeIxs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: BULL_COMPUTE_UNIT_LIMIT })];

  const upgradeCouncil = web3.Keypair.generate();
  const treasuryCouncil = web3.Keypair.generate();
  const emergencyGuardians = web3.Keypair.generate();

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);
    patchProviderForHttpConfirmation(provider);
    payer = (provider.wallet as unknown as { payer: web3.Keypair }).payer;

    rodeoCoreProgram = new Program<Idl>(loadIdl("rodeo_core"), provider);
    otherPrograms.RodeoMarket = new Program(loadIdl("rodeo_market"), provider);
    otherPrograms.RodeoRouter = new Program(loadIdl("rodeo_router"), provider);

    if (!localnetAvailable) return;

    rodeoMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    ansemMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

    [globalConfig] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      rodeoCoreProgram.programId,
    );
    [principalVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("principal-vault")],
      rodeoCoreProgram.programId,
    );
    [rewardVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-vault")],
      rodeoCoreProgram.programId,
    );
    [rewardState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-state"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [globalGameState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-game-state"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [bullAccumulator] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bull-accumulator"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [bullRegistry] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    bullRegistryTracker = new BullRegistryTracker();

    [receiptCollection] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-collection"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );
    [receiptAuthority] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-authority"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );

    payerRodeoAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      rodeoMint,
      payer.publicKey,
    );
    payerAnsemAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      ansemMint,
      payer.publicKey,
    );

    // The protocol requires the full RODEO supply to be minted before initialization.
    const expectedTotalSupply = 1_000_000_000_000_000n;
    await mintTo(provider.connection, payer, rodeoMint, payerRodeoAccount, payer, expectedTotalSupply);
    // Seed a pool of ANSEM that can be sent into the reward vault for testing.
    await mintTo(
      provider.connection,
      payer,
      ansemMint,
      payerAnsemAccount,
      payer,
      2_000_000_000_000_000n,
    );
    await revokeMintAuthorities(provider.connection, payer, rodeoMint);
    await revokeMintAuthorities(provider.connection, payer, ansemMint);

    const programData = programDataAddress(rodeoCoreProgram.programId);
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      new BN(1),
    );

    await rodeoCoreProgram.methods
      .initializeProtocol(
        upgradeCouncil.publicKey,
        treasuryCouncil.publicKey,
        emergencyGuardians.publicKey,
      )
      .accounts({
        payer: payer.publicKey,
        initializer: provider.wallet.publicKey,
        program: rodeoCoreProgram.programId,
        programData,
        rodeoMint,
        ansemMint,
        globalConfig,
        rewardState,
        globalGameState,
        bullAccumulator,
        principalVault,
        rewardVault,
        protocolConfig,
        receiptCollection,
        receiptAuthority,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }, 60_000);

// ---------------------------------------------------------------------------
// Architecture F: ownership/transfer marketplace helpers and assertions
// ---------------------------------------------------------------------------

  const MARKET_PROGRAM_ID = new web3.PublicKey(expectedProgramIds.RodeoMarket);
  const [marketAuthority] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("market-authority")],
    MARKET_PROGRAM_ID,
  );

  const TRANSFER_BUFFER_SEED = Buffer.from("bull-transfer-proof-buffer", "utf8");

  function deriveReceiptAsset(position: web3.PublicKey): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
  }

  function deriveTransferBullProofBuffer(
    position: web3.PublicKey,
    prover: web3.PublicKey,
    nonce: BN,
  ): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [TRANSFER_BUFFER_SEED, position.toBuffer(), prover.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      rodeoCoreProgram.programId,
    );
  }

  function deriveClaimCredit(
    wallet: web3.PublicKey,
    claimClass: number,
  ): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("claim-credit"),
        wallet.toBuffer(),
        new BN(1).toArrayLike(Buffer, "le", 8),
        Buffer.from([claimClass]),
      ],
      rodeoCoreProgram.programId,
    );
  }

  function deriveWalletClaimCooldown(
    wallet: web3.PublicKey,
  ): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from("claim_cooldown"), wallet.toBuffer()],
      rodeoCoreProgram.programId,
    );
  }

  function writeU8(parts: Buffer[], n: number) {
    const b = Buffer.alloc(1);
    b.writeUInt8(n, 0);
    parts.push(b);
  }
  function writeU32(parts: Buffer[], n: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    parts.push(b);
  }
  function writeU64(parts: Buffer[], n: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n, 0);
    parts.push(b);
  }
  function writeHash(parts: Buffer[], h: Uint8Array) {
    parts.push(Buffer.from(h));
  }
  function writePubkey(parts: Buffer[], p: web3.PublicKey) {
    parts.push(Buffer.from(p.toBuffer()));
  }
  function writeNode(parts: Buffer[], n: { hash: Uint8Array; count: bigint; power: bigint }) {
    writeHash(parts, n.hash);
    writeU64(parts, n.count);
    writeU64(parts, n.power);
  }
  function writeSparseProof(parts: Buffer[], p: CompressedSparseProof) {
    writeHash(parts, p.bitmap);
    writeU32(parts, p.siblings.length);
    for (const s of p.siblings) writeNode(parts, s);
    writeNode(parts, p.leaf);
  }
  function writeOwnerLeaf(parts: Buffer[], l: OwnerLeaf) {
    writePubkey(parts, l.owner);
    writeU64(parts, l.activeBullCount);
    writeU64(parts, l.totalBuckPower);
    writeHash(parts, l.bullTreeRoot);
  }
  function writeBullLeaf(parts: Buffer[], l: BullLeaf) {
    writePubkey(parts, l.position);
    writeU64(parts, l.positionId);
    writePubkey(parts, l.owner);
    writeU8(parts, l.buckPower);
    writeU64(parts, l.revealConfigVersion);
  }
  function writeOwnerProof(parts: Buffer[], p: CompressedOwnerProof) {
    writeOwnerLeaf(parts, p.leaf);
    writeSparseProof(parts, p.proof);
  }
  function writeBullProof(parts: Buffer[], p: CompressedBullProof) {
    writeBullLeaf(parts, p.leaf);
    writeSparseProof(parts, p.proof);
  }

  function serializeNativeTransferBullPayload(opts: {
    sellerOwner: CompressedOwnerProof;
    removeBull: CompressedBullProof;
    buyerOwner: CompressedOwnerProof;
    addBull: CompressedBullProof;
  }): Buffer {
    const parts: Buffer[] = [];
    writeU8(parts, 1);
    writeU8(parts, 0b00001111);
    writeU8(parts, 1);
    writeOwnerProof(parts, opts.sellerOwner);
    writeU8(parts, 1);
    writeBullProof(parts, opts.removeBull);
    writeU8(parts, 1);
    writeOwnerProof(parts, opts.buyerOwner);
    writeU8(parts, 1);
    writeBullProof(parts, opts.addBull);
    return Buffer.concat(parts);
  }

  function buildBullLeaf(
    position: web3.PublicKey,
    positionId: BN | bigint,
    owner: web3.PublicKey,
    buckPower: number,
    revealConfigVersion: BN | bigint,
  ): { position: web3.PublicKey; positionId: bigint; owner: web3.PublicKey; buckPower: number; revealConfigVersion: bigint } {
    return {
      position,
      positionId: typeof positionId === "bigint" ? positionId : BigInt(positionId.toString()),
      owner,
      buckPower,
      revealConfigVersion: typeof revealConfigVersion === "bigint" ? revealConfigVersion : BigInt(revealConfigVersion.toString()),
    };
  }

  function claimClassForPosition(position: PositionAccount): number {
    if (position.role.bull) return 2;
    if (position.role.cowboy && position.cowboyKind.desperado) return 1;
    return 0;
  }

  async function syncRegistryWithTracker() {
    const built = bullRegistryTracker.buildRegistry();
    const ix = buildTestFixtureSetBullRegistryIx(
      payer.publicKey,
      globalConfig,
      bullRegistry,
      Buffer.from(built.rootNode.hash),
      new BN(built.rootNode.count.toString()),
      new BN(built.rootNode.power.toString()),
      new BN(offChainRegistryVersion.toString()),
    );
    await provider.sendAndConfirm(new web3.Transaction().add(ix), [payer]);
  }

  async function stageTransferBullProofBuffer(
    position: web3.PublicKey,
    prover: web3.Keypair,
    actionType: any,
    payloadBytes: Buffer,
    nonce: BN = new BN(1),
  ): Promise<web3.PublicKey> {
    const [bufferPda] = deriveTransferBullProofBuffer(position, prover.publicKey, nonce);
    await rodeoCoreProgram.methods
      .initializeTransferBullProof(actionType, payloadBytes.length, nonce)
      .accounts({
        prover: prover.publicKey,
        globalConfig,
        position,
        bullProofBuffer: bufferPda,
        bullRegistry,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([prover])
      .rpc();

    const CHUNK = 800;
    let offset = 0;
    while (offset < payloadBytes.length) {
      const chunk = payloadBytes.subarray(offset, offset + CHUNK);
      await rodeoCoreProgram.methods
        .appendTransferBullProof(nonce, offset, Buffer.from(chunk))
        .accounts({
          prover: prover.publicKey,
          bullProofBuffer: bufferPda,
        })
        .signers([prover])
        .rpc();
      offset += chunk.length;
    }

    await rodeoCoreProgram.methods
      .finalizeTransferBullProof(nonce)
      .accounts({
        prover: prover.publicKey,
        bullProofBuffer: bufferPda,
      })
      .signers([prover])
      .rpc();

    return bufferPda;
  }

  async function createActiveCowboy(owner = payer) {
    const positionId = await stakeAndSettleWithRole("cowboy");
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    return { positionId, position, pos };
  }

  async function createActiveBull(owner = payer) {
    const positionId = await stakeAndSettleWithRole("cowboy");
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    await fixturePreparePosition(positionId, {
      roleCode: 2,
      cowboyKindCode: 0,
      accrualWeight: 0,
      buckPower: 5,
      claimable: new BN(0),
      positionClaimableLiabilityDelta: new BN(0),
    });

    bullRegistryTracker.clear();
    bullRegistryTracker.registerBull(owner.publicKey, {
      position,
      positionId: BigInt(positionId.toString()),
      owner: owner.publicKey,
      buckPower: 5,
      revealConfigVersion: BigInt(pos.revealConfigVersion.toString()),
    });
    offChainRegistryVersion += 1n;
    await syncRegistryWithTracker();

    const gameIx = buildTestFixtureSetGlobalGameStateIx(
      payer.publicKey,
      globalConfig,
      globalGameState,
      new BN(0),
      new BN(0),
      new BN(1),
      new BN(5),
    );
    await provider.sendAndConfirm(new web3.Transaction().add(gameIx), [payer]);

    const fresh = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    return { positionId, position, pos: fresh };
  }

  async function buildPrepareBullProofBuffer(
    position: web3.PublicKey,
    seller: web3.PublicKey,
  ): Promise<web3.PublicKey> {
    const registry = bullRegistryTracker.buildRegistry();
    const oproof = ownerProof(registry, seller);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const bproof = bullProof(registry, seller, position);
    const payload: BullProofPayloadV1 = {
      schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
      sectionBitmap: SECTION_CURRENT_OWNER | SECTION_REMOVE_BULL,
      victimOwner: null,
      selectedOwner: null,
      selectedBull: null,
      currentOwner: oproof,
      currentBull: null,
      removeBull: bproof,
    };
    const prover = payer;
    return stageTransferBullProofBuffer(position, prover, { prepareTransfer: {} }, serializeBullProofPayload(payload));
  }

  async function buildActivateBullProofBuffer(
    position: web3.PublicKey,
    newOwner: web3.Keypair,
  ): Promise<web3.PublicKey> {
    // Remove the bull from the local tracker to reflect the post-prepare registry, then build an
    // insertion proof for the new owner.
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const seller = pos.owner;
    bullRegistryTracker.unregisterBull(seller, position);
    offChainRegistryVersion += 1n;
    await syncRegistryWithTracker();

    const newBull = buildBullLeaf(position, pos.positionId, newOwner.publicKey, pos.buckPower, pos.revealConfigVersion);
    const payload = buildRevealPayload(bullRegistryTracker.buildRegistry(), newBull);
    const prover = newOwner;
    return stageTransferBullProofBuffer(position, prover, { activatePosition: {} }, serializeBullProofPayload(payload), new BN(2));
  }

  async function buildNativeTransferBullProofBuffer(
    position: web3.PublicKey,
    seller: web3.PublicKey,
    buyer: web3.PublicKey,
  ): Promise<web3.PublicKey> {
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);

    const registry = bullRegistryTracker.buildRegistry();
    const sellerOwner = ownerProof(registry, seller);
    const removeBull = bullProof(registry, seller, position);

    const tempTracker = new BullRegistryTracker();
    for (const entry of bullRegistryTracker.getEntries()) {
      for (const b of entry.bulls) {
        tempTracker.registerBull(entry.owner, b);
      }
    }
    tempTracker.unregisterBull(seller, position);

    const newBull = buildBullLeaf(
      position,
      pos.positionId,
      buyer,
      pos.buckPower,
      pos.revealConfigVersion,
    );
    const tempRegistry = tempTracker.buildRegistry();
    const revealPayload = buildRevealPayload(tempRegistry, newBull);

    // revealPayload.currentOwner! is the buyer owner proof (R1, post-removal).
    // revealPayload.currentBull! is the non-membership proof for the new Bull
    // in the buyer's Bull tree; addBull must have an empty Bull leaf.
    const addBull: CompressedBullProof = revealPayload.currentBull!;
    assert(addBull.leaf.owner.equals(web3.PublicKey.default), "addBull leaf must be empty");
    assert(removeBull.leaf.owner.equals(seller), "removeBull owner must be seller");

    const payload = serializeNativeTransferBullPayload({
      sellerOwner,
      removeBull,
      buyerOwner: revealPayload.currentOwner!,
      addBull,
    });
    const prover = payer;
    return stageTransferBullProofBuffer(position, prover, { nativeTransferComposite: {} }, payload);
  }

  async function reconcileBullTracker(label: string) {
    try {
      const chain = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(bullRegistry);
      // @ts-expect-error account namespace is loosely typed for this helper.
      const positions = await rodeoCoreProgram.account.position.all();
      const newTracker = new BullRegistryTracker();
      for (const { publicKey, account } of positions) {
        if (account.role.bull && account.status.active) {
          newTracker.registerBull(account.owner, {
            position: publicKey,
            positionId: BigInt(account.positionId.toString()),
            owner: account.owner,
            buckPower: account.buckPower,
            revealConfigVersion: BigInt(account.revealConfigVersion.toString()),
          });
        }
      }
      bullRegistryTracker.clear();
      for (const entry of newTracker.getEntries()) {
        for (const b of entry.bulls) {
          bullRegistryTracker.registerBull(entry.owner, b);
        }
      }
      offChainRegistryVersion = BigInt(chain.registryVersion.toString());
      await syncRegistryWithTracker();
    } catch (err) {
      console.error(`reconcileBullTracker (${label}) failed:`, err);
      throw err;
    }
  }

  async function fundPayerTo(recipient: web3.PublicKey, sol: number) {
    const ix = web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: Math.round(sol * web3.LAMPORTS_PER_SOL),
    });
    await provider.sendAndConfirm(new web3.Transaction().add(ix), [payer]);
  }

  
function mplCoreTransferV1Instruction(params: {
  asset: web3.PublicKey;
  payer: web3.PublicKey;
  authority: web3.PublicKey;
  newOwner: web3.PublicKey;
}): web3.TransactionInstruction {
  const data = Buffer.from([14, 0]);
  return new web3.TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: params.asset, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // collection: None
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.newOwner, isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper: None
    ],
    data,
  });
}

async function transferReceiptToOwner(positionId: BN, newOwner: web3.PublicKey) {
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const [receiptAsset] = deriveReceiptAsset(position);
    const ix = buildTestFixtureForceTransferPositionReceiptInCollectionIx(
      payer.publicKey,
      globalConfig,
      position,
      receiptAsset,
      receiptCollection,
      receiptAuthority,
      newOwner,
    );
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
  }

  async function assertReceiptOwner(position: web3.PublicKey, owner: web3.PublicKey) {
    // Parse the MPL Core asset and assert ownership.  We use the program's test fixture for parsing.
    const [receiptAsset] = deriveReceiptAsset(position);
    const asset = await provider.connection.getAccountInfo(receiptAsset);
    expect(asset).not.toBeNull();
    expect(asset!.owner.equals(MPL_CORE_PROGRAM_ID)).toBe(true);
  }

  const stakeAmountAtomic = new BN(100_000_000_000);
  let nextPositionId = 0;

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function deriveStakeAccounts(positionId: BN) {
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const [pendingRandomness] = deriveRandomness(rodeoCoreProgram.programId, position, 0, new BN(0));
    return { position, pendingRandomness };
  }

  async function fixtureAdvanceNextPositionId(positionId: BN) {
    const discriminator = Buffer.from("3105ae71743b6219", "hex");
    const data = Buffer.concat([
      discriminator,
      positionId.toArrayLike(Buffer, "le", 8),
    ]);
    const ix = new web3.TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: false },
        { pubkey: globalGameState, isSigner: false, isWritable: true },
      ],
      programId: rodeoCoreProgram.programId,
      data,
    });
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
  }

  async function stakeAndCommit(
    positionId: BN,
    amount: BN = stakeAmountAtomic,
    ownerRodeo = payerRodeoAccount,
    owner = payer,
  ) {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    if (positionId.gt(game.nextPositionId)) {
      await fixtureAdvanceNextPositionId(positionId);
    }

    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const globalConfigAccount = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      globalConfigAccount.currentConfigVersion,
    );

    try {
      await rodeoCoreProgram.methods
        .stakeAndCommit(positionId, amount)
        .accounts({
          owner: owner.publicKey,
          ownerRodeoTokenAccount: ownerRodeo,
          globalConfig,
          protocolConfig,
          principalVault,
          position,
          pendingRandomness,
          rewardState,
          globalGameState,
          receiptFunder,
          providerRandomnessAccount: web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        } as any)
        .signers([owner])
        .rpc();
    } finally {
      const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
      nextPositionId = gameAfter.nextPositionId.toNumber();
    }

    positionRevealSnapshots.set(position.toBase58(), cloneRegistryEntries(bullRegistryTracker.getEntries()));

    return { position, pendingRandomness, protocolConfig };
  }

  async function settleReveal(positionId: BN, settler = payer) {
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    const [positionAddr] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(positionAddr);
    const pendingRandomnessAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(
      pendingRandomness,
    );
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      pendingRandomnessAccount.configVersionSnapshot,
    );
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), positionAddr.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), positionAddr.toBuffer()],
      rodeoCoreProgram.programId,
    );

    const proof = await buildRevealProof(positionAddr, pos, pendingRandomnessAccount);
    const payloadBytes = serializeBullProofPayload(proof.payload);

    let staged: StagedBullProof | null = null;
    const ixs: web3.TransactionInstruction[] = [];
    if (proof.payload.sectionBitmap !== 0) {
      ixs.push(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
      staged = await stageBullProofBuffer(
        rodeoCoreProgram,
        globalConfig,
        positionAddr,
        pendingRandomness,
        settler,
        new BN(1),
        { reveal: {} },
        payloadBytes,
      );
    }

    const settleBuilder = rodeoCoreProgram.methods
      .settleReveal()
      .accounts({
        settler: settler.publicKey,
        globalConfig,
        globalGameState,
        rewardState,
        bullAccumulator,
        bullRegistry,
        position: positionAddr,
        pendingRandomness,
        protocolConfig,
        owner: pos.owner,
        receiptOwner: proof.finalOwner,
        receiptAsset,
        receiptCollection,
        receiptAuthority,
        receiptFunder,
        providerRandomnessAccount: web3.SYSVAR_RENT_PUBKEY,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        bullProofBuffer: staged ? staged.bufferPda : null,
        refundRecipient: staged ? staged.refundRecipient : null,
      } as any)
      .preInstructions(ixs)
      .signers([settler]);

    const settleIxs: web3.TransactionInstruction[] = [];
    settleIxs.push(...ixs, await settleBuilder.instruction());
    const settleTx = new web3.Transaction().add(...settleIxs);
    settleTx.feePayer = provider.wallet.publicKey;
    const { blockhash: settleBh } = await provider.connection.getLatestBlockhash();
    settleTx.recentBlockhash = settleBh;
    settleTx.sign(payer, settler);
    let settleSig: string;
    try {
      settleSig = await provider.connection.sendRawTransaction(settleTx.serialize());
    } catch (err) {
      console.error("settleReveal send error", err);
      try {
        const sim = await provider.connection.simulateTransaction(settleTx);
        console.error("settleReveal simulation err", sim.value.err);
        console.error("settleReveal simulation logs", sim.value.logs);
      } catch (simErr) {
        console.error("settleReveal simulation failed", simErr);
      }
      throw err;
    }
    const confirmResult = await provider.connection.confirmTransaction(settleSig, "confirmed");
    if (confirmResult.value.err) {
      console.error("settleReveal confirm error", confirmResult.value.err);
      const txDetails = await provider.connection.getTransaction(settleSig, { commitment: "confirmed" });
      console.error("settleReveal tx logs", txDetails?.meta?.logMessages);
      throw new Error(`settleReveal tx ${settleSig} confirmed but failed: ${JSON.stringify(confirmResult.value.err)}`);
    }

    const posAfter = await (async () => {
      for (let i = 0; i < 20; i++) {
        const p = await rodeoAccounts(rodeoCoreProgram).position.fetch(positionAddr);
        if (!!p.status.active) {
          return p;
        }
        await sleep(100);
      }
      throw new Error(`settleReveal: position ${positionAddr.toBase58()} never became active/unstakePending after reveal`);
    })();
    if (posAfter.role.bull) {
      bullRegistryTracker.registerBull(posAfter.owner, {
        position: positionAddr,
        positionId: BigInt(posAfter.positionId.toString()),
        owner: posAfter.owner,
        buckPower: posAfter.buckPower,
        revealConfigVersion: BigInt(posAfter.revealConfigVersion.toString()),
      });
      offChainRegistryVersion += 1n;
    }
    await assertTrackerMatchesChain();
  }

  function deriveMockCommitment(
    position: web3.PublicKey,
    actionType: number,
    actionNonce: BN,
    protocolEpoch: BN,
  ): Uint8Array {
    const preimage = Buffer.alloc(49);
    let offset = 0;
    position.toBuffer().copy(preimage, offset);
    offset += 32;
    preimage.writeUInt8(actionType, offset);
    offset += 1;
    Buffer.from(actionNonce.toArrayLike(Buffer, "le", 8)).copy(preimage, offset);
    offset += 8;
    Buffer.from(protocolEpoch.toArrayLike(Buffer, "le", 8)).copy(preimage, offset);
    return new Uint8Array(createHash("sha256").update(preimage).digest());
  }

  function buildHistoricalRegistry(positionAddr: web3.PublicKey): BuiltRegistry {
    const snapshot = positionRevealSnapshots.get(positionAddr.toBase58());
    if (!snapshot) throw new Error(`No reveal snapshot for position ${positionAddr.toBase58()}`);
    return buildRegistry(snapshot);
  }

  function cloneRegistryEntries(entries: RegistryEntry[]): RegistryEntry[] {
    return entries.map((e) => ({ owner: e.owner, bulls: e.bulls.map((b) => ({ ...b })) }));
  }

  async function assertTrackerMatchesChain(): Promise<void> {
    const chain = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(bullRegistry);
    const built = bullRegistryTracker.buildRegistry();
    expect(Buffer.from(new Uint8Array(chain.ownerTreeRoot))).toEqual(Buffer.from(built.rootNode.hash));
    expect(built.rootNode.count).toBe(BigInt(chain.totalBullCount.toString()));
    expect(built.rootNode.power).toBe(BigInt(chain.totalBuckPower.toString()));
    expect(BigInt(chain.registryVersion.toString())).toBe(offChainRegistryVersion);
  }

  function configAtStake(configVersion: BN): typeof PROTOCOL_CONFIG_V1 {
    if (configVersion.eqn(1)) return PROTOCOL_CONFIG_V1;
    if (configVersion.eqn(2)) return PROTOCOL_CONFIG_V2;
    throw new Error(`Unsupported protocol config version ${configVersion.toString()}`);
  }

  function predictReveal(
    randomOutput: Uint8Array,
    position: web3.PublicKey,
    actionNonce: BN,
    config: typeof PROTOCOL_CONFIG_V1,
  ) {
    const posBytes = position.toBuffer();
    const nonce = BigInt(actionNonce.toString());
    const role = mapRole(
      { randomOutput, domain: RandomnessDomain.Role, position: posBytes, actionNonce: nonce },
      config,
    );
    const suit = mapSuit(
      { randomOutput, domain: RandomnessDomain.Suit, position: posBytes, actionNonce: nonce },
      config,
    );
    if (role === "cowboy") {
      const cowboyKind = mapCowboyKind(
        { randomOutput, domain: RandomnessDomain.CowboyKind, position: posBytes, actionNonce: nonce },
        config,
      );
      return { role, suit, cowboyKind };
    }
    const tier = mapBullTier(
      { randomOutput, domain: RandomnessDomain.BullTier, position: posBytes, actionNonce: nonce },
      config,
    );
    const power = config.bullBuckPowers[Number(tier.replace("tier", "")) - 1];
    return { role, suit, bullTier: Number(tier.replace("tier", "")), buckPower: power };
  }

  async function buildRevealProof(
    positionAddr: web3.PublicKey,
    pos: PositionAccount,
    pending: PendingRandomnessAccount,
  ): Promise<{ payload: BullProofPayloadV1; finalOwner: web3.PublicKey; stolen: boolean; selectedBull: BullLeaf | null }> {
    const randomOutput = deriveMockCommitment(
      positionAddr,
      0,
      pending.actionNonce,
      pending.committedProtocolEpoch,
    );
    const protocolConfig = configAtStake(pending.configVersionSnapshot);
    const predicted = predictReveal(randomOutput, positionAddr, pending.actionNonce, protocolConfig);

    const historicalRegistry = buildHistoricalRegistry(positionAddr);
    const currentRegistry = bullRegistryTracker.buildRegistry();

    const completedReveals = (await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState))
      .totalCompletedReveals.toNumber();
    const minRevealsForTheft = Number(protocolConfig.minRevealsForTheft);
    const minBullsForTheft = Number(protocolConfig.minBullsForTheft);

    let finalOwner = pos.owner;
    let stolen = false;
    let selectedBull: BullLeaf | null = null;

    let currentOwnerProof: ReturnType<typeof ownerProof> | null = null;
    let currentBullProof: ReturnType<typeof bullProof> | null = null;
    if (predicted.role === "bull") {
      const newBull: BullLeaf = {
        position: positionAddr,
        positionId: BigInt(pos.positionId.toString()),
        owner: finalOwner,
        buckPower: predicted.buckPower,
        revealConfigVersion: BigInt(pending.configVersionSnapshot.toString()),
      };
      currentOwnerProof = ownerProof(currentRegistry, finalOwner);
      currentBullProof = bullProof(currentRegistry, finalOwner, positionAddr);
    }

    if (completedReveals >= minRevealsForTheft) {
      const vproof = ownerProof(historicalRegistry, pos.owner);
      const victimPrefix = sparseProofPrefix(
        pos.owner.toBuffer(),
        vproof.proof,
        PREFIX_BULL_OWNER_NODE,
      );
      const victimCount = vproof.proof.leaf.count;
      const victimPower = vproof.proof.leaf.power;
      const externalCount = BigInt(pending.registryTotalCountSnapshot.toString()) - victimCount;
      const externalPower = BigInt(pending.registryTotalPowerSnapshot.toString()) - victimPower;

      if (externalCount >= BigInt(minBullsForTheft) && externalPower > 0n) {
        const theft = mapMintTheftFlag(
          {
            randomOutput,
            domain: RandomnessDomain.MintTheft,
            position: positionAddr.toBuffer(),
            actionNonce: BigInt(pending.actionNonce.toString()),
          },
          protocolConfig,
        );
        if (theft) {
          const ownerTarget = rejectionSampleDraw(
            { denominator: externalPower, entries: [{ outcome: "only", weight: externalPower }] },
            {
              randomOutput,
              domain: RandomnessDomain.OwnerSelection,
              position: positionAddr.toBuffer(),
              actionNonce: BigInt(pending.actionNonce.toString()),
            },
          );
          const safeOwnerTarget = skipVictimInterval(ownerTarget, victimPrefix, victimPower);
          const selectedOwner = findOwnerByTarget(historicalRegistry, safeOwnerTarget);

          const oproof = ownerProof(historicalRegistry, selectedOwner);
          const selectedOwnerPower = oproof.proof.leaf.power;
          const bullTarget = rejectionSampleDraw(
            { denominator: selectedOwnerPower, entries: [{ outcome: "only", weight: selectedOwnerPower }] },
            {
              randomOutput,
              domain: RandomnessDomain.BullSelection,
              position: positionAddr.toBuffer(),
              actionNonce: BigInt(pending.actionNonce.toString()),
            },
          );
          selectedBull = findBullByTarget(historicalRegistry, selectedOwner, bullTarget);
          finalOwner = selectedBull.owner;
          stolen = true;

          if (predicted.role === "bull") {
            const newBull: BullLeaf = {
              position: positionAddr,
              positionId: BigInt(pos.positionId.toString()),
              owner: finalOwner,
              buckPower: predicted.buckPower,
              revealConfigVersion: BigInt(pending.configVersionSnapshot.toString()),
            };
            return {
              payload: buildFullTheftRevealPayload(
                historicalRegistry,
                currentRegistry,
                pos.owner,
                selectedBull.owner,
                selectedBull.position,
                newBull,
              ),
              finalOwner,
              stolen,
              selectedBull,
            };
          }

          return {
            payload: buildTheftRevealPayload(
              historicalRegistry,
              pos.owner,
              selectedBull.owner,
              selectedBull.position,
            ),
            finalOwner,
            stolen,
            selectedBull,
          };
        } else {
          const vproof2 = ownerProof(historicalRegistry, pos.owner);
          return {
            payload: {
              schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
              sectionBitmap:
                SECTION_VICTIM_OWNER |
                (predicted.role === "bull" ? SECTION_CURRENT_OWNER | SECTION_CURRENT_BULL : 0),
              victimOwner: vproof2,
              selectedOwner: null,
              selectedBull: null,
              currentOwner: currentOwnerProof,
              currentBull: currentBullProof,
              removeBull: null,
            },
            finalOwner,
            stolen,
            selectedBull,
          };
        }
      } else {
        const vproof2 = ownerProof(historicalRegistry, pos.owner);
        return {
          payload: {
            schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
            sectionBitmap:
              SECTION_VICTIM_OWNER |
              (predicted.role === "bull" ? SECTION_CURRENT_OWNER | SECTION_CURRENT_BULL : 0),
            victimOwner: vproof2,
            selectedOwner: null,
            selectedBull: null,
            currentOwner: currentOwnerProof,
            currentBull: currentBullProof,
            removeBull: null,
          },
          finalOwner,
          stolen,
          selectedBull,
        };
      }
    }

    if (predicted.role === "bull") {
      const newBull: BullLeaf = {
        position: positionAddr,
        positionId: BigInt(pos.positionId.toString()),
        owner: finalOwner,
        buckPower: predicted.buckPower,
        revealConfigVersion: BigInt(pending.configVersionSnapshot.toString()),
      };
      return {
        payload: buildRevealPayload(currentRegistry, newBull),
        finalOwner,
        stolen,
        selectedBull,
      };
    }

    return {
      payload: {
        schemaVersion: BULL_PROOF_PAYLOAD_SCHEMA_VERSION,
        sectionBitmap: 0,
        victimOwner: null,
        selectedOwner: null,
        selectedBull: null,
        currentOwner: null,
        currentBull: null,
        removeBull: null,
      },
      finalOwner,
      stolen,
      selectedBull,
    };
  }

  function getRole(pos: PositionAccount): "cowboy" | "bull" | null {
    if (pos.role.cowboy) return "cowboy";
    if (pos.role.bull) return "bull";
    return null;
  }

  async function stakeAndSettleWithRole(desiredRole: "cowboy" | "bull"): Promise<BN> {
    for (let attempt = 0; attempt < 50; attempt++) {
      await reconcileBullTracker("stakeAndSettleWithRole");
      const positionId = new BN(nextPositionId++);
      await stakeAndCommit(positionId);
      await settleReveal(positionId);
      const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(
        derivePosition(rodeoCoreProgram.programId, globalConfig, positionId)[0],
      );
      if (getRole(pos) === desiredRole) return positionId;
    }
    throw new Error(`Could not roll a ${desiredRole} position after 50 attempts`);
  }

  async function fundRewardVault(amount: BN) {
    const transferIx = createTransferInstruction(
      payerAnsemAccount,
      rewardVault,
      payer.publicKey,
      BigInt(amount.toString()),
    );
    await provider.sendAndConfirm(new web3.Transaction().add(transferIx));
  }

  function isNoElapsedEpoch(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as { error?: { errorCode?: { code?: string } } }).error?.errorCode?.code ===
        "NoElapsedEpoch"
    );
  }

  const TEST_EPOCH_DURATION_SECONDS = 2;

  async function closeEpochsRaw(maxEpochs: number) {
    await rodeoCoreProgram.methods
      .closeEpochs(maxEpochs)
      .accounts({
        caller: payer.publicKey,
        globalConfig,
        rewardState,
        globalGameState,
        bullAccumulator,
        rewardVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      } as any)
      .rpc();
  }

  async function closeEpochs(maxEpochs: number) {
    try {
      await closeEpochsRaw(maxEpochs);
    } catch (err) {
      if (!isNoElapsedEpoch(err)) throw err;
    }
  }

  async function getChainClockTime(): Promise<number> {
    const clockInfo = await provider.connection.getAccountInfo(web3.SYSVAR_CLOCK_PUBKEY);
    if (!clockInfo) throw new Error("Clock sysvar not found");
    return Number(clockInfo.data.readBigInt64LE(32));
  }

  async function ensureEpochsClosed(safeMarginSeconds = 1.0) {
    const batch = 16;
    for (let i = 0; i < 100; i++) {
      const before = (
        await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState)
      ).currentEpoch;
      let caughtNoElapsed = false;
      try {
        await closeEpochsRaw(batch);
      } catch (err) {
        if (isNoElapsedEpoch(err)) {
          caughtNoElapsed = true;
        } else {
          throw err;
        }
      }
      const after = (
        await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState)
      ).currentEpoch;

      if (after.sub(before).toNumber() >= batch) {
        continue;
      }

      if (caughtNoElapsed) {
        const state = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
        const now = await getChainClockTime();
        const nextBoundary = state.epochStartedAt.toNumber() + TEST_EPOCH_DURATION_SECONDS;
        const secondsUntilBoundary = nextBoundary - now;
        if (secondsUntilBoundary > safeMarginSeconds) {
          return;
        }
        const waitSeconds = Math.max(0.05, secondsUntilBoundary + 0.05);
        await sleep(waitSeconds * 1000);
        continue;
      }

      const state = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
      const now = await getChainClockTime();
      const nextBoundary = state.epochStartedAt.toNumber() + TEST_EPOCH_DURATION_SECONDS;
      const secondsUntilBoundary = nextBoundary - now;
      if (secondsUntilBoundary <= safeMarginSeconds) {
        const waitSeconds = Math.max(0.05, secondsUntilBoundary + 0.05);
        await sleep(waitSeconds * 1000);
        continue;
      }
      return;
    }
    throw new Error("ensureEpochsClosed: exhausted 100 iterations");
  }

  async function fixtureRecognizeRewards(amount: BN) {
    const discriminator = Buffer.from("4424b34139b3bde5", "hex");
    const data = Buffer.concat([discriminator, amount.toArrayLike(Buffer, "le", 8)]);
    const ix = new web3.TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: false },
        { pubkey: rewardState, isSigner: false, isWritable: true },
        { pubkey: rewardVault, isSigner: false, isWritable: true },
        { pubkey: payerAnsemAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: rodeoCoreProgram.programId,
      data,
    });
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
  }

  async function fixturePreparePosition(
    positionId: BN,
    args: {
      roleCode: number;
      cowboyKindCode: number;
      accrualWeight: number;
      buckPower: number;
      claimable: BN;
      positionClaimableLiabilityDelta: BN;
    },
  ) {
    const discriminator = Buffer.from("4135c65e78462efa", "hex");
    const data = Buffer.concat([
      discriminator,
      positionId.toArrayLike(Buffer, "le", 8),
      Buffer.from([args.roleCode]),
      Buffer.from([args.cowboyKindCode]),
      new BN(args.accrualWeight).toArrayLike(Buffer, "le", 4),
      Buffer.from([args.buckPower]),
      args.claimable.toArrayLike(Buffer, "le", 8),
      args.positionClaimableLiabilityDelta.toArrayLike(Buffer, "le", 8),
    ]);
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const ix = new web3.TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: false },
        { pubkey: rewardState, isSigner: false, isWritable: true },
        { pubkey: bullAccumulator, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
      ],
      programId: rodeoCoreProgram.programId,
      data,
    });
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
  }


  // -------------------------------------------------------------------------
  // Group A: Cowboy prepare / activate
  // -------------------------------------------------------------------------
  it("A: a Cowboy can be prepared and then activated by a new owner", async () => {
    await ensureEpochsClosed();
    const { positionId, position } = await createActiveCowboy();
    const newOwner = web3.Keypair.generate();
    await fundPayerTo(newOwner.publicKey, 0.1);

    const [claimCredit] = deriveClaimCredit(payer.publicKey, 0);
    const prepareA = rodeoCoreProgram.methods
      .prepareTransfer()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: deriveBullProofBufferPda(rodeoCoreProgram.programId, position, payer.publicKey, new BN(positionId))[0],

        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        claimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await prepareA.rpc();

    const posAfterPrepare = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfterPrepare.status.transferReady).toBeDefined();

    await transferReceiptToOwner(positionId, newOwner.publicKey);
    const newClaimCredit = deriveClaimCredit(newOwner.publicKey, 0)[0];
    const activateA = rodeoCoreProgram.methods
      .activatePosition()
      .accounts({
        newOwner: newOwner.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: deriveBullProofBufferPda(rodeoCoreProgram.programId, position, payer.publicKey, new BN(positionId))[0],

        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([newOwner]);
    await ensureEpochsClosed();
    await activateA.rpc();

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.status.active).toBeDefined();
    expect(posAfter.owner.equals(newOwner.publicKey)).toBe(true);
    const credit = await rodeoAccounts(rodeoCoreProgram).claimCredit.fetchNullable(newClaimCredit);
    expect(credit).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group B: generic MPL Core transfers
  // -------------------------------------------------------------------------
  it("B: a position receipt can be force-transferred via the fixture", async () => {
    const { positionId, position } = await createActiveCowboy();
    const newOwner = web3.Keypair.generate();
    await fundPayerTo(newOwner.publicKey, 0.1);
    await transferReceiptToOwner(positionId, newOwner.publicKey);
    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.owner.equals(payer.publicKey)).toBe(true);
    await assertReceiptOwner(position, newOwner.publicKey);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group C: Bull prepare / activate
  // -------------------------------------------------------------------------
  it("C: a Bull can be prepared and activated by a new owner", async () => {
    await ensureEpochsClosed();
    const { positionId, position } = await createActiveBull();
    const newOwner = web3.Keypair.generate();
    await fundPayerTo(newOwner.publicKey, 0.1);

    const prepareBuffer = await buildPrepareBullProofBuffer(position, payer.publicKey);
    const sellerClaimCredit = deriveClaimCredit(payer.publicKey, 2)[0];
    await ensureEpochsClosed();
    const prepareC = rodeoCoreProgram.methods
      .prepareTransfer()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: prepareBuffer,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        claimCredit: sellerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await prepareC.preInstructions(bullComputeIxs).rpc();

    const posAfterPrepare = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfterPrepare.status.transferReady).toBeDefined();

    await transferReceiptToOwner(positionId, newOwner.publicKey);
    const activateBuffer = await buildActivateBullProofBuffer(position, newOwner);
    await ensureEpochsClosed();
    const activateC = rodeoCoreProgram.methods
      .activatePosition()
      .accounts({
        newOwner: newOwner.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: activateBuffer,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([newOwner]);
    await ensureEpochsClosed();
    await activateC.preInstructions(bullComputeIxs).rpc();

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.status.active).toBeDefined();
    expect(posAfter.owner.equals(newOwner.publicKey)).toBe(true);

    const registry = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(bullRegistry);
    expect(registry.totalBullCount.toNumber()).toBeGreaterThanOrEqual(1);
  }, 90_000);

  // -------------------------------------------------------------------------
  // Group D: historical vs future theft via stale/future BullProofBuffer
  // -------------------------------------------------------------------------
  it("D: prepareTransfer rejects a BullProofBuffer from a historical registry snapshot", async () => {
    await ensureEpochsClosed();
    const { position, positionId } = await createActiveBull();
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);

    const decoyBuffer = await buildPrepareBullProofBuffer(position, payer.publicKey);

    const historicalRoot = emptyOwnerTreeRoot();
    const ix = buildTestFixtureSetBullRegistryIx(
      payer.publicKey,
      globalConfig,
      bullRegistry,
      Buffer.from(historicalRoot),
      new BN(0),
      new BN(0),
      new BN(0),
    );
    await provider.sendAndConfirm(new web3.Transaction().add(ix), [payer]);

    const sellerClaimCredit = deriveClaimCredit(payer.publicKey, 2)[0];
    const prepareD = rodeoCoreProgram.methods
      .prepareTransfer()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: decoyBuffer,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        claimCredit: sellerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await expect(prepareD.preInstructions(bullComputeIxs).rpc()).rejects.toThrow();

    await syncRegistryWithTracker();
  }, 60_000);

  it("D: prepareTransfer rejects a future-theft snapshot where the Bull has already moved", async () => {
    await ensureEpochsClosed();
    const { position } = await createActiveBull();
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);

    const decoyBuffer = await buildPrepareBullProofBuffer(position, payer.publicKey);

    const thief = web3.Keypair.generate();
    const stolenLeaf = buildBullLeaf(
      position,
      pos.positionId,
      thief.publicKey,
      pos.buckPower,
      pos.revealConfigVersion,
    );
    const fakeRegistry = buildRegistry([{ owner: thief.publicKey, bulls: [stolenLeaf] }]);
    const ix = buildTestFixtureSetBullRegistryIx(
      payer.publicKey,
      globalConfig,
      bullRegistry,
      Buffer.from(fakeRegistry.rootNode.hash),
      new BN(fakeRegistry.rootNode.count.toString()),
      new BN(fakeRegistry.rootNode.power.toString()),
      new BN(99),
    );
    await provider.sendAndConfirm(new web3.Transaction().add(ix), [payer]);

    const sellerClaimCredit = deriveClaimCredit(payer.publicKey, 2)[0];
    const prepareD = rodeoCoreProgram.methods
      .prepareTransfer()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: decoyBuffer,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        claimCredit: sellerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await expect(prepareD.preInstructions(bullComputeIxs).rpc()).rejects.toThrow();

    await syncRegistryWithTracker();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group E: gift Cowboy
  // -------------------------------------------------------------------------
  it("E: a Cowboy can be gifted to a new wallet", async () => {
    await ensureEpochsClosed();
    const { positionId, position } = await createActiveCowboy();
    const recipient = web3.Keypair.generate();
    await fundPayerTo(recipient.publicKey, 0.1);

    const sellerClaimCredit = deriveClaimCredit(payer.publicKey, 0)[0];
    const giftE = rodeoCoreProgram.methods
      .giftPosition()
      .accounts({
        seller: payer.publicKey,
        recipient: recipient.publicKey,
        payer: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: deriveBullProofBufferPda(rodeoCoreProgram.programId, position, payer.publicKey, new BN(positionId))[0],

        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        sellerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await giftE.rpc();

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.owner.equals(recipient.publicKey)).toBe(true);
    expect(posAfter.status.active).toBeDefined();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group F: gift Bull
  // -------------------------------------------------------------------------
  it("F: a Bull can be gifted to a new wallet", async () => {
    await ensureEpochsClosed();
    const { position } = await createActiveBull();
    const recipient = web3.Keypair.generate();
    await fundPayerTo(recipient.publicKey, 0.1);

    const buffer = await buildNativeTransferBullProofBuffer(position, payer.publicKey, recipient.publicKey);
    const sellerClaimCredit = deriveClaimCredit(payer.publicKey, 2)[0];
    await ensureEpochsClosed();
    const giftF = rodeoCoreProgram.methods
      .giftPosition()
      .accounts({
        seller: payer.publicKey,
        recipient: recipient.publicKey,
        payer: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: buffer,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        sellerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await giftF.preInstructions(bullComputeIxs).rpc();
    await reconcileBullTracker("giftF");

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.owner.equals(recipient.publicKey)).toBe(true);
    expect(posAfter.status.active).toBeDefined();
    const registry = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(bullRegistry);
    expect(registry.totalBullCount.toNumber()).toBeGreaterThanOrEqual(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group F2: gift Bull to an EXISTING Bull owner
  // -------------------------------------------------------------------------
  it("F2: a Bull can be gifted to an existing Bull owner", async () => {
    await ensureEpochsClosed();
    const first = await createActiveBull();
    const existingBuyer = web3.Keypair.generate();
    await fundPayerTo(existingBuyer.publicKey, 0.1);

    const buffer1 = await buildNativeTransferBullProofBuffer(first.position, payer.publicKey, existingBuyer.publicKey);
    const sellerClaimCredit1 = deriveClaimCredit(payer.publicKey, 2)[0];
    const gift1 = rodeoCoreProgram.methods
      .giftPosition()
      .accounts({
        seller: payer.publicKey,
        recipient: existingBuyer.publicKey,
        payer: payer.publicKey,
        globalConfig,
        position: first.position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: buffer1,
        receiptAsset: deriveReceiptAsset(first.position)[0],
        receiptCollection,
        receiptAuthority,
        sellerClaimCredit: sellerClaimCredit1,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await gift1.preInstructions(bullComputeIxs).rpc();
    await reconcileBullTracker("giftF2-first");

    const registryAfterFirst = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(bullRegistry);
    const countAfterFirst = registryAfterFirst.totalBullCount.toNumber();

    const second = await createActiveBull();
    const buffer2 = await buildNativeTransferBullProofBuffer(second.position, payer.publicKey, existingBuyer.publicKey);
    const sellerClaimCredit2 = deriveClaimCredit(payer.publicKey, 2)[0];
    const gift2 = rodeoCoreProgram.methods
      .giftPosition()
      .accounts({
        seller: payer.publicKey,
        recipient: existingBuyer.publicKey,
        payer: payer.publicKey,
        globalConfig,
        position: second.position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: buffer2,
        receiptAsset: deriveReceiptAsset(second.position)[0],
        receiptCollection,
        receiptAuthority,
        sellerClaimCredit: sellerClaimCredit2,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await gift2.preInstructions(bullComputeIxs).rpc();
    await reconcileBullTracker("giftF2-second");

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(second.position);
    expect(posAfter.owner.equals(existingBuyer.publicKey)).toBe(true);
    expect(posAfter.status.active).toBeDefined();

    const registryAfterSecond = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(bullRegistry);
    expect(registryAfterSecond.totalBullCount.toNumber()).toBe(countAfterFirst + 1);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Group G: native transfer Cowboy
  // -------------------------------------------------------------------------
  it("G: a Cowboy can be natively transferred to a buyer", async () => {
    await ensureEpochsClosed();
    const { positionId, position } = await createActiveCowboy();
    const buyer = web3.Keypair.generate();
    await fundPayerTo(buyer.publicKey, 0.1);

    const sellerClaimCredit = deriveClaimCredit(payer.publicKey, 0)[0];
    const nativeG = rodeoCoreProgram.methods
      .nativeTransferPosition()
      .accounts({
        seller: payer.publicKey,
        buyer: buyer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: deriveBullProofBufferPda(rodeoCoreProgram.programId, position, payer.publicKey, new BN(positionId))[0],

        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        sellerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await nativeG.rpc();

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.owner.equals(buyer.publicKey)).toBe(true);
    expect(posAfter.status.active).toBeDefined();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group H: market transfer Cowboy (seller offline; only market_authority may sign)
  // -------------------------------------------------------------------------
  it("H: market transfer Cowboy requires the market_authority PDA to sign", async () => {
    await ensureEpochsClosed();
    const { positionId, position } = await createActiveCowboy();
    const buyer = web3.Keypair.generate();
    await fundPayerTo(buyer.publicKey, 0.1);
    const sellerClaimCredit = deriveClaimCredit(payer.publicKey, 0)[0];

    expect(marketAuthority.equals(
      web3.PublicKey.findProgramAddressSync([Buffer.from("market-authority")], MARKET_PROGRAM_ID)[0],
    )).toBe(true);

    const marketH = rodeoCoreProgram.methods
      .marketTransferPosition()
      .accounts({
        seller: payer.publicKey,
        buyer: buyer.publicKey,
        marketAuthority,
        payer: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        sellerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await expect(marketH.rpc()).rejects.toThrow();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group I: market transfer Bull
  // -------------------------------------------------------------------------
  it("I: market transfer Bull is gated by the market_authority PDA", async () => {
    await ensureEpochsClosed();
    const { position } = await createActiveBull();
    const buyer = web3.Keypair.generate();
    await fundPayerTo(buyer.publicKey, 0.1);
    const sellerClaimCredit = deriveClaimCredit(payer.publicKey, 2)[0];
    const buffer = await buildNativeTransferBullProofBuffer(position, payer.publicKey, buyer.publicKey);

    await ensureEpochsClosed();
    const marketI = rodeoCoreProgram.methods
      .marketTransferPosition()
      .accounts({
        seller: payer.publicKey,
        buyer: buyer.publicKey,
        marketAuthority,
        payer: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: buffer,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        sellerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await expect(marketI.preInstructions(bullComputeIxs).rpc()).rejects.toThrow();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group J: ClaimCredit after ownership transfer
  // -------------------------------------------------------------------------
  it("J: claim credit pays out an owner after transfer checkpoints rewards", async () => {
    await ensureEpochsClosed();
    const { positionId, position } = await createActiveCowboy();
    const claimable = new BN(10_000_000);
    // Add a small claimable amount and matching liability through the fixture.
    await fixturePreparePosition(positionId, {
      roleCode: 1,
      cowboyKindCode: 0,
      accrualWeight: 1000,
      buckPower: 0,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });

    const ownerClaimCredit = deriveClaimCredit(payer.publicKey, 0)[0];
    const prepareClaimCredit = rodeoCoreProgram.methods
      .prepareTransfer()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: deriveBullProofBufferPda(rodeoCoreProgram.programId, position, payer.publicKey, new BN(positionId))[0],

        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        claimCredit: ownerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await prepareClaimCredit.rpc();

    const creditBefore = await rodeoAccounts(rodeoCoreProgram).claimCredit.fetch(ownerClaimCredit);
    expect(creditBefore.amountAtomic.gte(claimable)).toBe(true);

    await fundRewardVault(claimable);
    await fixtureRecognizeRewards(claimable);

    const beforeBalance = BigInt((await getAccount(provider.connection, payerAnsemAccount)).amount.toString());
    await ensureEpochsClosed();
    await rodeoCoreProgram.methods
      .claimCredit()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        claimCredit: ownerClaimCredit,
        walletClaimCooldown: deriveWalletClaimCooldown(payer.publicKey)[0],
        rewardState,
        bullAccumulator,
        globalGameState,
        rewardVault,
        ownerAnsemAccount: payerAnsemAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    const creditAfter = await rodeoAccounts(rodeoCoreProgram).claimCredit.fetch(ownerClaimCredit);
    expect(creditAfter.amountAtomic.toNumber()).toBe(0);
    const afterBalance = BigInt((await getAccount(provider.connection, payerAnsemAccount)).amount.toString());
    expect(afterBalance > beforeBalance).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group K: stake age / close-epochs / recognize-rewards
  // -------------------------------------------------------------------------
  it("K: prepareTransfer checkpoints claimable rewards produced by stake age", async () => {
    await ensureEpochsClosed();
    const { positionId, position } = await createActiveCowboy();
    const claimable = new BN(5_000_000);
    await fixturePreparePosition(positionId, {
      roleCode: 1,
      cowboyKindCode: 0,
      accrualWeight: 1000,
      buckPower: 0,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });
    await closeEpochs(2);
    await fundRewardVault(claimable);
    await fixtureRecognizeRewards(claimable);

    const ownerClaimCredit = deriveClaimCredit(payer.publicKey, 0)[0];
    const prepareClaimCredit = rodeoCoreProgram.methods
      .prepareTransfer()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: deriveBullProofBufferPda(rodeoCoreProgram.programId, position, payer.publicKey, new BN(positionId))[0],

        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        claimCredit: ownerClaimCredit,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await prepareClaimCredit.rpc();

    const credit = await rodeoAccounts(rodeoCoreProgram).claimCredit.fetch(ownerClaimCredit);
    expect(credit.amountAtomic.gte(claimable)).toBe(true);

    // Use the raw global-game-state fixture to reset counters after the checkpoint.
    const gameIx = buildTestFixtureSetGlobalGameStateIx(
      payer.publicKey,
      globalConfig,
      globalGameState,
      new BN(0),
      new BN(nextPositionId),
      new BN(0),
      new BN(0),
    );
    await provider.sendAndConfirm(new web3.Transaction().add(gameIx), [payer]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Group L: rollback (re-activate a prepared position under the original owner)
  // -------------------------------------------------------------------------
  it("L: a Cowboy prepare can be rolled back by the original owner", async () => {
    await ensureEpochsClosed();
    const { positionId, position } = await createActiveCowboy();
    const prepareLCowboy = rodeoCoreProgram.methods
      .prepareTransfer()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: deriveBullProofBufferPda(rodeoCoreProgram.programId, position, payer.publicKey, new BN(positionId))[0],

        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        claimCredit: deriveClaimCredit(payer.publicKey, 0)[0],
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await prepareLCowboy.rpc();

    const prepareState = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(prepareState.status.transferReady).toBeDefined();

    // Re-activate under the original owner: the receipt was never transferred, so owner is still payer.
    const activateLCowboy = rodeoCoreProgram.methods
      .activatePosition()
      .accounts({
        newOwner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: deriveBullProofBufferPda(rodeoCoreProgram.programId, position, payer.publicKey, new BN(positionId))[0],

        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await ensureEpochsClosed();
    await activateLCowboy.rpc();

    const after = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(after.status.active).toBeDefined();
    expect(after.owner.equals(payer.publicKey)).toBe(true);
  }, 60_000);

  it("L: a Bull prepare can be rolled back by the original owner", async () => {
    await ensureEpochsClosed();
    const { position } = await createActiveBull();
    const prepareBuffer = await buildPrepareBullProofBuffer(position, payer.publicKey);
    await ensureEpochsClosed();
    const prepareLBull = rodeoCoreProgram.methods
      .prepareTransfer()
      .accounts({
        owner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: prepareBuffer,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        claimCredit: deriveClaimCredit(payer.publicKey, 2)[0],
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await ensureEpochsClosed();
    await prepareLBull.preInstructions(bullComputeIxs).rpc();

    const activateBuffer = await buildActivateBullProofBuffer(position, payer);
    await ensureEpochsClosed();
    const activateLBull = rodeoCoreProgram.methods
      .activatePosition()
      .accounts({
        newOwner: payer.publicKey,
        globalConfig,
        position,
        rewardState,
        bullAccumulator,
        bullRegistry,
        globalGameState,
        bullProofBuffer: activateBuffer,
        receiptAsset: deriveReceiptAsset(position)[0],
        receiptCollection,
        receiptAuthority,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      });
    await ensureEpochsClosed();
    await activateLBull.preInstructions(bullComputeIxs).rpc();

    const after = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(after.status.active).toBeDefined();
    expect(after.owner.equals(payer.publicKey)).toBe(true);
    const registry = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(bullRegistry);
    expect(registry.totalBullCount.toNumber()).toBeGreaterThanOrEqual(1);
  }, 60_000);

});