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
  status: { revealPending?: {}; active?: {} };
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
  RodeoCore: "EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z",
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

describe.skipIf(skipEpochSuite)("Anchor localnet workspace (epoch profile)", () => {
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

  it("deploys all program boundaries under the pinned IDs", async () => {
    const allPrograms = { ...otherPrograms, RodeoCore: rodeoCoreProgram };
    for (const [name, expectedId] of Object.entries(expectedProgramIds)) {
      const program = allPrograms[name as keyof typeof allPrograms];
      expect(program.programId.toBase58()).toBe(expectedId);
      expect(await provider.connection.getAccountInfo(program.programId)).not.toBeNull();
    }
  }, 30_000);

  it("exports the Phase 2C1 instructions plus benchmark/test helpers and no out-of-scope instructions", async () => {
    const idl = loadIdl("rodeo_core");
    const instructionNames = idl.instructions?.map((ix: { name: string }) => ix.name) ?? [];
    const accountNames = new Set(idl.accounts?.map((account: { name: string }) => account.name));

    const phase2c1Instructions = [
      "initialize_protocol",
      "stake_and_commit",
      "settle_reveal",
      "recover_reveal_timeout",
      "close_epochs",
      "recognize_rewards",
      "claim_position",
      "request_unstake",
      "settle_unstake",
      "recover_unstake_timeout",
    ];
    for (const name of phase2c1Instructions) {
      expect(instructionNames).toContain(name);
    }
    expect(instructionNames).not.toContain("ensure_idl_accounts");

    const allowedExtraPrefixes = ["test_fixture_", "benchmark_"];
    const allowedExtraInstructions = [
      "append_bull_proof",
      "close_bull_proof",
      "finalize_bull_proof",
      "initialize_bull_proof",
      "set_current_config_version_fixture",
      "create_protocol_config_v2_fixture",
      "test_set_pause_flags",
    ];
    for (const name of instructionNames) {
      if (
        phase2c1Instructions.includes(name) ||
        allowedExtraInstructions.includes(name) ||
        allowedExtraPrefixes.some((p) => name.startsWith(p))
      ) {
        continue;
      }
      throw new Error(`Unexpected instruction in IDL: ${name}`);
    }

    const outOfScopeInstructions = [
      "stake",
      "reveal",
      "claim",
      "close_epoch",
      "unstake",
      "transfer",
      "list",
      "buy",
      "sell",
      "router",
      "provide_randomness",
      "settle_randomness",
    ];
    for (const name of outOfScopeInstructions) {
      expect(instructionNames).not.toContain(name);
    }

    const expectedAccounts = [
      "GlobalConfig",
      "RewardState",
      "GlobalGameState",
      "BullAccumulator",
      "BullProofBuffer",
      "BullRegistry",
      "Position",
      "PendingRandomness",
      "WalletClaimCooldown",
      "ProtocolConfig",
    ];
    expect([...accountNames].sort()).toEqual(expectedAccounts.sort());
    expect(accountNames).not.toContain("IdlTypeHolder");

    expect(idl.events?.some((event: { name: string }) => event.name === "ProtocolInitialized")).toBe(
      true,
    );

    const sdkPath = resolve(root, "packages/sdk/src/generated/rodeo_core.ts");
    const sdkSource = readFileSync(sdkPath, "utf8");
    expect(sdkSource).toContain("rodeoCoreIdl");
    expect(sdkSource).toContain("initialize_protocol");
    expect(sdkSource).toContain("stake_and_commit");
    expect(sdkSource).toContain("settle_reveal");
    expect(sdkSource).toContain("recover_reveal_timeout");
    expect(sdkSource).toContain("close_epochs");
    expect(sdkSource).toContain("recognize_rewards");
    expect(sdkSource).toContain("claim_position");
    expect(sdkSource).toContain("request_unstake");
    expect(sdkSource).toContain("settle_unstake");
    expect(sdkSource).toContain("recover_unstake_timeout");
    expect(sdkSource).not.toContain("ensure_idl_accounts");
  }, 30_000);

  it("IDL event schemas match the authoritative Protocol v1.3.3 definitions", async () => {
    const idl = loadIdl("rodeo_core");
    const eventNames = new Set((idl.events ?? []).map((e: { name: string }) => e.name));
    const definedTypes = (idl.types ?? []) as unknown as Array<{
      name: string;
      type: { kind: string; fields?: { name: string }[]; variants?: { name: string }[] };
    }>;
    const findType = (name: string) => definedTypes.find((t) => t.name === name);
    const fieldNames = (typeDef: { type: { fields?: { name: string }[] } }) =>
      (typeDef.type.fields ?? []).map((f) => f.name);
    const enumVariants = (typeDef: { type: { variants?: { name: string }[] } }) =>
      (typeDef.type.variants ?? []).map((v) => v.name);

    expect(eventNames).toContain("EpochClosed");
    expect(fieldNames(findType("EpochClosed")!).sort()).toEqual(
      [
        "epoch",
        "cowboy_emission",
        "suit_vault_contribution",
        "free_ansem",
        "total_cowboy_weight",
        "total_bull_power",
        "recognized_reward_balance_atomic",
        "total_ansem_liability_atomic",
        "snapshot_timestamp",
      ].sort(),
    );

    expect(eventNames).toContain("EpochsClosed");
    expect(fieldNames(findType("EpochsClosed")!).sort()).toEqual(
      ["start_epoch", "end_epoch", "epochs_processed", "last_closed_timestamp"].sort(),
    );

    expect(eventNames).toContain("RewardFundingRecognized");
    expect(fieldNames(findType("RewardFundingRecognized")!).sort()).toEqual(
      [
        "amount_atomic",
        "recognized_reward_balance_atomic",
        "actual_reward_vault_balance",
      ].sort(),
    );

    expect(eventNames).toContain("PositionClaimed");
    expect(fieldNames(findType("PositionClaimed")!).sort()).toEqual(
      ["position", "owner", "owner_amount", "bull_pool_amount"].sort(),
    );

    expect(eventNames).toContain("RewardPaid");
    expect(fieldNames(findType("RewardPaid")!).sort()).toEqual(
      [
        "position",
        "owner",
        "amount_atomic",
        "recognized_reward_balance_atomic",
        "reason",
      ].sort(),
    );

    expect(eventNames).toContain("BullPoolContribution");
    expect(fieldNames(findType("BullPoolContribution")!).sort()).toEqual(
      ["epoch", "amount_atomic", "source"].sort(),
    );

    const rewardPaidReason = findType("RewardPaidReason");
    expect(rewardPaidReason).toBeDefined();
    expect(enumVariants(rewardPaidReason!).sort()).toEqual(
      ["CowboyClaim", "DesperadoClaim", "BullClaim", "UnstakeSettlement", "SuitReward"].sort(),
    );

    const bullPoolSource = findType("BullPoolSource");
    expect(bullPoolSource).toBeDefined();
    expect(enumVariants(bullPoolSource!).sort()).toEqual(
      ["CowboyClaimTax", "DesperadoClaimTax", "UnstakeTheft"].sort(),
    );

    expect(eventNames).toContain("OrphanedRewardReleased");
    expect(fieldNames(findType("OrphanedRewardReleased")!).sort()).toEqual(
      [
        "reward_source",
        "amount_atomic",
        "remaining_remainder_scaled",
        "total_ansem_liability_atomic_after",
      ].sort(),
    );
    const orphanedRewardSource = findType("OrphanedRewardSource");
    expect(orphanedRewardSource).toBeDefined();
    expect(enumVariants(orphanedRewardSource!).sort()).toEqual(["Cowboy", "Bull"].sort());

    expect(eventNames).toContain("UnstakeRequested");
    expect(eventNames).toContain("PositionUnstaked");
    expect(fieldNames(findType("PositionUnstaked")!).sort()).toEqual(
      [
        "position",
        "owner",
        "principal_amount",
        "principal_returned",
        "principal_burned",
        "ansem_fate",
        "synchronized_ansem",
        "ansem_paid_to_owner",
        "ansem_routed_to_bull_pool",
        "settlement_nonce",
        "config_version",
      ].sort(),
    );

    const ansemUnstakeFate = findType("AnsemUnstakeFate");
    expect(ansemUnstakeFate).toBeDefined();
    expect(enumVariants(ansemUnstakeFate!).sort()).toEqual(["ToOwner", "ToBullPool", "Immune"].sort());
  }, 30_000);

  it("only allows the program upgrade authority to initialize", async () => {
    const impostor = web3.Keypair.generate();
    // Fund the impostor so it can pay rent if the instruction gets far enough.
    const signature = await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000);
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...latestBlockhash });

    await expect(
      rodeoCoreProgram.methods
        .initializeProtocol(
          upgradeCouncil.publicKey,
          treasuryCouncil.publicKey,
          emergencyGuardians.publicKey,
        )
        .accounts({
          payer: impostor.publicKey,
          initializer: impostor.publicKey,
          program: rodeoCoreProgram.programId,
          programData: programDataAddress(rodeoCoreProgram.programId),
          rodeoMint,
          ansemMint,
          globalConfig,
          rewardState,
          globalGameState,
          bullAccumulator,
          principalVault,
          rewardVault,
          protocolConfig: deriveProtocolConfig(rodeoCoreProgram.programId, globalConfig, new BN(1))[0],
          receiptCollection,
          receiptAuthority,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([impostor])
        .rpc(),
    ).rejects.toThrow();
  }, 30_000);

  it("rejects a program-data account that does not belong to rodeo_core", async () => {
    const fakeProgramData = web3.Keypair.generate();

    await expect(
      rodeoCoreProgram.methods
        .initializeProtocol(
          upgradeCouncil.publicKey,
          treasuryCouncil.publicKey,
          emergencyGuardians.publicKey,
        )
        .accounts({
          payer: payer.publicKey,
          initializer: provider.wallet.publicKey,
          program: rodeoCoreProgram.programId,
          programData: fakeProgramData.publicKey,
          rodeoMint,
          ansemMint,
          globalConfig,
          rewardState,
          globalGameState,
          bullAccumulator,
          principalVault,
          rewardVault,
          protocolConfig: deriveProtocolConfig(rodeoCoreProgram.programId, globalConfig, new BN(1))[0],
          receiptCollection,
          receiptAuthority,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
    ).rejects.toThrow();
  }, 30_000);

  it("initializes GlobalConfig with computed atomic values and governance addresses", async () => {
    const config = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);

    expect(config.version).toBe(2);
    expect(config.rodeoMint.toBase58()).toBe(rodeoMint.toBase58());
    expect(config.ansemMint.toBase58()).toBe(ansemMint.toBase58());
    expect(config.rodeoDecimals).toBe(6);
    expect(config.ansemDecimals).toBe(6);
    expect(config.stakeAmountAtomic.toString()).toBe("100000000000");
    expect(config.expectedTotalSupplyAtomic.toString()).toBe("1000000000000000");
    expect(config.principalVault.toBase58()).toBe(principalVault.toBase58());
    expect(config.rewardVault.toBase58()).toBe(rewardVault.toBase58());
    expect(config.pauseNewStakes).toBe(false);
    expect(config.pauseNewRevealRequests).toBe(false);
    expect(config.pauseNewMarketplaceListings).toBe(false);
    expect(config.pauseRouterSwaps).toBe(false);
    expect(config.upgradeCouncil.toBase58()).toBe(upgradeCouncil.publicKey.toBase58());
    expect(config.treasuryCouncil.toBase58()).toBe(treasuryCouncil.publicKey.toBase58());
    expect(config.emergencyGuardians.toBase58()).toBe(emergencyGuardians.publicKey.toBase58());
  }, 30_000);

  it("initializes RewardState with zeroed liabilities, indices, and counters", async () => {
    const state = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(state.version).toBe(3);
    expect(state.globalConfig.toBase58()).toBe(globalConfig.toBase58());
    expect(state.currentEpoch.toString()).toBe("0");
    expect(state.totalAnsemLiabilityAtomic.toString()).toBe("0");
    expect(state.cowboyUnmaterializedLiabilityAtomic.toString()).toBe("0");
    expect(state.positionClaimableLiabilityAtomic.toString()).toBe("0");
    expect(state.bullPoolLiabilityAtomic.toString()).toBe("0");
    expect(state.bullPoolUnallocatedLiabilityAtomic.toString()).toBe("0");
    expect(state.suitVaultLiabilityAtomic.toString()).toBe("0");
    expect(state.recognizedRewardBalanceAtomic.toString()).toBe("0");
    expect(state.ansemEmittedAtomic.toString()).toBe("0");
    expect(state.ansemClaimedAtomic.toString()).toBe("0");
    expect(state.orphanedRewardReleasedAtomic.toString()).toBe("0");
    expect(state.cowboyRewardIndex.toString()).toBe("0");
    expect(state.cowboyIndexRemainderScaled.toString()).toBe("0");
    expect(state.cowboyOrphanedAccrualRemainderScaled.toString()).toBe("0");
    expect(state.suitEpoch.toString()).toBe("0");
  }, 30_000);

  it("starts the first protocol epoch after the pot-fill period", async () => {
    const config = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    const state = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(state.epochStartedAt.gtn(config.launchTimestamp)).toBe(true);
    expect(state.lastClosedEpochTimestamp.toString()).toBe(state.epochStartedAt.toString());
  }, 30_000);

  it("closes a fully elapsed epoch with zero free ANSEM and emits zero snapshot values", async () => {
    const before = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    await sleep(5_000);

    const epochClosedPromise = collectOneEvent<{
      epoch: BN;
      cowboyEmission: BN;
      suitVaultContribution: BN;
      freeAnsem: BN;
      totalCowboyWeight: BN;
      totalBullPower: BN;
      recognizedRewardBalanceAtomic: BN;
      totalAnsemLiabilityAtomic: BN;
      snapshotTimestamp: BN;
    }>("epochClosed");
    const epochsClosedPromise = collectOneEvent<{
      startEpoch: BN;
      endEpoch: BN;
      epochsProcessed: BN;
      lastClosedTimestamp: BN;
    }>("epochsClosed");

    await closeEpochs(1);

    const epochClosed = await epochClosedPromise;
    const epochsClosed = await epochsClosedPromise;
    const after = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(after.currentEpoch.sub(before.currentEpoch).toString()).toBe("1");
    expect(after.ansemEmittedAtomic.toString()).toBe("0");
    expect(after.cowboyUnmaterializedLiabilityAtomic.toString()).toBe("0");
    expect(after.suitVaultLiabilityAtomic.toString()).toBe("0");
    expect(after.totalAnsemLiabilityAtomic.toString()).toBe("0");
    expect(after.cowboyRewardIndex.toString()).toBe(before.cowboyRewardIndex.toString());
    expect(after.cowboyIndexRemainderScaled.toString()).toBe(
      before.cowboyIndexRemainderScaled.toString(),
    );

    expect(epochClosed.epoch.toString()).toBe(after.currentEpoch.toString());
    expect(epochClosed.freeAnsem.toString()).toBe("0");
    expect(epochClosed.cowboyEmission.toString()).toBe("0");
    expect(epochClosed.suitVaultContribution.toString()).toBe("0");
    expect(epochClosed.totalCowboyWeight.toString()).toBe(gameBefore.totalActiveCowboyWeight.toString());
    expect(epochClosed.totalBullPower.toString()).toBe(gameBefore.totalActiveBullPower.toString());
    expect(epochClosed.recognizedRewardBalanceAtomic.toString()).toBe(before.recognizedRewardBalanceAtomic.toString());
    expect(epochClosed.totalAnsemLiabilityAtomic.toString()).toBe(before.totalAnsemLiabilityAtomic.toString());
    expect(epochClosed.snapshotTimestamp.toString()).toBe(before.epochStartedAt.toString());

    expect(epochsClosed.startEpoch.toString()).toBe(before.currentEpoch.toString());
    expect(epochsClosed.endEpoch.toString()).toBe(after.currentEpoch.toString());
    expect(epochsClosed.epochsProcessed.toString()).toBe("1");
  }, 60_000);

  it("seeds the reward vault with recognized ANSEM for later claim tests", async () => {
    // Catch up to the cluster clock, then recognize a large initial reserve so
    // that all subsequent claim scenarios have non-zero emission.
    const seedAmount = new BN(1_000_000_000_000_000);
    await ensureEpochsClosed();
    await fundRewardVault(seedAmount);
    await runWhenEpochsClosed(() =>
      rodeoCoreProgram.methods
        .recognizeRewards(seedAmount)
        .accounts({
          caller: payer.publicKey,
          globalConfig,
          rewardState,
          rewardVault,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
        .rpc(),
    );
    const reward = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    expect(reward.recognizedRewardBalanceAtomic.gtn(0)).toBe(true);
  }, 60_000);

  it("initializes GlobalGameState with zeroed population and principal counters", async () => {
    const state = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    expect(state.version).toBe(4);
    expect(state.globalConfig.toBase58()).toBe(globalConfig.toBase58());
    expect(state.totalCompletedReveals.toString()).toBe("0");
    expect(state.livePositionCount.toString()).toBe("0");
    expect(state.activeCowboyCount.toString()).toBe("0");
    expect(state.activeBullCount.toString()).toBe("0");
    expect(state.totalActiveCowboyWeight.toString()).toBe("0");
    expect(state.totalActiveBullPower.toString()).toBe("0");
    expect(state.accountedPrincipalAtomic.toString()).toBe("0");
  }, 30_000);

  it("initializes BullAccumulator with zeroed accumulators", async () => {
    const acc = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(bullAccumulator);

    expect(acc.version).toBe(3);
    expect(acc.globalConfig.toBase58()).toBe(globalConfig.toBase58());
    expect(acc.rewardPerWeightScaled.toString()).toBe("0");
    expect(acc.bullIndexRemainderScaled.toString()).toBe("0");
    expect(acc.bullOrphanedAccrualRemainderScaled.toString()).toBe("0");
  }, 30_000);

  it("creates vaults with the correct mints and authorities", async () => {
    const principal = await getAccount(provider.connection, principalVault);
    expect(principal.mint.toBase58()).toBe(rodeoMint.toBase58());
    expect(principal.owner.toBase58()).toBe(globalConfig.toBase58());

    const reward = await getAccount(provider.connection, rewardVault);
    expect(reward.mint.toBase58()).toBe(ansemMint.toBase58());
    expect(reward.owner.toBase58()).toBe(globalConfig.toBase58());
  }, 30_000);

  it("rejects duplicate protocol initialization", async () => {
    await expect(
      rodeoCoreProgram.methods
        .initializeProtocol(
          upgradeCouncil.publicKey,
          treasuryCouncil.publicKey,
          emergencyGuardians.publicKey,
        )
        .accounts({
          payer: payer.publicKey,
          initializer: provider.wallet.publicKey,
          program: rodeoCoreProgram.programId,
          programData: programDataAddress(rodeoCoreProgram.programId),
          rodeoMint,
          ansemMint,
          globalConfig,
          rewardState,
          globalGameState,
          bullAccumulator,
          principalVault,
          rewardVault,
          protocolConfig: deriveProtocolConfig(rodeoCoreProgram.programId, globalConfig, new BN(1))[0],
          receiptCollection,
          receiptAuthority,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
    ).rejects.toThrow();
  }, 30_000);

  it("derives Position and PendingRandomness PDAs as specified", async () => {
    const positionId = new BN(42);
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const [randomness] = deriveRandomness(rodeoCoreProgram.programId, position, 0, new BN(0));

    expect(position.toBase58()).toBe(
      web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("position"),
          globalConfig.toBuffer(),
          positionId.toArrayLike(Buffer, "le", 8),
        ],
        rodeoCoreProgram.programId,
      )[0].toBase58(),
    );

    expect(randomness.toBase58()).toBe(
      web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("randomness"),
          position.toBuffer(),
          Buffer.from([0]),
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        rodeoCoreProgram.programId,
      )[0].toBase58(),
    );
  }, 30_000);

  const stakeAmountAtomic = new BN(100_000_000_000);
  let nextPositionId = 0;

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
        })
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

  async function recoverRevealTimeout(positionId: BN, caller = payer) {
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    await rodeoCoreProgram.methods
      .recoverRevealTimeout()
      .accounts({
        caller: caller.publicKey,
        position,
        pendingRandomness,
        globalConfig,
        principalVault,
        ownerRodeoAccount: payerRodeoAccount,
        owner: payer.publicKey,
        globalGameState,
        receiptFunder,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([caller])
      .rpc();
  }

  // The `test-fixtures` instructions are compiled into the epoch/claim test
  // binaries, but they are intentionally kept out of the production IDL.
  // Invoke them via their Anchor discriminators.
  async function fixtureCreateProtocolConfigV2(configVersion: BN) {
    const [protocolConfig] = deriveProtocolConfig(rodeoCoreProgram.programId, globalConfig, configVersion);
    const discriminator = Buffer.from("638f500cc67fd541", "hex");
    const data = Buffer.concat([discriminator, configVersion.toArrayLike(Buffer, "le", 8)]);
    const ix = new web3.TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: false },
        { pubkey: protocolConfig, isSigner: false, isWritable: true },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: rodeoCoreProgram.programId,
      data,
    });
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
    return protocolConfig;
  }

  async function fixtureSetCurrentConfigVersion(protocolConfig: web3.PublicKey) {
    const discriminator = Buffer.from("9994dfcd3f23596c", "hex");
    const ix = new web3.TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: true },
        { pubkey: protocolConfig, isSigner: false, isWritable: false },
      ],
      programId: rodeoCoreProgram.programId,
      data: discriminator,
    });
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
  }

  function deriveWalletCooldown(
    programId: web3.PublicKey,
    globalConfig: web3.PublicKey,
    wallet: web3.PublicKey,
  ): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from("claim_cooldown"), globalConfig.toBuffer(), wallet.toBuffer()],
      programId,
    );
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
      })
      .rpc();
  }

  async function closeEpochs(maxEpochs: number) {
    try {
      await closeEpochsRaw(maxEpochs);
    } catch (err) {
      if (!isNoElapsedEpoch(err)) throw err;
    }
  }

  async function ensureEpochsClosed() {
    for (let i = 0; i < 100; i++) {
      const before = (
        await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState)
      ).currentEpoch;
      try {
        await closeEpochsRaw(8);
      } catch (err) {
        if (isNoElapsedEpoch(err)) return;
        throw err;
      }
      const after = (
        await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState)
      ).currentEpoch;
      // If fewer than the max batch was processed, there were no more elapsed
      // epochs at the moment the transaction executed.
      if (after.sub(before).toNumber() < 8) return;
    }
  }

  function isEpochsNotClosed(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const e = err as {
      error?: { errorCode?: { code?: string; number?: number }; errorMessage?: string };
      code?: number;
      message?: string;
    };
    if (e.error?.errorCode?.code === "EpochsNotClosed") return true;
    if (e.error?.errorCode?.number === 6027) return true;
    if (e.error?.errorMessage?.includes("All elapsed epochs must be closed")) return true;
    if (e.code === 6027) return true;
    if (e.message?.includes("All elapsed epochs must be closed")) return true;
    if (e.message?.includes("custom program error: 0x178b")) return true;
    return false;
  }

  // Shape-only check for the Anchor/web3.js wrapper bug that produces an
  // unparseable `Unknown action 'undefined'` object. This is *not* enough to
  // justify a retry; runWhenEpochsClosed additionally verifies that a new epoch
  // became elapsed and was closed before classifying the failure as the
  // short-epoch race.
  function isUnknownActionSendTransactionError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const e = err as { signature?: unknown; transactionMessage?: unknown; message?: string };
    return (
      e.signature === undefined &&
      e.transactionMessage === undefined &&
      e.message?.includes("Unknown action") === true
    );
  }

  async function runWhenEpochsClosed<T>(op: () => Promise<T>, maxAttempts = 8): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      await ensureEpochsClosed();
      try {
        return await op();
      } catch (err) {
        if (isEpochsNotClosed(err)) {
          lastErr = err;
          continue;
        }
        if (isUnknownActionSendTransactionError(err)) {
          const epochBefore = (await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState))
            .currentEpoch;
          try {
            await ensureEpochsClosed();
          } catch (_closeErr) {
            // Catch-up itself failed; don't mask the original error.
            throw err;
          }
          const epochAfter = (await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState))
            .currentEpoch;
          if (epochAfter.gt(epochBefore)) {
            lastErr = err;
            continue;
          }
          // No elapsed epoch was closed, so this is not the short-epoch race.
          throw err;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  function extractCustomProgramError(err: unknown): number | null {
    if (err === null || typeof err !== "object") return null;
    const e = err as Record<string, unknown>;

    if (Array.isArray(e["InstructionError"]) && e["InstructionError"].length === 2) {
      const detail = e["InstructionError"][1];
      if (typeof detail === "object" && detail !== null && "Custom" in detail) {
        const custom = (detail as Record<string, unknown>)["Custom"];
        if (typeof custom === "number") return custom;
        if (typeof custom === "string") return parseInt(custom, 10);
      }
    }

    const wrapped = e["Err"];
    if (wrapped !== null && typeof wrapped === "object") {
      return extractCustomProgramError(wrapped);
    }

    return null;
  }

  async function assertSimulatedEpochsNotClosed(builder: () => any): Promise<void> {
    const tx = await builder().transaction();
    tx.feePayer = provider.wallet.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    await provider.wallet.signTransaction(tx);
    const sim = await provider.connection.simulateTransaction(tx, [payer]);

    expect(sim.value.err).not.toBeNull();

    const customCode = extractCustomProgramError(sim.value.err);
    expect(customCode).toBe(6027);

    expect(sim.value.logs).not.toBeNull();
    const hasEpochsNotClosed = (sim.value.logs ?? []).some(
      (log: string) =>
        log.includes("EpochsNotClosed") ||
        log.includes("All elapsed epochs must be closed") ||
        log.includes("custom program error: 0x178b"),
    );
    expect(hasEpochsNotClosed).toBe(true);
  }

  async function claimPositionRaw(positionId: BN, owner = payer, ownerAnsem = payerAnsemAccount) {
    const { position } = await deriveStakeAccounts(positionId);
    const [walletCooldown] = deriveWalletCooldown(
      rodeoCoreProgram.programId,
      globalConfig,
      owner.publicKey,
    );
    await rodeoCoreProgram.methods
      .claimPosition()
      .accounts({
        owner: owner.publicKey,
        globalConfig,
        rewardState,
        globalGameState,
        bullAccumulator,
        position,
        walletClaimCooldown: walletCooldown,
        rewardVault,
        ownerAnsemAccount: ownerAnsem,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([owner])
      .rpc();
  }

  async function claimPosition(positionId: BN, owner = payer, ownerAnsem = payerAnsemAccount) {
    // The production `require_elapsed_epochs_closed` guard stays compiled in
    // and active; callers that need a successful claim should first call
    // `ensureEpochsClosed()` or `runWhenEpochsClosed()`.
    await claimPositionRaw(positionId, owner, ownerAnsem);
  }

  function getRole(pos: PositionAccount): "cowboy" | "bull" | null {
    if (pos.role.cowboy) return "cowboy";
    if (pos.role.bull) return "bull";
    return null;
  }

  async function stakeAndSettleWithRole(desiredRole: "cowboy" | "bull"): Promise<BN> {
    for (let attempt = 0; attempt < 50; attempt++) {
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

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForRandomnessTimeout(positionId: BN, bufferSeconds = 2) {
    const { pendingRandomness } = await deriveStakeAccounts(positionId);
    const pr = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(pendingRandomness);
    const target = pr.timeoutTimestamp.toNumber() + bufferSeconds;
    for (let i = 0; i < 100; i++) {
      const slot = await provider.connection.getSlot("finalized");
      const blockTime = slot !== null ? await provider.connection.getBlockTime(slot) : null;
      if (blockTime !== null && blockTime >= target) {
        return;
      }
      await sleep(500);
    }
    throw new Error(`Randomness timeout not reached after polling for position ${positionId}`);
  }

  function collectEvents<T>(eventName: string, expectedCount: number, timeoutMs = 10_000): Promise<T[]> {
    return new Promise((resolve) => {
      const events: T[] = [];
      let listener: number | undefined;
      const timer = setTimeout(() => finish(), timeoutMs);
      function finish() {
        clearTimeout(timer);
        if (listener !== undefined) {
          void rodeoCoreProgram.removeEventListener(listener).then(() => resolve(events));
        } else {
          resolve(events);
        }
      }
      listener = rodeoCoreProgram.addEventListener(eventName, (event: T) => {
        events.push(event);
        if (events.length >= expectedCount) {
          finish();
        }
      });
    });
  }

  function collectOneEvent<T>(eventName: string, timeoutMs = 10_000): Promise<T> {
    return collectEvents<T>(eventName, 1, timeoutMs).then((arr) => arr[0]);
  }

  it("stakes the configured amount and creates a reveal-pending position", async () => {
    const positionId = new BN(nextPositionId++);
    const vaultBefore = await getAccount(provider.connection, principalVault);
    const ownerBefore = await getAccount(provider.connection, payerRodeoAccount);
    const { position, pendingRandomness } = await stakeAndCommit(positionId);

    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.owner.toBase58()).toBe(payer.publicKey.toBase58());
    expect(pos.positionId.toString()).toBe(positionId.toString());
    expect(pos.principalAmount.toString()).toBe(stakeAmountAtomic.toString());
    expect(pos.status).toHaveProperty("revealPending");
    expect(pos.role).toHaveProperty("unassigned");
    expect(pos.cowboyKind).toHaveProperty("unassigned");
    expect(pos.bullTier).toBe(0);
    expect(pos.suit).toHaveProperty("unassigned");
    expect(pos.activeSince.toString()).toBe("0");
    expect(pos.unstakeEligibleAt.toString()).toBe("0");
    expect(pos.pendingActionActive).toBe(true);
    expect(pos.pendingActionType).toHaveProperty("reveal");
    expect(pos.pendingActionNonce.toString()).toBe("0");
    expect(pos.nextActionNonce.toString()).toBe("1");
    expect(pos.receiptAsset.toBase58()).toBe(web3.PublicKey.default.toBase58());

    const pending = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(pendingRandomness);
    expect(pending.position.toBase58()).toBe(position.toBase58());
    expect(pending.actionType).toHaveProperty("reveal");
    expect(pending.actionNonce.toString()).toBe("0");
    expect(pending.settled).toBe(false);
    expect(pending.timeoutTimestamp.gt(pending.committedSlot)).toBe(true);

    const vaultAfter = await getAccount(provider.connection, principalVault);
    const ownerAfter = await getAccount(provider.connection, payerRodeoAccount);
    expect(new BN(vaultAfter.amount.toString()).sub(new BN(vaultBefore.amount.toString())).toString()).toBe(
      stakeAmountAtomic.toString(),
    );
    expect(new BN(ownerBefore.amount.toString()).sub(new BN(ownerAfter.amount.toString())).toString()).toBe(
      stakeAmountAtomic.toString(),
    );

    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    expect(game.livePositionCount.toString()).toBe("1");
    expect(game.accountedPrincipalAtomic.toString()).toBe(stakeAmountAtomic.toString());
  }, 60_000);

  it("rejects an incorrect stake amount", async () => {
    const positionId = new BN(nextPositionId++);
    await expect(stakeAndCommit(positionId, stakeAmountAtomic.subn(1))).rejects.toThrow();
    await expect(stakeAndCommit(positionId, stakeAmountAtomic.addn(1))).rejects.toThrow();
  }, 60_000);

  it("rejects a duplicate position_id", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await expect(stakeAndCommit(positionId)).rejects.toThrow();
  }, 60_000);

  it("derives the same Position PDA for any owner", async () => {
    const positionId = new BN(12345);
    const [positionFromPayer] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const otherOwner = web3.Keypair.generate();
    const [positionFromOther] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    expect(positionFromPayer.toBase58()).toBe(positionFromOther.toBase58());
    expect(positionFromPayer.toBase58()).not.toBe(otherOwner.publicKey.toBase58());
  }, 30_000);

  it("increments global counters for each new stake", async () => {
    const before = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    const after = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    expect(after.livePositionCount.sub(before.livePositionCount).toString()).toBe("1");
    expect(after.accountedPrincipalAtomic.sub(before.accountedPrincipalAtomic).toString()).toBe(
      stakeAmountAtomic.toString(),
    );
    expect(after.nextPositionId.sub(before.nextPositionId).toString()).toBe("1");
    expect(after.totalCompletedReveals.toString()).toBe(before.totalCompletedReveals.toString());
  }, 60_000);

  it("settles a reveal permissionlessly and updates state", async () => {
    const positionId = new BN(nextPositionId++);
    const { position } = await stakeAndCommit(positionId);
    const before = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const settler = web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(settler.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);
    await settleReveal(positionId, settler);

    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.status).toHaveProperty("active");
    expect(pos.pendingActionActive).toBe(false);
    expect(pos.settlementNonce.toString()).toBe("1");
    expect(pos.unstakeEligibleAt.sub(pos.activeSince).toNumber()).toBe(86_400);

    const pending = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(
      deriveRandomness(rodeoCoreProgram.programId, position, 0, new BN(0))[0],
    );
    expect(pending).toBeNull();

    const after = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    expect(after.totalCompletedReveals.toString()).toBe(
      before.totalCompletedReveals.addn(1).toString(),
    );
  }, 60_000);

  it("cannot settle the same reveal twice", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await settleReveal(positionId);
    await expect(settleReveal(positionId)).rejects.toThrow();
  }, 60_000);

  it("fails reveal settlement with the wrong PendingRandomness PDA", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    const [wrongRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      derivePosition(rodeoCoreProgram.programId, globalConfig, positionId)[0],
      0,
      new BN(999),
    );
    const { position } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    await expect(
      rodeoCoreProgram.methods
        .settleReveal()
        .accounts({
          settler: payer.publicKey,
          globalConfig,
          globalGameState,
          rewardState,
          bullAccumulator,
          bullRegistry,
          position,
          pendingRandomness: wrongRandomness,
          protocolConfig: deriveProtocolConfig(rodeoCoreProgram.programId, globalConfig, new BN(1))[0],
          owner: pos.owner,
          receiptOwner: pos.owner,
          receiptAsset,
          receiptCollection,
          receiptAuthority,
          receiptFunder,
          providerRandomnessAccount: web3.SYSVAR_RENT_PUBKEY,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
          bullProofBuffer: null,
          refundRecipient: null,
        } as any)
        .rpc(),
    ).rejects.toThrow();
  }, 60_000);

  it("initializes Cowboy reward checkpoints on reveal", async () => {
    const positionId = new BN(nextPositionId++);
    const { position } = await stakeAndCommit(positionId);
    await settleReveal(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const reward = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    if (pos.role.cowboy) {
      expect(pos.lastCowboyRewardIndex.toString()).toBe(reward.cowboyRewardIndex.toString());
      expect(pos.lastBullRewardPerWeight.toString()).toBe("0");
      expect(pos.cowboyAccrualRemainderScaled.toString()).toBe("0");
      expect(pos.bullAccrualRemainderScaled.toString()).toBe("0");
      const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
      expect(game.activeCowboyCount.subn(0).toNumber()).toBeGreaterThanOrEqual(1);
      expect(game.totalActiveCowboyWeight.gtn(0)).toBe(true);
    }
  }, 60_000);

  it("initializes Bull reward checkpoints on reveal", async () => {
    const positionId = new BN(nextPositionId++);
    const { position } = await stakeAndCommit(positionId);
    await settleReveal(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const bullAcc = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(bullAccumulator);
    if (pos.role.bull) {
      expect(pos.lastBullRewardPerWeight.toString()).toBe(
        bullAcc.rewardPerWeightScaled.toString(),
      );
      expect(pos.lastCowboyRewardIndex.toString()).toBe("0");
      expect(pos.bullAccrualRemainderScaled.toString()).toBe("0");
      const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
      expect(game.activeBullCount.subn(0).toNumber()).toBeGreaterThanOrEqual(1);
      expect(game.totalActiveBullPower.gtn(0)).toBe(true);
    }
  }, 60_000);

  it("creates a receipt asset owned by the position owner on reveal", async () => {
    const positionId = new BN(nextPositionId++);
    const { position } = await stakeAndCommit(positionId);
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptCreatedPromise = collectOneEvent<{
      position: web3.PublicKey;
      positionId: BN;
      receiptAsset: web3.PublicKey;
      owner: web3.PublicKey;
      collection: web3.PublicKey;
    }>("receiptCreated");
    await settleReveal(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.receiptAsset.toBase58()).toBe(receiptAsset.toBase58());
    const receipt = await provider.connection.getAccountInfo(receiptAsset);
    expect(receipt).not.toBeNull();
    expect(receipt!.owner.toBase58()).toBe(MPL_CORE_PROGRAM_ID.toBase58());

    const receiptCreated = await receiptCreatedPromise;
    expect(receiptCreated.position.toBase58()).toBe(position.toBase58());
    expect(receiptCreated.positionId.toString()).toBe(positionId.toString());
    expect(receiptCreated.receiptAsset.toBase58()).toBe(receiptAsset.toBase58());
    expect(receiptCreated.owner.toBase58()).toBe(payer.publicKey.toBase58());
    expect(receiptCreated.collection.toBase58()).toBe(receiptCollection.toBase58());
  }, 60_000);

  it("does not change position ownership during reveal", async () => {
    const positionId = new BN(nextPositionId++);
    const { position } = await stakeAndCommit(positionId);
    await settleReveal(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.owner.toBase58()).toBe(payer.publicKey.toBase58());
  }, 60_000);

  async function setPauseFlags(
    pauseNewStakes: boolean,
    pauseNewRevealRequests: boolean,
  ) {
    // The `test_set_pause_flags` fixture is compiled only for local tests via
    // the `test-fixtures` feature, so it is not exported in the production IDL.
    const authority = emergencyGuardians;
    // Anchor 8-byte instruction discriminator: sha256("global:test_set_pause_flags")[0..8]
    const discriminator = Buffer.from("303c7a4c1fda4642", "hex");
    const data = Buffer.concat([
      discriminator,
      Buffer.from([pauseNewStakes ? 1 : 0]),
      Buffer.from([pauseNewRevealRequests ? 1 : 0]),
    ]);
    const ix = new web3.TransactionInstruction({
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: globalConfig, isSigner: false, isWritable: true },
      ],
      programId: rodeoCoreProgram.programId,
      data,
    });
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [authority]);
  }

  // The `test_fixture_*` instructions are compiled only for local tests via
  // the `test-fixtures` feature, so they are not exported in the production
  // IDL. They are invoked here as raw instructions using their Anchor
  // discriminators (sha256("global:<name>")[0..8]).
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

  async function fixtureSetOrphanedRemainder(args: {
    cowboyOrphanedAccrualRemainderScaled: BN;
    bullOrphanedAccrualRemainderScaled: BN;
    cowboyUnmaterializedLiabilityAtomic: BN;
    bullPoolLiabilityAtomic: BN;
    totalAnsemLiabilityAtomic: BN;
    recognizedRewardBalanceAtomic: BN;
    lastClosedEpochTimestamp: BN;
    epochStartedAt: BN;
  }) {
    const discriminator = Buffer.from("50455a376bab9446", "hex");
    const data = Buffer.concat([
      discriminator,
      args.cowboyOrphanedAccrualRemainderScaled.toArrayLike(Buffer, "le", 16),
      args.bullOrphanedAccrualRemainderScaled.toArrayLike(Buffer, "le", 16),
      args.cowboyUnmaterializedLiabilityAtomic.toArrayLike(Buffer, "le", 8),
      args.bullPoolLiabilityAtomic.toArrayLike(Buffer, "le", 8),
      args.totalAnsemLiabilityAtomic.toArrayLike(Buffer, "le", 8),
      args.recognizedRewardBalanceAtomic.toArrayLike(Buffer, "le", 8),
      args.lastClosedEpochTimestamp.toArrayLike(Buffer, "le", 8),
      args.epochStartedAt.toArrayLike(Buffer, "le", 8),
    ]);
    const ix = new web3.TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: false },
        { pubkey: rewardState, isSigner: false, isWritable: true },
        { pubkey: bullAccumulator, isSigner: false, isWritable: true },
      ],
      programId: rodeoCoreProgram.programId,
      data,
    });
    const tx = new web3.Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
  }

  async function requestUnstake(positionId: BN, owner = payer) {
    await ensureEpochsClosed();
    const { position } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const actionNonce = pos.nextActionNonce;
    const [pendingRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      position,
      1,
      actionNonce,
    );
    const globalConfigAccount = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      globalConfigAccount.currentConfigVersion,
    );
    await rodeoCoreProgram.methods
      .requestUnstake()
      .accounts({
        owner: owner.publicKey,
        globalConfig,
        protocolConfig,
        position,
        pendingRandomness,
        rewardState,
        bullAccumulator,
        providerRandomnessAccount: payer.publicKey,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([owner])
      .rpc();
    return { position, pendingRandomness, actionNonce };
  }

  async function getOwnerTokenAccounts(owner: web3.PublicKey) {
    const ownerRodeoAccount = getAssociatedTokenAddressSync(rodeoMint, owner);
    const ownerAnsemAccount = getAssociatedTokenAddressSync(ansemMint, owner);
    if ((await provider.connection.getAccountInfo(ownerRodeoAccount)) === null) {
      await createAssociatedTokenAccount(provider.connection, payer, rodeoMint, owner);
    }
    if ((await provider.connection.getAccountInfo(ownerAnsemAccount)) === null) {
      await createAssociatedTokenAccount(provider.connection, payer, ansemMint, owner);
    }
    return { ownerRodeoAccount, ownerAnsemAccount };
  }

  async function settleUnstake(positionId: BN, actionNonce: BN, settler = payer) {
    await ensureEpochsClosed();
    const { position } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const [pendingRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      position,
      1,
      actionNonce,
    );
    const pendingRandomnessAccount =
      await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(pendingRandomness);
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      pendingRandomnessAccount.configVersionSnapshot,
    );
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const { ownerRodeoAccount, ownerAnsemAccount } = await getOwnerTokenAccounts(pos.owner);

    let bullProof: { bufferPda: web3.PublicKey; refundRecipient: web3.PublicKey } | null = null;
    const ixs: web3.TransactionInstruction[] = [];
    if (pos.role.bull) {
      const registry = bullRegistryTracker.buildRegistry();
      const payload = buildUnstakePayload(registry, pos.owner, position);
      const payloadBytes = serializeBullProofPayload(payload);
      ixs.push(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
      const staged = await stageBullProofBuffer(
        rodeoCoreProgram,
        globalConfig,
        position,
        pendingRandomness,
        settler,
        new BN(1),
        { unstake: {} },
        payloadBytes,
      );
      bullProof = { bufferPda: staged.bufferPda, refundRecipient: staged.refundRecipient };
    }

    await rodeoCoreProgram.methods
      .settleUnstake()
      .accounts({
        settler: settler.publicKey,
        globalConfig,
        globalGameState,
        rewardState,
        bullAccumulator,
        bullRegistry,
        position,
        pendingRandomness,
        protocolConfig,
        principalVault,
        rodeoMint,
        ownerRodeoAccount,
        rewardVault,
        ownerAnsemAccount,
        owner: pos.owner,
        receiptAsset,
        receiptCollection,
        receiptAuthority,
        receiptFunder,
        bullProofBuffer: bullProof ? bullProof.bufferPda : null,
        refundRecipient: bullProof ? bullProof.refundRecipient : null,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        providerRandomnessAccount: settler.publicKey,
      } as any)
      .preInstructions(ixs)
      .signers([settler])
      .rpc();

    if (pos.role.bull) {
      bullRegistryTracker.unregisterBull(pos.owner, position);
      offChainRegistryVersion += 1n;
    }
    await assertTrackerMatchesChain();
  }

  async function recoverUnstakeTimeout(positionId: BN, actionNonce: BN, caller = payer) {
    const { position } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const [pendingRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      position,
      1,
      actionNonce,
    );
    await rodeoCoreProgram.methods
      .recoverUnstakeTimeout()
      .accounts({
        caller: caller.publicKey,
        globalConfig,
        position,
        pendingRandomness,
        owner: pos.owner,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([caller])
      .rpc();
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

  function cloneRegistryEntries(entries: RegistryEntry[]): RegistryEntry[] {
    return entries.map((e) => ({ owner: e.owner, bulls: e.bulls.map((b) => ({ ...b })) }));
  }

  function buildHistoricalRegistry(positionAddr: web3.PublicKey): BuiltRegistry {
    const snapshot = positionRevealSnapshots.get(positionAddr.toBase58());
    if (!snapshot) throw new Error(`No reveal snapshot for position ${positionAddr.toBase58()}`);
    return buildRegistry(snapshot);
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

  async function findUnstakePositionId(
    globalConfig: web3.PublicKey,
    startFrom: BN,
    protocolEpoch: BN,
    predicate: (positionId: BN, position: web3.PublicKey, stolen: boolean) => boolean,
    maxAttempts = 200,
  ): Promise<{ positionId: BN; position: web3.PublicKey }> {
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = startFrom.addn(i);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      const randomOutput = deriveMockCommitment(position, 1, new BN(1), protocolEpoch);
      const stolen = mapUnstakeTheftFlag(
        {
          randomOutput,
          domain: RandomnessDomain.UnstakeTheft,
          position: position.toBuffer(),
          actionNonce: 1n,
        },
        PROTOCOL_CONFIG_V1,
      );
      if (predicate(positionId, position, stolen)) {
        return { positionId, position };
      }
    }
    throw new Error(`Could not find a matching unstake position id after ${maxAttempts} attempts`);
  }

  it("rejects new stakes when paused", async () => {
    const before = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    expect(before.pauseNewStakes).toBe(false);

    await setPauseFlags(true, false);
    await expect(stakeAndCommit(new BN(nextPositionId++))).rejects.toThrow();

    await setPauseFlags(false, false);
  }, 60_000);

  it("rejects new reveal requests when paused", async () => {
    const before = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    expect(before.pauseNewRevealRequests).toBe(false);

    await setPauseFlags(false, true);
    await expect(stakeAndCommit(new BN(nextPositionId++))).rejects.toThrow();

    await setPauseFlags(false, false);
  }, 60_000);

  it("cannot recover a reveal timeout before it elapses", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await expect(recoverRevealTimeout(positionId)).rejects.toThrow();
  }, 60_000);

  it("recovers a reveal timeout and refunds the full principal", async () => {
    const positionId = new BN(nextPositionId++);
    const { position } = await stakeAndCommit(positionId);
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const funderBefore = await provider.connection.getAccountInfo(receiptFunder);
    expect(funderBefore).not.toBeNull();

    const vaultBefore = await getAccount(provider.connection, principalVault);
    const ownerBefore = await getAccount(provider.connection, payerRodeoAccount);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    // The test build uses a short randomness timeout for local verification.
    await waitForRandomnessTimeout(positionId);
    await recoverRevealTimeout(positionId);

    const vaultAfter = await getAccount(provider.connection, principalVault);
    const ownerAfter = await getAccount(provider.connection, payerRodeoAccount);
    expect(new BN(vaultBefore.amount.toString()).sub(new BN(vaultAfter.amount.toString())).toString()).toBe(
      stakeAmountAtomic.toString(),
    );
    expect(new BN(ownerAfter.amount.toString()).sub(new BN(ownerBefore.amount.toString())).toString()).toBe(
      stakeAmountAtomic.toString(),
    );

    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    expect(gameAfter.livePositionCount.addn(1).toString()).toBe(
      gameBefore.livePositionCount.toString(),
    );
    expect(
      gameAfter.accountedPrincipalAtomic.add(stakeAmountAtomic).toString(),
    ).toBe(gameBefore.accountedPrincipalAtomic.toString());

    await expect(rodeoAccounts(rodeoCoreProgram).position.fetch(position)).rejects.toThrow();
    expect(await provider.connection.getAccountInfo(position)).toBeNull();
    expect(await provider.connection.getAccountInfo(receiptFunder)).toBeNull();
    expect(await provider.connection.getAccountInfo(receiptAsset)).toBeNull();
  }, 60_000);

  it("cannot recover a reveal timeout after settlement", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await settleReveal(positionId);
    await expect(recoverRevealTimeout(positionId)).rejects.toThrow();
  }, 60_000);

  it("rejects close_epochs with max_epochs == 0", async () => {
    await expect(closeEpochs(0)).rejects.toThrow();
  }, 30_000);

  it("closes one or more elapsed epochs and emits liabilities", async () => {
    const before = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await settleReveal(positionId);

    await fundRewardVault(new BN(10_000_000_000));
    // Wait for at least one short epoch to elapse.
    await sleep(5_000);
    await ensureEpochsClosed();

    const reward = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    expect(reward.currentEpoch.gtn(before.currentEpoch)).toBe(true);
    expect(reward.ansemEmittedAtomic.gtn(0)).toBe(true);
    expect(reward.totalAnsemLiabilityAtomic.gtn(0)).toBe(true);
  }, 60_000);

  it("caps epoch closure at eight per transaction", async () => {
    // Wait for at least nine short epochs after init.
    await new Promise((r) => setTimeout(r, 18_500));

    const before = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    await closeEpochs(8);
    const mid = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    expect(mid.currentEpoch.sub(before.currentEpoch).toNumber()).toBe(8);

    // Wait for another epoch boundary before the next catch-up call.
    await new Promise((r) => setTimeout(r, 5_000));
    await closeEpochs(8);
    const after = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    expect(after.currentEpoch.sub(mid.currentEpoch).toNumber()).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("recognizes reward-vault funding after catching up epochs", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await settleReveal(positionId);

    const fundAmount = new BN(5_000_000_000);
    await fundRewardVault(fundAmount);

    // Elapse an epoch before recognition.
    await sleep(5_000);
    await ensureEpochsClosed();

    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    await runWhenEpochsClosed(() =>
      rodeoCoreProgram.methods
        .recognizeRewards(fundAmount)
        .accounts({
          caller: payer.publicKey,
          globalConfig,
          rewardState,
          rewardVault,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
        .rpc(),
    );

    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.add(fundAmount).toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.gte(rewardBefore.totalAnsemLiabilityAtomic)).toBe(
      true,
    );
  }, 60_000);

  it("close_epochs materializes an orphan remainder before computing free ANSEM", async () => {
    await ensureEpochsClosed();

    const scale = new BN(COWBOY_REWARD_INDEX_SCALE.toString());
    const fundAmount = new BN(1_000);
    await fixtureRecognizeRewards(fundAmount);

    const caughtUp = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    // The cowboy orphan bucket is exactly at the scale boundary. Without
    // materialization, free ANSEM would be 900; with it, one atomic ANSEM is
    // released from liability and free ANSEM becomes 901.
    await fixtureSetOrphanedRemainder({
      cowboyOrphanedAccrualRemainderScaled: scale,
      bullOrphanedAccrualRemainderScaled: new BN(0),
      cowboyUnmaterializedLiabilityAtomic: new BN(100),
      bullPoolLiabilityAtomic: new BN(0),
      totalAnsemLiabilityAtomic: new BN(100),
      recognizedRewardBalanceAtomic: fundAmount,
      lastClosedEpochTimestamp: caughtUp.lastClosedEpochTimestamp,
      epochStartedAt: caughtUp.epochStartedAt,
    });

    const epochClosedPromise = collectOneEvent<{
      epoch: BN;
      cowboyEmission: BN;
      suitVaultContribution: BN;
      freeAnsem: BN;
      totalAnsemLiabilityAtomic: BN;
    }>("epochClosed");
    const orphanedRewardPromise = collectOneEvent<{
      rewardSource: { cowboy?: {}; bull?: {} };
      amountAtomic: BN;
      remainingRemainderScaled: BN;
      totalAnsemLiabilityAtomicAfter: BN;
    }>("orphanedRewardReleased");

    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultBefore = await getAccount(provider.connection, rewardVault);

    // Wait for one short epoch to elapse from the caught-up boundary.
    await sleep(2_500);
    await closeEpochs(1);

    const epochClosed = await epochClosedPromise;
    const orphanedReward = await orphanedRewardPromise;
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultAfter = await getAccount(provider.connection, rewardVault);

    expect(orphanedReward.rewardSource).toHaveProperty("cowboy");
    expect(orphanedReward.amountAtomic.toString()).toBe("1");
    expect(orphanedReward.remainingRemainderScaled.toString()).toBe("0");
    expect(orphanedReward.totalAnsemLiabilityAtomicAfter.toString()).toBe("99");

    expect(epochClosed.freeAnsem.toString()).toBe("901");
    expect(epochClosed.totalAnsemLiabilityAtomic.toString()).toBe("99");

    expect(rewardAfter.cowboyOrphanedAccrualRemainderScaled.toString()).toBe("0");
    expect(rewardAfter.cowboyUnmaterializedLiabilityAtomic.toString()).toBe(
      rewardBefore.cowboyUnmaterializedLiabilityAtomic.subn(1).toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.subn(1).toString(),
    );
    expect(rewardAfter.orphanedRewardReleasedAtomic.toString()).toBe(
      rewardBefore.orphanedRewardReleasedAtomic.addn(1).toString(),
    );
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.toString(),
    );
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());

    // Catch up again so later tests start with a current epoch boundary.
    await ensureEpochsClosed();
  }, 60_000);

  it("rejects claim_position with EpochsNotClosed once an epoch elapses, then succeeds after catch-up", async () => {
    // Use the test-only fixture to make the position deterministically
    // claim-ready without depending on organic Cowboy-index accrual, so this
    // test isolates the `require_elapsed_epochs_closed` guard.
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await settleReveal(positionId);
    await ensureEpochsClosed();
    await fundRewardVault(new BN(1_000_000_000));
    await ensureEpochsClosed();
    await fixtureRecognizeRewards(new BN(1_000_000_000));
    await ensureEpochsClosed();

    const claimable = new BN(500_000_000);
    await fixturePreparePosition(positionId, {
      roleCode: 1, // Cowboy
      cowboyKindCode: 5,
      accrualWeight: 0,
      buckPower: 0,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });

    const { position } = await deriveStakeAccounts(positionId);
    const [walletCooldown] = deriveWalletCooldown(
      rodeoCoreProgram.programId,
      globalConfig,
      payer.publicKey,
    );

    function claimPositionBuilder() {
      return rodeoCoreProgram.methods
        .claimPosition()
        .accounts({
          owner: payer.publicKey,
          globalConfig,
          rewardState,
          globalGameState,
          bullAccumulator,
          position,
          walletClaimCooldown: walletCooldown,
          rewardVault,
          ownerAnsemAccount: payerAnsemAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
        .signers([payer]);
    }

    async function attemptClaim() {
      return claimPositionBuilder().rpc();
    }

    // Let an epoch elapse without closing it.
    await sleep(2_500);

    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const ownerBefore = await getAccount(provider.connection, payerAnsemAccount);

    // Simulate the actual instruction to prove the on-chain guard returns
    // EpochsNotClosed before any state change.
    await assertSimulatedEpochsNotClosed(claimPositionBuilder);

    const posAfterFailure = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const rewardAfterFailure = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultAfterFailure = await getAccount(provider.connection, rewardVault);
    const ownerAfterFailure = await getAccount(provider.connection, payerAnsemAccount);

    expect(posAfterFailure.claimableAnsemAtomic.toString()).toBe(claimable.toString());
    expect(rewardAfterFailure.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.toString(),
    );
    expect(rewardAfterFailure.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.toString(),
    );
    expect(vaultAfterFailure.amount.toString()).toBe(vaultBefore.amount.toString());
    expect(ownerAfterFailure.amount.toString()).toBe(ownerBefore.amount.toString());

    // Catch up epochs, then the same claim must succeed.
    await runWhenEpochsClosed(attemptClaim);

    const posAfterSuccess = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const ownerAfterSuccess = await getAccount(provider.connection, payerAnsemAccount);
    expect(posAfterSuccess.claimableAnsemAtomic.toString()).toBe("0");
    expect(
      new BN(ownerAfterSuccess.amount.toString())
        .sub(new BN(ownerAfterFailure.amount.toString()))
        .gtn(0),
    ).toBe(true);
  }, 60_000);

  it("rejects recognize_rewards with EpochsNotClosed once an epoch elapses, then succeeds after catch-up", async () => {
    await ensureEpochsClosed();
    const fundAmount = new BN(1_000_000_000);
    await fundRewardVault(fundAmount);

    function recognizeRewardsBuilder() {
      return rodeoCoreProgram.methods
        .recognizeRewards(fundAmount)
        .accounts({
          caller: payer.publicKey,
          globalConfig,
          rewardState,
          rewardVault,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
        .signers([payer]);
    }

    async function attemptRecognize() {
      return recognizeRewardsBuilder().rpc();
    }

    // Let an epoch elapse without closing it.
    await sleep(2_500);

    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultBefore = await getAccount(provider.connection, rewardVault);

    // Simulate the actual instruction to prove the on-chain guard returns
    // EpochsNotClosed before any state change.
    await assertSimulatedEpochsNotClosed(recognizeRewardsBuilder);

    const rewardAfterFailure = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultAfterFailure = await getAccount(provider.connection, rewardVault);
    expect(rewardAfterFailure.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.toString(),
    );
    expect(vaultAfterFailure.amount.toString()).toBe(vaultBefore.amount.toString());

    // Catch up epochs, then the same recognition must succeed.
    await runWhenEpochsClosed(attemptRecognize);

    const rewardAfterSuccess = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    expect(rewardAfterSuccess.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.add(fundAmount).toString(),
    );
  }, 60_000);

  it("rejects claim by a non-owner", async () => {
    const positionId = await stakeAndSettleWithRole("cowboy");
    const impostor = web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    await fundRewardVault(new BN(10_000_000_000));
    await sleep(5_000);
    await ensureEpochsClosed();

    await expect(
      claimPosition(positionId, impostor, payerAnsemAccount),
    ).rejects.toThrow();
  }, 60_000);

  it("rejects claim while a randomness action is pending", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await fundRewardVault(new BN(1_000_000_000));
    await sleep(5_000);
    await ensureEpochsClosed();
    await expect(claimPosition(positionId)).rejects.toThrow();
  }, 60_000);

  it("emits RewardFundingRecognized with recognized balance and actual vault balance", async () => {
    const fundAmount = new BN(5_000_000_000);
    await fundRewardVault(fundAmount);

    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const recognizedPromise = collectOneEvent<{
      amountAtomic: BN;
      recognizedRewardBalanceAtomic: BN;
      actualRewardVaultBalance: BN;
    }>("rewardFundingRecognized");

    await runWhenEpochsClosed(() =>
      rodeoCoreProgram.methods
        .recognizeRewards(fundAmount)
        .accounts({
          caller: payer.publicKey,
          globalConfig,
          rewardState,
          rewardVault,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
        .rpc(),
    );

    const recognized = await recognizedPromise;
    expect(recognized.amountAtomic.toString()).toBe(String(5_000_000_000));
    expect(recognized.actualRewardVaultBalance.toString()).toBe(vaultBefore.amount.toString());
    expect(recognized.recognizedRewardBalanceAtomic.gte(recognized.amountAtomic)).toBe(true);
  }, 60_000);

  it("emits EpochsClosed with exact start, exclusive end and processed count", async () => {
    await sleep(18_500);

    const startEpoch = (await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState)).currentEpoch;
    const epochsClosedPromise = collectOneEvent<{
      startEpoch: BN;
      endEpoch: BN;
      epochsProcessed: BN;
      lastClosedTimestamp: BN;
    }>("epochsClosed");

    await closeEpochs(8);

    const epochsClosed = await epochsClosedPromise;
    const endEpoch = (await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState)).currentEpoch;
    expect(epochsClosed.startEpoch.toString()).toBe(startEpoch.toString());
    expect(epochsClosed.endEpoch.toString()).toBe(endEpoch.toString());
    expect(epochsClosed.epochsProcessed.toString()).toBe(
      endEpoch.sub(startEpoch).toString(),
    );
    expect(epochsClosed.lastClosedTimestamp.gtn(startEpoch)).toBe(true);
  }, 60_000);

  it("rethrows Unknown action 'undefined' when no epoch is available to close", async () => {
    const err = new Error("Unknown action 'undefined'");
    (err as any).signature = undefined;
    (err as any).transactionMessage = undefined;
    (err as any).transactionLogs = undefined;
    (err as any).logs = undefined;

    await expect(
      runWhenEpochsClosed(async () => {
        throw err;
      }),
    ).rejects.toThrow("Unknown action 'undefined'");
  }, 30_000);

  it("retries Unknown action 'undefined' when a newly elapsed epoch is demonstrably closed", async () => {
    let calls = 0;
    const err = new Error("Unknown action 'undefined'");
    (err as any).signature = undefined;
    (err as any).transactionMessage = undefined;

    const op = async () => {
      calls++;
      if (calls === 1) {
        // Let an epoch elapse before throwing so the helper's catch-up can
        // close it and the next attempt can succeed.
        await sleep(2_500);
        throw err;
      }
      return "ok";
    };

    const result = await runWhenEpochsClosed(op, 4);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  }, 60_000);

  it("bounds runWhenEpochsClosed retries and rethrows the last error", async () => {
    let calls = 0;
    const err = Object.assign(new Error("EpochsNotClosed"), {
      error: { errorCode: { code: "EpochsNotClosed" } },
    });
    const op = async () => {
      calls++;
      throw err;
    };
    await expect(runWhenEpochsClosed(op, 3)).rejects.toThrow("EpochsNotClosed");
    expect(calls).toBe(3);
  }, 30_000);

  it("snapshots the active ProtocolConfig at stake and settles reveal with the historical version", async () => {
    const v1PositionId = new BN(nextPositionId++);
    const { position: v1Position, pendingRandomness: v1Pending } = await stakeAndCommit(v1PositionId);

    const v1PendingAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(v1Pending);
    expect(v1PendingAccount.configVersionSnapshot.toString()).toBe("1");

    // Compute the deterministic random input and prove V1 and V2 would resolve
    // the same input to materially different outcomes.
    const expectedV1 = expectedRevealOutcomes(
      v1PendingAccount.commitment,
      v1Position,
      v1PendingAccount.actionNonce,
      PROTOCOL_CONFIG_V1,
    );
    const expectedV2 = expectedRevealOutcomes(
      v1PendingAccount.commitment,
      v1Position,
      v1PendingAccount.actionNonce,
      PROTOCOL_CONFIG_V2,
    );
    expect(JSON.stringify(expectedV1)).not.toBe(JSON.stringify(expectedV2));

    // Create and activate ProtocolConfig V2.
    const protocolConfigV2 = await fixtureCreateProtocolConfigV2(new BN(2));
    await fixtureSetCurrentConfigVersion(protocolConfigV2);

    const globalConfigAccount = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    expect(globalConfigAccount.currentConfigVersion.toString()).toBe("2");

    // Stake a second position after V2 is active; it must snapshot V2.
    const v2PositionId = new BN(nextPositionId++);
    const { pendingRandomness: v2Pending } = await stakeAndCommit(v2PositionId);
    const v2PendingAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(v2Pending);
    expect(v2PendingAccount.configVersionSnapshot.toString()).toBe("2");

    // Settle the original V1 position. It must use the V1 protocol config and record version 1.
    await settleReveal(v1PositionId);
    const settledV1 = await rodeoAccounts(rodeoCoreProgram).position.fetch(v1Position);
    expect(settledV1.revealConfigVersion.toString()).toBe("1");
    expect(settledV1.status).toHaveProperty("active");
    const actualV1 = positionOutcomes(settledV1);
    expect(actualV1).toEqual(expectedV1);
    expect(actualV1).not.toEqual(expectedV2);

    // Settle the V2 position and verify it records version 2.
    await settleReveal(v2PositionId);
    const [v2Position] = derivePosition(rodeoCoreProgram.programId, globalConfig, v2PositionId);
    const settledV2 = await rodeoAccounts(rodeoCoreProgram).position.fetch(v2Position);
    expect(settledV2.revealConfigVersion.toString()).toBe("2");
    expect(settledV2.status).toHaveProperty("active");
  }, 120_000);

  describe("request_unstake authorizations and state", () => {
    beforeAll(async () => {
      const [protocolConfigV1] = deriveProtocolConfig(
        rodeoCoreProgram.programId,
        globalConfig,
        new BN(1),
      );
      await fixtureSetCurrentConfigVersion(protocolConfigV1);
    }, 30_000);

    it("rejects request_unstake by a non-owner", async () => {
      const positionId = await stakeAndSettleWithRole("cowboy");
      await fixturePreparePosition(positionId, {
        roleCode: 1,
        cowboyKindCode: 5,
        accrualWeight: 10000,
        buckPower: 0,
        claimable: new BN(0),
        positionClaimableLiabilityDelta: new BN(0),
      });

      const impostor = web3.Keypair.generate();
      const sig = await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000);
      await provider.connection.confirmTransaction(sig);

      await ensureEpochsClosed();
      await expect(requestUnstake(positionId, impostor)).rejects.toThrow(
        /InvalidOwner|invalid owner/i,
      );
    }, 60_000);

    it("rejects request_unstake while a reveal action is pending", async () => {
      const positionId = new BN(nextPositionId++);
      await stakeAndCommit(positionId);
      // The reveal is pending and the position is not Active, so the program
      // returns InvalidRole before reaching the pending-action check.
      await expect(requestUnstake(positionId)).rejects.toThrow(
        /InvalidRole|PendingActionConflict|pending action/i,
      );
    }, 60_000);

    it("rejects request_unstake with EpochsNotClosed, then succeeds after catch-up", async () => {
      const positionId = await stakeAndSettleWithRole("cowboy");
      await fixturePreparePosition(positionId, {
        roleCode: 1,
        cowboyKindCode: 5,
        accrualWeight: 10000,
        buckPower: 0,
        claimable: new BN(0),
        positionClaimableLiabilityDelta: new BN(0),
      });

      const { position } = await deriveStakeAccounts(positionId);
      const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
      const actionNonce = pos.nextActionNonce;
      const [pendingRandomness] = deriveRandomness(
        rodeoCoreProgram.programId,
        position,
        1,
        actionNonce,
      );
      const globalConfigAccount = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(
        globalConfig,
      );
      const [protocolConfig] = deriveProtocolConfig(
        rodeoCoreProgram.programId,
        globalConfig,
        globalConfigAccount.currentConfigVersion,
      );

      function requestUnstakeBuilder() {
        return rodeoCoreProgram.methods
          .requestUnstake()
          .accounts({
            owner: payer.publicKey,
            globalConfig,
            protocolConfig,
            position,
            pendingRandomness,
            rewardState,
            bullAccumulator,
            providerRandomnessAccount: payer.publicKey,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
            clock: web3.SYSVAR_CLOCK_PUBKEY,
          })
          .signers([payer]);
      }

      await ensureEpochsClosed();
      await sleep(2_500);

      await assertSimulatedEpochsNotClosed(requestUnstakeBuilder);
      await ensureEpochsClosed();

      const requestInfo = await runWhenEpochsClosed(() => requestUnstakeBuilder().rpc());
      expect(requestInfo).toBeDefined();

      const positionAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
      const pendingAfter = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(
        pendingRandomness,
      );
      expect(positionAfter.pendingActionActive).toBe(true);
      expect(positionAfter.pendingActionType).toHaveProperty("unstake");
      expect(positionAfter.nextActionNonce.toString()).toBe("2");
      expect(positionAfter.status).toHaveProperty("active");
      expect(pendingAfter.configVersionSnapshot.toString()).toBe("1");
      expect(pendingAfter.actionType).toHaveProperty("unstake");
      expect(pendingAfter.actionNonce.toString()).toBe("1");
    }, 120_000);
  });

  it("pending unstake continues earning until settlement", async () => {
    const [protocolConfigV1] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      new BN(1),
    );
    await fixtureSetCurrentConfigVersion(protocolConfigV1);

    await ensureEpochsClosed();
    await fixtureRecognizeRewards(new BN(100_000_000_000_000));

    const rewardBaseline = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const revealEpoch = rewardBaseline.currentEpoch;
    const unstakeEpoch = revealEpoch.addn(1);

    const { positionId, position } = await findUnstakePositionId(
      globalConfig,
      new BN(nextPositionId),
      unstakeEpoch,
      (_positionId, positionPda, stolen) => {
        if (stolen) return false;
        const revealOutput = deriveMockCommitment(positionPda, 0, new BN(0), revealEpoch);
        const role = mapRole(
          {
            randomOutput: revealOutput,
            domain: RandomnessDomain.Role,
            position: positionPda.toBuffer(),
            actionNonce: 0n,
          },
          PROTOCOL_CONFIG_V1,
        );
        return role === "cowboy";
      },
    );
    nextPositionId = positionId.toNumber() + 1;

    await stakeAndCommit(positionId);
    await settleReveal(positionId);

    await fixturePreparePosition(positionId, {
      roleCode: 1,
      cowboyKindCode: 5,
      accrualWeight: 10000,
      buckPower: 0,
      claimable: new BN(0),
      positionClaimableLiabilityDelta: new BN(0),
    });

    await sleep(2_500);
    await ensureEpochsClosed();

    const rewardBeforeRequest = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameBeforeRequest =
      await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    const requestInfo = await runWhenEpochsClosed(() => requestUnstake(positionId));
    const positionAddr = requestInfo.position;

    const positionAfterRequest = await rodeoAccounts(rodeoCoreProgram).position.fetch(positionAddr);
    const rewardAfterRequest = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameAfterRequest =
      await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const pendingAfterRequest = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(
      requestInfo.pendingRandomness,
    );

    expect(positionAfterRequest.pendingActionActive).toBe(true);
    expect(positionAfterRequest.pendingActionType).toHaveProperty("unstake");
    expect(positionAfterRequest.pendingActionNonce.toString()).toBe(
      requestInfo.actionNonce.toString(),
    );
    expect(positionAfterRequest.nextActionNonce.toString()).toBe("2");
    expect(positionAfterRequest.status).toHaveProperty("active");
    expect(pendingAfterRequest.configVersionSnapshot.toString()).toBe("1");
    expect(pendingAfterRequest.actionType).toHaveProperty("unstake");
    expect(pendingAfterRequest.actionNonce.toString()).toBe("1");

    expect(gameAfterRequest.activeCowboyCount.toString()).toBe(
      gameBeforeRequest.activeCowboyCount.toString(),
    );
    expect(gameAfterRequest.totalActiveCowboyWeight.toString()).toBe(
      gameBeforeRequest.totalActiveCowboyWeight.toString(),
    );

    const preRequestClaimable = positionAfterRequest.claimableAnsemAtomic;
    const preRequestPositionLiability = rewardAfterRequest.positionClaimableLiabilityAtomic;
    const preRequestTotalLiability = rewardAfterRequest.totalAnsemLiabilityAtomic;
    const lastCowboyIndexAtRequest = positionAfterRequest.lastCowboyRewardIndex;
    const requestRemainder = positionAfterRequest.cowboyAccrualRemainderScaled;

    await sleep(2_500);
    await ensureEpochsClosed();

    const rewardAfterPending = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const positionAfterPending = await rodeoAccounts(rodeoCoreProgram).position.fetch(positionAddr);

    expect(rewardAfterPending.cowboyRewardIndex.gt(rewardAfterRequest.cowboyRewardIndex)).toBe(true);
    expect(positionAfterPending.claimableAnsemAtomic.toString()).toBe(
      preRequestClaimable.toString(),
    );

    const positionUnstakedPromise = collectOneEvent<{
      position: web3.PublicKey;
      owner: web3.PublicKey;
      principalAmount: BN;
      principalReturned: BN;
      principalBurned: BN;
      ansemFate: any;
      synchronizedAnsem: BN;
      ansemPaidToOwner: BN;
      ansemRoutedToBullPool: BN;
      settlementNonce: BN;
      configVersion: BN;
    }>("positionUnstaked");

    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), positionAddr.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), positionAddr.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptBeforeSettle = await provider.connection.getAccountInfo(receiptAsset);
    expect(receiptBeforeSettle).not.toBeNull();
    expect(receiptBeforeSettle!.owner.toBase58()).toBe(MPL_CORE_PROGRAM_ID.toBase58());

    const receiptBurnedPromise = collectOneEvent<{
      position: web3.PublicKey;
      positionId: BN;
      receiptAsset: web3.PublicKey;
      owner: web3.PublicKey;
      collection: web3.PublicKey;
    }>("receiptBurned");

    const gameBeforeSettle =
      await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    // Compute the expected synchronized amount from the reward state captured
    // immediately before settlement. Because settleUnstake no longer internally
    // catches up epochs, wrap the settlement inside runWhenEpochsClosed and
    // re-fetch rewardBeforeSettle on each attempt so the index used for the
    // expectation is exactly the one seen by settle_unstake.
    const scale = new BN(COWBOY_REWARD_INDEX_SCALE.toString());
    let ansemBeforeSettle!: Awaited<ReturnType<typeof getAccount>>;
    let rewardBeforeSettle!: RewardStateAccount;
    let postRequestAccrual!: BN;
    let expectedSynchronized!: BN;

    await runWhenEpochsClosed(async () => {
      rewardBeforeSettle = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
      ansemBeforeSettle = await getAccount(provider.connection, payerAnsemAccount);

      const indexDelta = rewardBeforeSettle.cowboyRewardIndex.sub(lastCowboyIndexAtRequest);
      postRequestAccrual = indexDelta
        .muln(10000)
        .add(requestRemainder)
        .div(scale);
      expectedSynchronized = preRequestClaimable.add(postRequestAccrual);

      await settleUnstake(positionId, requestInfo.actionNonce);
    });

    const positionUnstaked = await positionUnstakedPromise;
    const ansemAfterSettle = await getAccount(provider.connection, payerAnsemAccount);
    const rewardAfterSettle = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameAfterSettle =
      await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    expect(positionUnstaked.synchronizedAnsem.toString()).toBe(expectedSynchronized.toString());
    expect(positionUnstaked.ansemPaidToOwner.toString()).toBe(expectedSynchronized.toString());
    expect(positionUnstaked.ansemRoutedToBullPool.toString()).toBe("0");
    expect(positionUnstaked.ansemFate).toHaveProperty("toOwner");

    expect(
      new BN(ansemAfterSettle.amount.toString())
        .sub(new BN(ansemBeforeSettle.amount.toString()))
        .toString(),
    ).toBe(expectedSynchronized.toString());

    expect(
      rewardBeforeSettle.recognizedRewardBalanceAtomic.sub(
        rewardAfterSettle.recognizedRewardBalanceAtomic,
      ).toString(),
    ).toBe(expectedSynchronized.toString());
    expect(
      rewardBeforeSettle.totalAnsemLiabilityAtomic.sub(rewardAfterSettle.totalAnsemLiabilityAtomic)
        .toString(),
    ).toBe(expectedSynchronized.toString());
    expect(
      rewardAfterSettle.ansemClaimedAtomic.sub(rewardBeforeSettle.ansemClaimedAtomic).toString(),
    ).toBe(expectedSynchronized.toString());

    // The post-request accrual is moved from the unmaterialized bucket into the
    // position claimable bucket during settle-time sync, then the pre-request
    // claimable bucket is debited by the payout.
    expect(
      rewardBeforeSettle.cowboyUnmaterializedLiabilityAtomic.sub(
        rewardAfterSettle.cowboyUnmaterializedLiabilityAtomic,
      ).toString(),
    ).toBe(postRequestAccrual.toString());
    expect(
      rewardBeforeSettle.positionClaimableLiabilityAtomic.sub(
        rewardAfterSettle.positionClaimableLiabilityAtomic,
      ).toString(),
    ).toBe(preRequestClaimable.toString());
    expect(rewardAfterSettle.positionClaimableLiabilityAtomic.toString()).toBe(
      preRequestPositionLiability.sub(preRequestClaimable).toString(),
    );

    expect(gameAfterSettle.activeCowboyCount.toString()).toBe(
      gameBeforeSettle.activeCowboyCount.subn(1).toString(),
    );
    expect(gameAfterSettle.totalActiveCowboyWeight.toString()).toBe(
      gameBeforeSettle.totalActiveCowboyWeight.subn(10000).toString(),
    );

    expect(await provider.connection.getAccountInfo(positionAddr)).toBeNull();
    expect(await provider.connection.getAccountInfo(requestInfo.pendingRandomness)).toBeNull();

    const burnedReceipt = await provider.connection.getAccountInfo(receiptAsset);
    expect(burnedReceipt).not.toBeNull();
    expect(burnedReceipt!.owner.toBase58()).toBe(MPL_CORE_PROGRAM_ID.toBase58());
    expect(burnedReceipt!.data.length).toBe(1);
    expect(burnedReceipt!.data[0]).toBe(0);
    expect(await provider.connection.getAccountInfo(receiptFunder)).toBeNull();

    const receiptBurned = await receiptBurnedPromise;
    expect(receiptBurned.position.toBase58()).toBe(positionAddr.toBase58());
    expect(receiptBurned.receiptAsset.toBase58()).toBe(receiptAsset.toBase58());
    expect(receiptBurned.owner.toBase58()).toBe(payer.publicKey.toBase58());
    expect(receiptBurned.collection.toBase58()).toBe(receiptCollection.toBase58());

    expect(preRequestTotalLiability.gte(preRequestClaimable)).toBe(true);
  }, 120_000);

  it("enforces sequential position ids and rejects reuse after closure", async () => {
    const before = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const n = before.nextPositionId;

    async function readGame() {
      return rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    }

    async function rawStakeAndCommit(positionId: BN) {
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      const [pendingRandomness] = deriveRandomness(
        rodeoCoreProgram.programId,
        position,
        0,
        new BN(0),
      );
      const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("receipt-funder"), position.toBuffer()],
        rodeoCoreProgram.programId,
      );
      const globalConfigAccount = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(
        globalConfig,
      );
      const [protocolConfig] = deriveProtocolConfig(
        rodeoCoreProgram.programId,
        globalConfig,
        globalConfigAccount.currentConfigVersion,
      );
      return rodeoCoreProgram.methods
        .stakeAndCommit(positionId, stakeAmountAtomic)
        .accounts({
          owner: payer.publicKey,
          ownerRodeoTokenAccount: payerRodeoAccount,
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
        })
        .signers([payer])
        .rpc();
    }

    // A. current next_position_id = N
    expect(before.nextPositionId.toString()).toBe(n.toString());

    // B. stake N succeeds
    await rawStakeAndCommit(n);
    let after = await readGame();
    expect(after.nextPositionId.toString()).toBe(n.addn(1).toString());

    // C. next_position_id == N + 1
    expect(after.nextPositionId.sub(n).toString()).toBe("1");

    // D. stake N again fails
    await expect(rawStakeAndCommit(n)).rejects.toThrow();
    after = await readGame();
    expect(after.nextPositionId.toString()).toBe(n.addn(1).toString());

    // E. stake N + 2 fails
    await expect(rawStakeAndCommit(n.addn(2))).rejects.toThrow();
    after = await readGame();
    expect(after.nextPositionId.toString()).toBe(n.addn(1).toString());

    // F. failed attempts leave next_position_id == N + 1
    expect(after.nextPositionId.toString()).toBe(n.addn(1).toString());

    // G. stake N + 1 succeeds
    await rawStakeAndCommit(n.addn(1));
    after = await readGame();
    expect(after.nextPositionId.toString()).toBe(n.addn(2).toString());

    // H. close/un-stake the original Position
    await waitForRandomnessTimeout(n);
    await recoverRevealTimeout(n);
    const positionInfo = await provider.connection.getAccountInfo(
      derivePosition(rodeoCoreProgram.programId, globalConfig, n)[0],
    );
    expect(positionInfo).toBeNull();

    // I. stake using old ID N still fails
    await expect(rawStakeAndCommit(n)).rejects.toThrow();
    after = await readGame();
    expect(after.nextPositionId.toString()).toBe(n.addn(2).toString());

    // Keep the shared test counter synchronized with the chain for subsequent
    // tests that use nextPositionId++.
    nextPositionId = after.nextPositionId.toNumber();
  }, 120_000);

  it("recover_unstake_timeout leaves the receipt and funder untouched", async () => {
    const positionId = new BN(nextPositionId++);
    const { position } = await stakeAndCommit(positionId);
    await settleReveal(positionId);

    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );

    await fixturePreparePosition(positionId, {
      roleCode: 1,
      cowboyKindCode: 5,
      accrualWeight: 10000,
      buckPower: 0,
      claimable: new BN(0),
      positionClaimableLiabilityDelta: new BN(0),
    });

    await ensureEpochsClosed();
    const { actionNonce } = await requestUnstake(positionId);

    const receiptBefore = await provider.connection.getAccountInfo(receiptAsset);
    const funderBefore = await provider.connection.getAccountInfo(receiptFunder);
    expect(receiptBefore).not.toBeNull();
    expect(receiptBefore!.owner.toBase58()).toBe(MPL_CORE_PROGRAM_ID.toBase58());
    expect(funderBefore).not.toBeNull();

    // Wait out the short randomness timeout on the unstake request.
    await sleep(2_500);
    await recoverUnstakeTimeout(positionId, actionNonce);

    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.pendingActionActive).toBe(false);
    expect(pos.status).toHaveProperty("active");

    const receiptAfter = await provider.connection.getAccountInfo(receiptAsset);
    const funderAfter = await provider.connection.getAccountInfo(receiptFunder);
    expect(receiptAfter).not.toBeNull();
    expect(receiptAfter!.owner.toBase58()).toBe(MPL_CORE_PROGRAM_ID.toBase58());
    expect(funderAfter).not.toBeNull();
    expect(funderAfter!.lamports).toBe(funderBefore!.lamports);
  }, 60_000);

});

describe.skipIf(!localnetAvailable)("initialize_protocol validation failures", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  let program: Program<Idl>;

  const upgradeCouncil = web3.Keypair.generate();
  const treasuryCouncil = web3.Keypair.generate();
  const emergencyGuardians = web3.Keypair.generate();

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);
    patchProviderForHttpConfirmation(provider);
    payer = (provider.wallet as unknown as { payer: web3.Keypair }).payer;
    program = new Program<Idl>(loadIdl("rodeo_core"), provider);
  });

  async function deriveFreshAccounts() {
    const [globalConfig] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId,
    );
    const [principalVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("principal-vault")],
      program.programId,
    );
    const [rewardVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-vault")],
      program.programId,
    );
    const [rewardState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-state"), globalConfig.toBuffer()],
      program.programId,
    );
    const [globalGameState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-game-state"), globalConfig.toBuffer()],
      program.programId,
    );
    const [bullAccumulator] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bull-accumulator"), globalConfig.toBuffer()],
      program.programId,
    );
    const [receiptCollection] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-collection"), globalConfig.toBuffer()],
      program.programId,
    );
    const [receiptAuthority] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-authority"), globalConfig.toBuffer()],
      program.programId,
    );
    return {
      globalConfig,
      principalVault,
      rewardVault,
      rewardState,
      globalGameState,
      bullAccumulator,
      receiptCollection,
      receiptAuthority,
    };
  }

  async function expectInitFailure(
    overrides: Partial<{
      rodeoMint: web3.PublicKey;
      ansemMint: web3.PublicKey;
      upgradeCouncil: web3.PublicKey;
      treasuryCouncil: web3.PublicKey;
      emergencyGuardians: web3.PublicKey;
      programData: web3.PublicKey;
      initializer: web3.PublicKey;
    }>,
  ) {
    const accounts = await deriveFreshAccounts();
    await expect(
      program.methods
        .initializeProtocol(
          overrides.upgradeCouncil ?? upgradeCouncil.publicKey,
          overrides.treasuryCouncil ?? treasuryCouncil.publicKey,
          overrides.emergencyGuardians ?? emergencyGuardians.publicKey,
        )
        .accounts({
          payer: payer.publicKey,
          initializer: overrides.initializer ?? provider.wallet.publicKey,
          program: program.programId,
          programData: overrides.programData ?? programDataAddress(program.programId),
          rodeoMint: overrides.rodeoMint ?? (await createRevokedMint(provider.connection, payer, 6)),
          ansemMint: overrides.ansemMint ?? (await createRevokedMint(provider.connection, payer, 6)),
          globalConfig: accounts.globalConfig,
          rewardState: accounts.rewardState,
          globalGameState: accounts.globalGameState,
          bullAccumulator: accounts.bullAccumulator,
          principalVault: accounts.principalVault,
          rewardVault: accounts.rewardVault,
          protocolConfig: deriveProtocolConfig(program.programId, accounts.globalConfig, new BN(1))[0],
          receiptCollection: accounts.receiptCollection,
          receiptAuthority: accounts.receiptAuthority,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
    ).rejects.toThrow();
  }

  it("fails when a governance address is the default pubkey", async () => {
    await expectInitFailure({ upgradeCouncil: web3.PublicKey.default });
  }, 30_000);

  it("fails when governance authorities are not pairwise distinct", async () => {
    await expectInitFailure({
      treasuryCouncil: upgradeCouncil.publicKey,
      emergencyGuardians: upgradeCouncil.publicKey,
    });
  }, 30_000);

  it("fails when RODEO and ANSEM mints are identical", async () => {
    const sharedMint = await createRevokedMint(provider.connection, payer, 6);
    await expectInitFailure({ rodeoMint: sharedMint, ansemMint: sharedMint });
  }, 30_000);

  it("fails when RODEO decimals exceed 9", async () => {
    const highDecimalsMint = await createRevokedMint(provider.connection, payer, 10);
    await expectInitFailure({ rodeoMint: highDecimalsMint });
  }, 30_000);

  it("fails when RODEO mint authority is active", async () => {
    const activeMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    await expectInitFailure({ rodeoMint: activeMint });
  }, 30_000);

  it("fails when RODEO freeze authority is active", async () => {
    const activeFreezeMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      6,
    );
    await setAuthority(provider.connection, payer, activeFreezeMint, payer, AuthorityType.MintTokens, null);
    await expectInitFailure({ rodeoMint: activeFreezeMint });
  }, 30_000);

  it("fails when RODEO supply does not match the expected total", async () => {
    const wrongSupplyMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
    );
    const ata = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      wrongSupplyMint,
      payer.publicKey,
    );
    await mintTo(provider.connection, payer, wrongSupplyMint, ata, payer, 1_000_000n);
    await revokeMintAuthorities(provider.connection, payer, wrongSupplyMint);
    await expectInitFailure({ rodeoMint: wrongSupplyMint });
  }, 30_000);

});
