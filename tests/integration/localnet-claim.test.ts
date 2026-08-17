import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import {
  PROTOCOL_CONFIG_V1,
  PROTOCOL_CONFIG_V2,
  RandomnessDomain,
  mapCowboyKind,
  mapRole,
  mapUnstakeTheftFlag,
} from "@rodeo/protocol-definition";
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
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BullRegistryTracker,
  deriveBullRegistryPda,
  getLamportBalance,
  accountExists,
  stageRevealProofForBull,
  stageBullProofBuffer,
  type StagedBullProof,
} from "./bull-registry-tracker.js";
import {
  emptyOwnerTreeRoot,
  ownerProof,
  bullProof,
  buildUnstakePayload,
  serializeBullProofPayload,
  verifyOwnerProof,
  verifyBullProof,
  type BullLeaf,
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
  pendingRandomness: web3.PublicKey;
  position: web3.PublicKey;
  snapshotRoot: number[];
  snapshotVersion: BN;
  snapshotTotalCount: BN;
  snapshotTotalPower: BN;
  refundRecipient: web3.PublicKey;
  expectedPayloadLength: number;
  finalized: boolean;
  consumed: boolean;
  payload: number[];
  bump: number;
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
  configVersionSnapshot: BN;
  settled: boolean;
  bump: number;
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

// This suite must run against a program binary built WITHOUT `test-short-epoch`
// (production-length epochs) plus `test-fixtures`, so that
// `require_elapsed_epochs_closed` stays compiled and active in claim_position
// and recognize_rewards, yet can never trip during the test run. Deterministic
// claim-ready state is established via the test-only fixture instructions
// instead of relying on real epoch emissions.
const skipClaimSuite =
  !localnetAvailable ||
  process.env.RODEO_TEST_SUITE === "epoch" ||
  process.env.RODEO_TEST_SUITE === "mplcore";

describe.skipIf(skipClaimSuite)("Anchor localnet workspace (claim profile)", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  let rodeoCoreProgram: Program<Idl>;
  const otherPrograms = {} as Record<string, Program<Idl>>;

  let rodeoMint: web3.PublicKey;
  let ansemMint: web3.PublicKey;
  let globalConfig: web3.PublicKey;
  let protocolConfigV1: web3.PublicKey;
  let rewardState: web3.PublicKey;
  let globalGameState: web3.PublicKey;
  let bullAccumulator: web3.PublicKey;
  let principalVault: web3.PublicKey;
  let rewardVault: web3.PublicKey;
  let receiptCollection: web3.PublicKey;
  let receiptAuthority: web3.PublicKey;
  let payerRodeoAccount: web3.PublicKey;
  let payerAnsemAccount: web3.PublicKey;

  const upgradeCouncil = web3.Keypair.generate();
  const treasuryCouncil = web3.Keypair.generate();
  const emergencyGuardians = web3.Keypair.generate();

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);
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
    [protocolConfigV1] = deriveProtocolConfig(
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
        protocolConfig: protocolConfigV1,
        receiptCollection,
        receiptAuthority,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }, 60_000);

  beforeEach(async () => {
    if (!localnetAvailable) return;
    // Some tests switch the active ProtocolConfig to V2; reset to V1 before
    // every test so helpers and assertions that assume V1 stay consistent.
    await fixtureSetCurrentConfigVersion(protocolConfigV1);
  }, 30_000);

  const stakeAmountAtomic = new BN(100_000_000_000);
  const COWBOY_REWARD_INDEX_SCALE = new BN("1000000000000000000");
  const REWARD_PER_WEIGHT_SCALE = new BN("1000000000000000000");
  let nextPositionId = 0;
  const bullRegistryTracker = new BullRegistryTracker();


  async function syncTrackerWithChain(): Promise<void> {
    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const chain = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const built = bullRegistryTracker.buildRegistry();
    expect(Buffer.from(built.rootNode.hash).equals(
      Buffer.from(new Uint8Array(chain.ownerTreeRoot)),
    )).toBe(true);
    expect(built.rootNode.count).toBe(BigInt(chain.totalBullCount.toString()));
    expect(built.rootNode.power).toBe(BigInt(chain.totalBuckPower.toString()));
  }

  async function assertTrackerMatchesChain(): Promise<void> {
    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const chain = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const built = bullRegistryTracker.buildRegistry();
    expect(Buffer.from(built.rootNode.hash).equals(
      Buffer.from(new Uint8Array(chain.ownerTreeRoot)),
    )).toBe(true);
    expect(built.rootNode.count).toBe(BigInt(chain.totalBullCount.toString()));
    expect(built.rootNode.power).toBe(BigInt(chain.totalBuckPower.toString()));
  }

  async function revealBullWithProof(
    positionId: BN,
    player: web3.Keypair,
    prover: web3.Keypair,
  ): Promise<any> {
    // Synchronize tracker against chain and assert parity before proof generation.
    await syncTrackerWithChain();

    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);

    // The new Bull leaf is built from proof-provided values, but the actual
    // buck_power will be computed by the protocol from randomness. For the
    // non-membership proof, the current_bull leaf is the canonical empty leaf.
    const bullLeaf: BullLeaf = {
      position,
      positionId: BigInt(positionId.toString()),
      owner: player.publicKey,
      buckPower: 0,
      revealConfigVersion: 1n,
    };

    const nonce = new BN(1);
    const staged = await stageRevealProofForBull(
      rodeoCoreProgram,
      globalConfig,
      position,
      pendingRandomness,
      prover,
      nonce,
      bullRegistryTracker,
      bullLeaf,
    );


    // Verify staged buffer exists and is finalized but not consumed
    const bufferInfo = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfo).not.toBeNull();
    expect(bufferInfo!.data.length).toBeGreaterThan(0);
    const bufferAccount = await rodeoAccounts(rodeoCoreProgram).bullProofBuffer.fetch(staged.bufferPda);
    expect(bufferAccount.consumed).toBe(false);
    expect(bufferAccount.finalized).toBe(true);
    expect(bufferAccount.refundRecipient.equals(prover.publicKey)).toBe(true);

    // Record pre-state for close/refund evidence.
    const bufferLamportsBefore = bufferInfo!.lamports;
    const bufferDataLenBefore = bufferInfo!.data.length;
    const proverBalanceBeforeSettle = await getLamportBalance(provider, prover.publicKey);
    const playerBalanceBeforeSettle = await getLamportBalance(provider, player.publicKey);

    // Call production settleReveal with real BullProofBuffer and independent prover/refund
    await settleReveal(positionId, player, {
      bufferPda: staged.bufferPda,
      refundRecipient: staged.refundRecipient,
    });

    // Fetch settled position and update tracker with the actual buck power the
    // protocol assigned from randomness.
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const actualBull: BullLeaf = {
      position,
      positionId: BigInt(positionId.toString()),
      owner: player.publicKey,
      buckPower: pos.buckPower,
      revealConfigVersion: BigInt(pos.revealConfigVersion.toString()),
    };
    bullRegistryTracker.registerBull(player.publicKey, actualBull);
    await assertTrackerMatchesChain();

    return {
      ...staged,
      position,
      pendingRandomness,
      bufferLamportsBefore,
      bufferDataLenBefore,
      bufferAccount,
      proverBalanceBeforeSettle,
      playerBalanceBeforeSettle,
    } as any;
  }

  async function unstakeBullWithProof(
    positionId: BN,
    player: web3.Keypair,
    prover: web3.Keypair,
    claimable: BN,
  ): Promise<any> {
    // 1. Make the Bull unstake-eligible and credit claimable ANSEM via test fixture.
    const { position } = await deriveStakeAccounts(positionId);
    let pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    await fixturePreparePosition(positionId, {
      roleCode: pos.role.cowboy ? 1 : pos.role.bull ? 2 : 0,
      cowboyKindCode: pos.cowboyKind.desperado
        ? 254
        : pos.cowboyKind.rank
          ? pos.cowboyKind.rank[0]
          : 0,
      accrualWeight: pos.accrualWeight,
      buckPower: pos.buckPower,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });

    // Ensure recognized ANSEM reserve covers the claimable amount.
    await ensureRecognizedReserve(claimable);

    // 2. Request real Bull unstake.
    const { actionNonce } = await requestUnstake(positionId, player);

    // Re-fetch position after request to capture pending action state.
    pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.pendingActionActive).toBe(true);
    expect(pos.pendingActionType.unstake).toBeTruthy();

    // 3. Synchronize tracker and assert parity before proof generation.
    await syncTrackerWithChain();

    // 4. Build and locally verify the current removal proof.
    const registry = bullRegistryTracker.buildRegistry();
    const payload = buildUnstakePayload(registry, player.publicKey, position);
    expect(payload.schemaVersion).toBe(2);
    expect(payload.sectionBitmap).toBe(0x28); // CURRENT_OWNER | REMOVE_BULL
    expect(payload.currentOwner).not.toBeNull();
    expect(payload.removeBull).not.toBeNull();
    expect(payload.currentOwner!.leaf.owner.equals(player.publicKey)).toBe(true);
    expect(payload.currentOwner!.leaf.activeBullCount).toBe(1n);
    expect(payload.removeBull!.leaf.position.equals(position)).toBe(true);
    expect(payload.removeBull!.leaf.owner.equals(player.publicKey)).toBe(true);
    expect(payload.removeBull!.leaf.buckPower).toBe(pos.buckPower);
    expect(payload.removeBull!.leaf.revealConfigVersion).toBe(BigInt(pos.revealConfigVersion.toString()));

    // Verify the owner proof hashes to the current BullRegistry root.
    verifyOwnerProof(player.publicKey, payload.currentOwner!, registry.rootNode);
    // Verify the remove-bull proof hashes to the bull tree root committed by the owner leaf.
    verifyBullProof(position, payload.removeBull!, {
      hash: payload.currentOwner!.leaf.bullTreeRoot,
      count: payload.currentOwner!.leaf.activeBullCount,
      power: payload.currentOwner!.leaf.totalBuckPower,
    });

    // 5. Stage the BullProofBuffer with the removal payload.
    const [pendingRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      position,
      1,
      actionNonce,
    );
    const nonce = new BN(2);
    const payloadBytes = serializeBullProofPayload(payload);
    const staged = await stageBullProofBuffer(
      rodeoCoreProgram,
      globalConfig,
      position,
      pendingRandomness,
      prover,
      nonce,
      { unstake: {} },
      payloadBytes,
    );

    const bufferInfo = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfo).not.toBeNull();
    const bufferLamportsBefore = bufferInfo!.lamports;
    const bufferDataLenBefore = bufferInfo!.data.length;
    const bufferAccount = await rodeoAccounts(rodeoCoreProgram).bullProofBuffer.fetch(staged.bufferPda);
    expect(bufferAccount.consumed).toBe(false);
    expect(bufferAccount.finalized).toBe(true);
    expect(bufferAccount.refundRecipient.equals(prover.publicKey)).toBe(true);

    // 6. Capture pre-settlement balances and state.
    const playerRodeoAccount = getAssociatedTokenAddressSync(rodeoMint, player.publicKey);
    const playerAnsemAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      ansemMint,
      player.publicKey,
    );
    const playerBalanceBeforeSettle = await getLamportBalance(provider, player.publicKey);
    const proverBalanceBeforeSettle = await getLamportBalance(provider, prover.publicKey);
    const receiptFunder = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    )[0];
    const receiptFunderBefore = await getLamportBalance(provider, receiptFunder);
    const playerRodeoBefore = await getAccount(provider.connection, playerRodeoAccount);
    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const rodeoMintInfoBefore = await getMint(provider.connection, rodeoMint);
    const playerAnsemBefore = await getAccount(provider.connection, playerAnsemAccount);
    const rewardVaultBefore = await getAccount(provider.connection, rewardVault);

    // 7. Settle the real Bull unstake with the proof buffer and independent prover refund.
    await settleUnstake(positionId, actionNonce, payer, {
      bufferPda: staged.bufferPda,
      refundRecipient: staged.refundRecipient,
    }, {
      ownerRodeoAccount: playerRodeoAccount,
      ownerAnsemAccount: playerAnsemAccount,
    });

    const actionNonceOut = actionNonce;

    // 8. Update tracker after successful removal.
    bullRegistryTracker.unregisterBull(player.publicKey, position);
    await assertTrackerMatchesChain();

    return {
      position,
      pendingRandomness,
      bufferPda: staged.bufferPda,
      bufferLamportsBefore,
      bufferDataLenBefore,
      payloadBytes,
      playerBalanceBeforeSettle,
      proverBalanceBeforeSettle,
      receiptFunderBefore,
      playerRodeoBefore,
      principalVaultBefore,
      rodeoMintInfoBefore,
      playerAnsemBefore,
      rewardVaultBefore,
      playerRodeoAccount,
      playerAnsemAccount,
      receiptFunder,
      claimable,
      bullPower: pos.buckPower,
      actionNonce: actionNonceOut,
    } as any;
  }


  /**
   * Build and stage a Bull removal proof for an already-requested Unstake.
   * Returns the staged buffer plus the position and pending randomness PDAs.
   */
  async function buildAndStageUnstakeProof(
    positionId: BN,
    actionNonce: BN,
    player: web3.Keypair,
    prover: web3.Keypair,
    nonce: BN,
  ): Promise<{
    staged: StagedBullProof;
    position: web3.PublicKey;
    pendingRandomness: web3.PublicKey;
    bullPower: BN;
    bufferLamportsBefore: number;
  }> {
    const { position } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const [pendingRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      position,
      1,
      actionNonce,
    );

    // Synchronize tracker and assert parity before proof generation.
    await syncTrackerWithChain();

    // Build and locally verify the current removal proof.
    const registry = bullRegistryTracker.buildRegistry();
    const payload = buildUnstakePayload(registry, player.publicKey, position);
    expect(payload.schemaVersion).toBe(2);
    expect(payload.sectionBitmap).toBe(0x28); // CURRENT_OWNER | REMOVE_BULL
    expect(payload.currentOwner).not.toBeNull();
    expect(payload.removeBull).not.toBeNull();
    expect(payload.currentOwner!.leaf.owner.equals(player.publicKey)).toBe(true);
    expect(payload.currentOwner!.leaf.activeBullCount).toBeGreaterThan(0n);
    expect(payload.removeBull!.leaf.position.equals(position)).toBe(true);
    expect(payload.removeBull!.leaf.owner.equals(player.publicKey)).toBe(true);
    expect(payload.removeBull!.leaf.buckPower).toBe(pos.buckPower);
    expect(payload.removeBull!.leaf.revealConfigVersion).toBe(BigInt(pos.revealConfigVersion.toString()));

    // Verify the owner proof hashes to the current BullRegistry root.
    verifyOwnerProof(player.publicKey, payload.currentOwner!, registry.rootNode);
    // Verify the remove-bull proof hashes to the bull tree root committed by the owner leaf.
    verifyBullProof(position, payload.removeBull!, {
      hash: payload.currentOwner!.leaf.bullTreeRoot,
      count: payload.currentOwner!.leaf.activeBullCount,
      power: payload.currentOwner!.leaf.totalBuckPower,
    });

    // Stage the BullProofBuffer with the removal payload.
    const payloadBytes = serializeBullProofPayload(payload);
    const staged = await stageBullProofBuffer(
      rodeoCoreProgram,
      globalConfig,
      position,
      pendingRandomness,
      prover,
      nonce,
      { unstake: {} },
      payloadBytes,
    );

    const bufferInfo = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfo).not.toBeNull();
    const bufferLamportsBefore = bufferInfo!.lamports;

    return { staged, position, pendingRandomness, bullPower: pos.buckPower, bufferLamportsBefore };
  }

  async function deriveStakeAccounts(positionId: BN) {
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const [pendingRandomness] = deriveRandomness(rodeoCoreProgram.programId, position, 0, new BN(0));
    return { position, pendingRandomness };
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

    return { position, pendingRandomness, protocolConfig };
  }

  async function settleReveal(
    positionId: BN,
    settler = payer,
    bullProof?: { bufferPda: web3.PublicKey; refundRecipient: web3.PublicKey },
  ) {
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const pendingRandomnessAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(
      pendingRandomness,
    );
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
    const [bullRegistryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const accounts: Record<string, web3.PublicKey | null> = {
      settler: settler.publicKey,
      globalConfig,
      globalGameState,
      rewardState,
      bullAccumulator,
      bullRegistry: bullRegistryPda,
      position,
      pendingRandomness,
      protocolConfig,
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
      // Anchor 0.31.1 resolves an explicitly-null optional account to the
      // program id, which the instruction builder treats as omitted.  This lets
      // proofless reveals omit the buffer/refund pair, while Bull reveals supply
      // both accounts.
      bullProofBuffer: bullProof ? bullProof.bufferPda : null,
      refundRecipient: bullProof ? bullProof.refundRecipient : null,
    };
    const preInstructions = bullProof
      ? [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]
      : [];
    await rodeoCoreProgram.methods
      .settleReveal()
      .accounts(accounts as any)
      .preInstructions(preInstructions)
      .signers([settler])
      .rpc();
  }

  async function recoverRevealTimeout(positionId: BN, caller = payer, owner = payer) {
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const ownerRodeo = payerRodeoAccount;
    await rodeoCoreProgram.methods
      .recoverRevealTimeout()
      .accounts({
        caller: caller.publicKey,
        position,
        pendingRandomness,
        globalConfig,
        principalVault,
        ownerRodeoAccount: ownerRodeo,
        owner: owner.publicKey,
        globalGameState,
        receiptFunder,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([caller])
      .rpc();
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

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
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

  // Collects every event of `eventName` emitted for `durationMs` regardless of
  // count. Useful for asserting that an event was *not* emitted during an
  // operation that is expected to skip the conditional emit path.
  function collectEventsDuring<T>(eventName: string, durationMs: number): Promise<T[]> {
    return new Promise((resolve) => {
      const events: T[] = [];
      const listener = rodeoCoreProgram.addEventListener(eventName, (event: T) => {
        events.push(event);
      });
      setTimeout(() => {
        void rodeoCoreProgram.removeEventListener(listener).then(() => resolve(events));
      }, durationMs);
    });
  }

  // The `test_fixture_*` instructions are compiled only for local tests via
  // the `test-fixtures` feature, so they are not exported in the production
  // IDL. They are invoked here as raw instructions using their Anchor
  // discriminators (sha256("global:<name>")[0..8]). Using fixtures instead of
  // real epoch emissions keeps this profile's claim tests deterministic while
  // the production `require_elapsed_epochs_closed` guard stays compiled in
  // and active (the production epoch duration never elapses during a test).
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

  async function fixtureSetPositionRemainders(
    positionId: BN,
    args: {
      cowboyAccrualRemainderScaled: BN;
      bullAccrualRemainderScaled: BN;
      lastCowboyRewardIndex: BN;
      lastBullRewardPerWeight: BN;
    },
  ) {
    const discriminator = Buffer.from("8e56c00bcb6afbbc", "hex");
    const data = Buffer.concat([
      discriminator,
      positionId.toArrayLike(Buffer, "le", 8),
      args.cowboyAccrualRemainderScaled.toArrayLike(Buffer, "le", 16),
      args.bullAccrualRemainderScaled.toArrayLike(Buffer, "le", 16),
      args.lastCowboyRewardIndex.toArrayLike(Buffer, "le", 16),
      args.lastBullRewardPerWeight.toArrayLike(Buffer, "le", 16),
    ]);
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const ix = new web3.TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: false },
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

  async function fixtureAdvanceNextPositionId(nextPositionId: BN) {
    const discriminator = Buffer.from("3105ae71743b6219", "hex");
    const data = Buffer.concat([
      discriminator,
      nextPositionId.toArrayLike(Buffer, "le", 8),
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

  async function stakeAndSettleById(positionId: BN) {
    const { position } = await deriveStakeAccounts(positionId);
    const existing = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position);
    if (existing !== null) return;
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    if (!positionId.eq(game.nextPositionId)) {
      await fixtureAdvanceNextPositionId(positionId);
    }
    await stakeAndCommit(positionId);
    if (expectedRevealRole(position) === "bull") {
      // Production Bull reveals require a staged BullProofBuffer. Stage it and
      // let revealBullWithProof update the off-chain tracker.
      await revealBullWithProof(positionId, payer, payer);
    } else {
      await settleReveal(positionId);
    }
  }

  /**
   * Stakes and reveals a fresh position, then uses the test-only fixtures to
   * make it deterministically claim-ready, bypassing organic Cowboy-index /
   * Bull-accumulator accrual (which would require real epoch emissions).
   * `claimable` is credited to the position and mirrored into
   * `position_claimable_liability_atomic`, matching what a real
   * `sync_cowboy_rewards`/`sync_bull_rewards` call would have produced.
   */
  async function prepareClaimReadyPosition(
    role: "cowboy" | "bull",
    claimable: BN,
    cowboyKindCode = 5,
  ): Promise<{ positionId: BN; position: web3.PublicKey }> {
    // Search for a position that will naturally reveal into the desired role
    // (and cowboy kind, when relevant). This keeps the GlobalGameState bull /
    // cowboy counters in sync with the position state instead of forcing a
    // role via the fixture and leaving game_state counters stale.
    const { positionId, position } =
      role === "bull"
        ? await findBullPosition()
        : await findCowboyPosition(cowboyKindCode);

    await stakeAndSettleById(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const actualCowboyKindCode = pos.cowboyKind.desperado
      ? 254
      : pos.cowboyKind.rank
        ? pos.cowboyKind.rank[0]
        : 0;
    await fixturePreparePosition(positionId, {
      roleCode: pos.role.cowboy ? 1 : pos.role.bull ? 2 : 0,
      cowboyKindCode: actualCowboyKindCode,
      accrualWeight: pos.accrualWeight,
      buckPower: pos.buckPower,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });
    return { positionId, position };
  }

  async function unstakeAllBulls() {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    if (game.activeBullCount.isZero()) return;

    for (let id = 0; id < nextPositionId; id++) {
      const positionId = new BN(id);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      const pos = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position);
      if (!pos) continue;
      if (!pos.status.active || !pos.role.bull) continue;

      await fixturePreparePosition(positionId, {
        roleCode: 2,
        cowboyKindCode: 0,
        accrualWeight: pos.accrualWeight,
        buckPower: pos.buckPower,
        claimable: pos.claimableAnsemAtomic,
        positionClaimableLiabilityDelta: new BN(0),
      });

      const { actionNonce } = await requestUnstake(positionId);
      await settleUnstake(positionId, actionNonce);
    }
  }

  async function ensureRecognizedReserve(amount: BN) {
    await fundRewardVault(amount);
    await fixtureRecognizeRewards(amount);
  }

  async function prepareUnstakeReadyPosition(
    claimable: BN,
  ): Promise<{ positionId: BN; position: web3.PublicKey; role: "cowboy" | "bull" | "desperado" }> {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const positionId = game.nextPositionId;
    nextPositionId = positionId.toNumber() + 1;
    await stakeAndSettleById(positionId);
    const { position } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);

    const role: "cowboy" | "bull" | "desperado" = pos.role.bull
      ? "bull"
      : pos.cowboyKind.desperado
        ? "desperado"
        : "cowboy";
    const cowboyKindCode = pos.cowboyKind.desperado
      ? 254
      : pos.cowboyKind.rank
        ? pos.cowboyKind.rank[0]
        : 0;

    await fixturePreparePosition(positionId, {
      roleCode: pos.role.cowboy ? 1 : pos.role.bull ? 2 : 0,
      cowboyKindCode,
      accrualWeight: pos.accrualWeight,
      buckPower: pos.buckPower,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });

    return { positionId, position, role };
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

  function expectedRevealRole(position: web3.PublicKey, config = PROTOCOL_CONFIG_V1): "cowboy" | "bull" {
    const randomOutput = deriveMockCommitment(position, 0, new BN(0), new BN(0));
    return mapRole(
      {
        randomOutput,
        domain: RandomnessDomain.Role,
        position: position.toBuffer(),
        actionNonce: 0n,
      },
      config,
    ) as "cowboy" | "bull";
  }

  function expectedCowboyKind(position: web3.PublicKey, config = PROTOCOL_CONFIG_V1): string {
    const randomOutput = deriveMockCommitment(position, 0, new BN(0), new BN(0));
    return mapCowboyKind(
      {
        randomOutput,
        domain: RandomnessDomain.CowboyKind,
        position: position.toBuffer(),
        actionNonce: 0n,
      },
      config,
    );
  }

  function expectedUnstakeTheftFlag(
    position: web3.PublicKey,
    actionNonce: BN,
    protocolEpoch: BN,
    config = PROTOCOL_CONFIG_V1,
  ): boolean {
    const randomOutput = deriveMockCommitment(position, 1, actionNonce, protocolEpoch);
    return mapUnstakeTheftFlag(
      {
        randomOutput,
        domain: RandomnessDomain.UnstakeTheft,
        position: position.toBuffer(),
        actionNonce: BigInt(actionNonce.toString()),
      },
      config,
    );
  }

  async function prepareUnstakeReadyPositionById(
    positionId: BN,
    claimable: BN,
  ): Promise<{ positionId: BN; position: web3.PublicKey; role: "cowboy" | "bull" | "desperado" }> {
    await stakeAndSettleById(positionId);
    const { position } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);

    const role: "cowboy" | "bull" | "desperado" = pos.role.bull
      ? "bull"
      : pos.cowboyKind.desperado
        ? "desperado"
        : "cowboy";
    const cowboyKindCode = pos.cowboyKind.desperado
      ? 254
      : pos.cowboyKind.rank
        ? pos.cowboyKind.rank[0]
        : 0;

    await fixturePreparePosition(positionId, {
      roleCode: pos.role.cowboy ? 1 : pos.role.bull ? 2 : 0,
      cowboyKindCode,
      accrualWeight: pos.accrualWeight,
      buckPower: pos.buckPower,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });

    return { positionId, position, role };
  }

  async function findPositionForUnstake(
    predicate: (positionId: BN, position: web3.PublicKey, role: string, cowboyKind: string, stolen: boolean) => boolean,
    maxAttempts = 1000,
  ): Promise<{ positionId: BN; position: web3.PublicKey; role: string; cowboyKind: string; stolen: boolean }> {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    let candidate = game.nextPositionId.toNumber();
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(candidate);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      const role = expectedRevealRole(position);
      if (role !== "cowboy") {
        candidate++;
        continue;
      }
      const cowboyKind = expectedCowboyKind(position);
      const stolen = expectedUnstakeTheftFlag(position, new BN(1), new BN(0));
      if (predicate(positionId, position, role, cowboyKind, stolen)) {
        nextPositionId = candidate + 1;
        return { positionId, position, role, cowboyKind, stolen };
      }
      candidate++;
    }
    throw new Error("Could not find a matching unstake position");
  }

  async function findBullPosition(maxAttempts = 100): Promise<{ positionId: BN; position: web3.PublicKey }> {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    let candidate = game.nextPositionId.toNumber();
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(candidate);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      if (expectedRevealRole(position) === "bull") {
        nextPositionId = candidate + 1;
        return { positionId, position };
      }
      candidate++;
    }
    throw new Error("Could not find a Bull position");
  }

  async function findCowboyPosition(
    cowboyKindCode = 5,
    maxAttempts = 10000,
  ): Promise<{ positionId: BN; position: web3.PublicKey }> {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    let candidate = game.nextPositionId.toNumber();
    const desiredKind =
      cowboyKindCode === 254 ? "desperado" : `rank${cowboyKindCode}`;
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(candidate);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      if (expectedRevealRole(position) !== "cowboy") {
        candidate++;
        continue;
      }
      if (expectedCowboyKind(position) === desiredKind) {
        nextPositionId = candidate + 1;
        return { positionId, position };
      }
      candidate++;
    }
    throw new Error("Could not find a Cowboy position");
  }

  async function requestUnstake(positionId: BN, owner = payer) {
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

  async function settleUnstake(
    positionId: BN,
    actionNonce: BN,
    settler = payer,
    bullProof?: { bufferPda: web3.PublicKey; refundRecipient: web3.PublicKey; receiptFunder?: web3.PublicKey },
    ownerAccounts?: { ownerRodeoAccount: web3.PublicKey; ownerAnsemAccount: web3.PublicKey },
  ) {
    const { position } = await deriveStakeAccounts(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const [pendingRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      position,
      1,
      actionNonce,
    );

    // Auto-stage a Bull unstake proof when the caller did not supply one and
    // the position is a Bull. This keeps generic helpers like
    // prepareUnstakeReadyPosition working with the production proof-buffer path.
    if (!bullProof && pos.role.bull) {
      await syncTrackerWithChain();
      const payload = buildUnstakePayload(bullRegistryTracker.buildRegistry(), pos.owner, position);
      const payloadBytes = serializeBullProofPayload(payload);
      const staged = await stageBullProofBuffer(
        rodeoCoreProgram,
        globalConfig,
        position,
        pendingRandomness,
        payer,
        new BN(2),
        { unstake: {} },
        payloadBytes,
      );
      bullProof = {
        bufferPda: staged.bufferPda,
        refundRecipient: staged.refundRecipient,
      };
    }

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
    const ownerRodeo = ownerAccounts?.ownerRodeoAccount ?? payerRodeoAccount;
    const ownerAnsem = ownerAccounts?.ownerAnsemAccount ?? payerAnsemAccount;
    const [bullRegistryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const accounts: Record<string, web3.PublicKey | null> = {
      settler: settler.publicKey,
      globalConfig,
      globalGameState,
      rewardState,
      bullAccumulator,
      bullRegistry: bullRegistryPda,
      position,
      pendingRandomness,
      protocolConfig,
      principalVault,
      rodeoMint,
      ownerRodeoAccount: ownerRodeo,
      rewardVault,
      ownerAnsemAccount: ownerAnsem,
      owner: pos.owner,
      receiptAsset,
      receiptCollection,
      receiptAuthority,
      receiptFunder: bullProof?.receiptFunder ?? receiptFunder,
      providerRandomnessAccount: settler.publicKey,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
      clock: web3.SYSVAR_CLOCK_PUBKEY,
      // Anchor 0.31.1 resolves an explicitly-null optional account to the
      // program id, which the instruction builder treats as omitted.  This lets
      // proofless reveals omit the buffer/refund pair, while Bull reveals supply
      // both accounts.
      bullProofBuffer: bullProof ? bullProof.bufferPda : null,
      refundRecipient: bullProof ? bullProof.refundRecipient : null,
    };
    const preInstructions = bullProof
      ? [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]
      : [];
    await rodeoCoreProgram.methods
      .settleUnstake()
      .accounts(accounts as any)
      .preInstructions(preInstructions)
      .signers([settler])
      .rpc();

    if (pos.role.bull) {
      bullRegistryTracker.unregisterBull(pos.owner, position);
      await assertTrackerMatchesChain();
    }
  }

  async function recoverUnstakeTimeout(positionId: BN, actionNonce: BN, caller = payer) {
    const { position } = await deriveStakeAccounts(positionId);
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
        owner: payer.publicKey,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([caller])
      .rpc();
  }

  async function fixtureCreateProtocolConfigV2(configVersion: BN) {
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      configVersion,
    );
    const info = await provider.connection.getAccountInfo(protocolConfig);
    if (info !== null) return protocolConfig;

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

  it("settle_reveal resolves the position, creates a PositionReceipt, and clears the pending action", async () => {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const positionId = game.nextPositionId;
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );

    await stakeAndCommit(positionId);
    await settleReveal(positionId);

    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.pendingActionActive).toBe(false);
    expect(pos.receiptAsset.toBase58()).toBe(receiptAsset.toBase58());
    expect(pos.role.cowboy || pos.role.bull).toBeTruthy();
    expect(pos.suit.unassigned).toBeUndefined();

    const pending = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(pendingRandomness);
    expect(pending).toBeNull();

    const receiptInfo = await provider.connection.getAccountInfo(receiptAsset);
    expect(receiptInfo).not.toBeNull();
  }, 60_000);

  it("settle_reveal is rejected when the reveal has already settled", async () => {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const positionId = game.nextPositionId;
    await stakeAndCommit(positionId);
    await settleReveal(positionId);

    await expect(settleReveal(positionId)).rejects.toThrow();
  }, 30_000);

  it("recover_reveal_timeout is rejected before the timeout window", async () => {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const positionId = game.nextPositionId;
    await stakeAndCommit(positionId);

    await expect(recoverRevealTimeout(positionId)).rejects.toThrow();

    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(
      (await deriveStakeAccounts(positionId)).position,
    );
    expect(pos.pendingActionActive).toBe(true);
  }, 30_000);

  it("recover_reveal_timeout after timeout refunds principal and clears the pending action", async () => {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const positionId = game.nextPositionId;
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    await stakeAndCommit(positionId);
    const before = await getAccount(provider.connection, payerRodeoAccount);
    await sleep(2_500);
    await recoverRevealTimeout(positionId);

    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position);
    expect(pos).toBeNull();

    const pending = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(pendingRandomness);
    expect(pending).toBeNull();

    const after = await getAccount(provider.connection, payerRodeoAccount);
    const refunded = new BN(after.amount.toString()).sub(new BN(before.amount.toString()));
    expect(refunded.toString()).toBe(stakeAmountAtomic.toString());
  }, 60_000);

  it("recognizes reward-vault funding immediately after funding (no epoch elapses)", async () => {
    const fundAmount = new BN(5_000_000_000);
    await fundRewardVault(fundAmount);

    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    await rodeoCoreProgram.methods
      .recognizeRewards(fundAmount)
      .accounts({
        caller: payer.publicKey,
        globalConfig,
        rewardState,
        rewardVault,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.add(fundAmount).toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.toString(),
    );
  }, 30_000);

  it("emits RewardFundingRecognized with recognized balance and actual vault balance", async () => {
    const fundAmount = new BN(5_000_000_000);
    await fundRewardVault(fundAmount);

    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const recognizedPromise = collectOneEvent<{
      amountAtomic: BN;
      recognizedRewardBalanceAtomic: BN;
      actualRewardVaultBalance: BN;
    }>("rewardFundingRecognized");

    await rodeoCoreProgram.methods
      .recognizeRewards(fundAmount)
      .accounts({
        caller: payer.publicKey,
        globalConfig,
        rewardState,
        rewardVault,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    const recognized = await recognizedPromise;
    expect(recognized.amountAtomic.toString()).toBe(fundAmount.toString());
    expect(recognized.actualRewardVaultBalance.toString()).toBe(vaultBefore.amount.toString());
    expect(recognized.recognizedRewardBalanceAtomic.gte(recognized.amountAtomic)).toBe(true);
  }, 30_000);

  it("pays a Cowboy (non-Desperado) claim with the exact 80/20 split", async () => {
    const claimable = new BN(1_000_000_000);
    await ensureRecognizedReserve(claimable);
    const { positionId, position } = await prepareClaimReadyPosition("cowboy", claimable, 5);

    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const ownerBefore = await getAccount(provider.connection, payerAnsemAccount);

    const expectedOwner = claimable.muln(8_000).divn(10_000);
    const expectedBull = claimable.sub(expectedOwner);

    await claimPositionRaw(positionId);

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.claimableAnsemAtomic.toString()).toBe("0");

    const ownerAfter = await getAccount(provider.connection, payerAnsemAccount);
    const payout = new BN(ownerAfter.amount.toString()).sub(new BN(ownerBefore.amount.toString()));
    expect(payout.toString()).toBe(expectedOwner.toString());

    const vaultAfter = await getAccount(provider.connection, rewardVault);
    expect(
      new BN(vaultBefore.amount.toString()).sub(new BN(vaultAfter.amount.toString())).toString(),
    ).toBe(expectedOwner.toString());

    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    expect(
      rewardBefore.positionClaimableLiabilityAtomic
        .sub(rewardAfter.positionClaimableLiabilityAtomic)
        .toString(),
    ).toBe(claimable.toString());
    expect(
      rewardBefore.totalAnsemLiabilityAtomic.sub(rewardAfter.totalAnsemLiabilityAtomic).toString(),
    ).toBe(expectedOwner.toString());
    expect(
      rewardBefore.recognizedRewardBalanceAtomic
        .sub(rewardAfter.recognizedRewardBalanceAtomic)
        .toString(),
    ).toBe(expectedOwner.toString());
    expect(
      rewardAfter.ansemClaimedAtomic.sub(rewardBefore.ansemClaimedAtomic).toString(),
    ).toBe(expectedOwner.toString());
    expect(
      rewardAfter.bullPoolLiabilityAtomic
        .add(rewardAfter.bullPoolUnallocatedLiabilityAtomic)
        .sub(
          rewardBefore.bullPoolLiabilityAtomic.add(rewardBefore.bullPoolUnallocatedLiabilityAtomic),
        )
        .toString(),
    ).toBe(expectedBull.toString());
  }, 30_000);

  it("pays a Desperado claim with the exact 98/2 split", async () => {
    const claimable = new BN(1_000_000_000);
    await ensureRecognizedReserve(claimable);
    // cowboy_kind_code 254 maps to CowboyKind::Desperado in the fixture.
    const { positionId, position } = await prepareClaimReadyPosition("cowboy", claimable, 254);

    const ownerBefore = await getAccount(provider.connection, payerAnsemAccount);
    const expectedOwner = claimable.muln(9_800).divn(10_000);
    const expectedBull = claimable.sub(expectedOwner);

    await claimPositionRaw(positionId);

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.claimableAnsemAtomic.toString()).toBe("0");

    const ownerAfter = await getAccount(provider.connection, payerAnsemAccount);
    const payout = new BN(ownerAfter.amount.toString()).sub(new BN(ownerBefore.amount.toString()));
    expect(payout.toString()).toBe(expectedOwner.toString());
    expect(expectedBull.gtn(0)).toBe(true);
  }, 30_000);

  it("pays a Bull claim 100% of its accrued claimable balance", async () => {
    const claimable = new BN(750_000_000);
    await ensureRecognizedReserve(claimable);
    const { positionId, position } = await prepareClaimReadyPosition("bull", claimable);

    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const ownerBefore = await getAccount(provider.connection, payerAnsemAccount);

    await claimPositionRaw(positionId);

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.claimableAnsemAtomic.toString()).toBe("0");

    const ownerAfter = await getAccount(provider.connection, payerAnsemAccount);
    const payout = new BN(ownerAfter.amount.toString()).sub(new BN(ownerBefore.amount.toString()));
    expect(payout.toString()).toBe(claimable.toString());

    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    // A Bull claim pays 100% to the owner: the Bull-pool buckets must be
    // unchanged, and must not be decremented a second time.
    expect(rewardAfter.bullPoolLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolLiabilityAtomic.toString(),
    );
    expect(rewardAfter.bullPoolUnallocatedLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolUnallocatedLiabilityAtomic.toString(),
    );
    expect(
      rewardAfter.ansemClaimedAtomic.sub(rewardBefore.ansemClaimedAtomic).toString(),
    ).toBe(claimable.toString());
  }, 30_000);

  it("updates WalletClaimCooldown and rejects a second claim within the cooldown window", async () => {
    const claimable = new BN(200_000_000);
    await ensureRecognizedReserve(claimable.muln(2));
    const { positionId: positionA } = await prepareClaimReadyPosition("cowboy", claimable);
    const { positionId: positionB } = await prepareClaimReadyPosition("cowboy", claimable);

    const [walletCooldown] = deriveWalletCooldown(
      rodeoCoreProgram.programId,
      globalConfig,
      payer.publicKey,
    );

    await claimPositionRaw(positionA);
    const cooldownAfterFirst = (await provider.connection.getAccountInfo(walletCooldown)) !== null;
    expect(cooldownAfterFirst).toBe(true);

    await expect(claimPositionRaw(positionB)).rejects.toThrow();

    // `test-short-claim-cooldown` shortens the wallet cooldown for local
    // tests; wait it out and confirm the second claim then succeeds.
    await sleep(2_500);
    await claimPositionRaw(positionB);
  }, 30_000);

  it("rejects claim by a non-owner", async () => {
    const claimable = new BN(100_000_000);
    await ensureRecognizedReserve(claimable);
    const { positionId } = await prepareClaimReadyPosition("cowboy", claimable);

    const impostor = web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    await expect(claimPositionRaw(positionId, impostor, payerAnsemAccount)).rejects.toThrow();
  }, 30_000);

  it("rejects claim while a randomness action is pending", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await expect(claimPositionRaw(positionId)).rejects.toThrow();
  }, 30_000);

  it("emits PositionClaimed and RewardPaid with correct portions for a Cowboy claim", async () => {
    const claimable = new BN(1_000_000_000);
    await ensureRecognizedReserve(claimable);
    const { positionId } = await prepareClaimReadyPosition("cowboy", claimable, 5);

    const expectedOwner = claimable.muln(8_000).divn(10_000);
    const expectedBull = claimable.sub(expectedOwner);

    const positionClaimedPromise = collectOneEvent<{
      position: string;
      owner: string;
      ownerAmount: BN;
      bullPoolAmount: BN;
    }>("positionClaimed");
    const rewardPaidPromise = collectOneEvent<{
      position: string;
      owner: string;
      amountAtomic: BN;
      recognizedRewardBalanceAtomic: BN;
      reason: unknown;
    }>("rewardPaid");

    await claimPositionRaw(positionId);

    const positionClaimed = await positionClaimedPromise;
    const rewardPaid = await rewardPaidPromise;

    expect(toBase58(positionClaimed.owner)).toBe(payer.publicKey.toBase58());
    expect(positionClaimed.ownerAmount.toString()).toBe(expectedOwner.toString());
    expect(positionClaimed.bullPoolAmount.toString()).toBe(expectedBull.toString());

    expect(toBase58(rewardPaid.position)).toBe(toBase58(positionClaimed.position));
    expect(toBase58(rewardPaid.owner)).toBe(payer.publicKey.toBase58());
    expect(rewardPaid.amountAtomic.toString()).toBe(expectedOwner.toString());
    eventReason(rewardPaid, "cowboyClaim");
  }, 30_000);

  it("emits PositionClaimed and RewardPaid for a Bull claim with zero Bull-pool amount", async () => {
    const claimable = new BN(500_000_000);
    await ensureRecognizedReserve(claimable);
    const { positionId } = await prepareClaimReadyPosition("bull", claimable);

    const positionClaimedPromise = collectOneEvent<{
      position: string;
      owner: string;
      ownerAmount: BN;
      bullPoolAmount: BN;
    }>("positionClaimed");
    const rewardPaidPromise = collectOneEvent<{
      position: string;
      owner: string;
      amountAtomic: BN;
      reason: unknown;
    }>("rewardPaid");

    await claimPositionRaw(positionId);

    const positionClaimed = await positionClaimedPromise;
    const rewardPaid = await rewardPaidPromise;

    expect(positionClaimed.bullPoolAmount.toString()).toBe("0");
    expect(positionClaimed.ownerAmount.toString()).toBe(rewardPaid.amountAtomic.toString());
    eventReason(rewardPaid, "bullClaim");
  }, 30_000);

  it("emits BullPoolContribution with the current epoch and source on a Cowboy claim tax", async () => {
    const claimable = new BN(1_000_000_000);
    await ensureRecognizedReserve(claimable);
    const { positionId } = await prepareClaimReadyPosition("cowboy", claimable, 5);

    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const bullPoolPromise = collectOneEvent<{
      epoch: BN;
      amountAtomic: BN;
      source: unknown;
    }>("bullPoolContribution");

    await claimPositionRaw(positionId);

    const bullPool = await bullPoolPromise;
    expect(bullPool.epoch.toString()).toBe(rewardBefore.currentEpoch.toString());
    expect(bullPool.amountAtomic.gtn(0)).toBe(true);
    const source = bullPool.source;
    if (typeof source === "string") {
      expect(source).toBe("cowboyClaimTax");
    } else if (source && typeof source === "object") {
      expect(Object.keys(source)).toContain("cowboyClaimTax");
    } else {
      throw new Error("Unexpected BullPoolContribution source shape");
    }
  }, 30_000);

  it("WalletClaimCooldown PDA seed matches [b\"claim_cooldown\", global_config, wallet]", async () => {
    const [expected] = deriveWalletCooldown(rodeoCoreProgram.programId, globalConfig, payer.publicKey);
    const [actual] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("claim_cooldown"), globalConfig.toBuffer(), payer.publicKey.toBuffer()],
      rodeoCoreProgram.programId,
    );
    expect(expected.toBase58()).toBe(actual.toBase58());
  }, 15_000);

  function toBase58(value: string | { toBase58(): string }): string {
    return typeof value === "string" ? value : value.toBase58();
  }

  function eventReason(event: { reason: unknown }, expected: string) {
    const reason = event.reason;
    if (typeof reason === "string") {
      expect(reason).toBe(expected);
    } else if (reason && typeof reason === "object") {
      expect(Object.keys(reason)).toContain(expected);
    } else {
      throw new Error("Unexpected event reason shape");
    }
  }

  it("recognize_rewards preserves every liability bucket in the production-length profile", async () => {
    // The claim profile is built with production-length epochs, so no epoch
    // can elapse. Recognition therefore must not touch any liability bucket.
    const fundAmount = new BN(5_000_000_000);
    await fundRewardVault(fundAmount);

    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    await rodeoCoreProgram.methods
      .recognizeRewards(fundAmount)
      .accounts({
        caller: payer.publicKey,
        globalConfig,
        rewardState,
        rewardVault,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultAfter = await getAccount(provider.connection, rewardVault);

    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.add(fundAmount).toString(),
    );
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());

    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.toString(),
    );
    expect(rewardAfter.cowboyUnmaterializedLiabilityAtomic.toString()).toBe(
      rewardBefore.cowboyUnmaterializedLiabilityAtomic.toString(),
    );
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.toString(),
    );
    expect(rewardAfter.bullPoolLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolLiabilityAtomic.toString(),
    );
    expect(rewardAfter.bullPoolUnallocatedLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolUnallocatedLiabilityAtomic.toString(),
    );
    expect(rewardAfter.suitVaultLiabilityAtomic.toString()).toBe(
      rewardBefore.suitVaultLiabilityAtomic.toString(),
    );
  }, 30_000);

  it("rejects request_unstake before unstake_eligible_at", async () => {
    const freshPositionId = new BN(nextPositionId++);
    await stakeAndCommit(freshPositionId);
    await settleReveal(freshPositionId);
    await expect(requestUnstake(freshPositionId)).rejects.toThrow();

    // Clean up with an eligible position so the suite count stays consistent.
    const { positionId } = await prepareUnstakeReadyPosition(new BN(0));
    const { actionNonce } = await requestUnstake(positionId);
    await settleUnstake(positionId, actionNonce);
  }, 60_000);

  it("request_unstake opens a pending randomness with actionType unstake", async () => {
    const { positionId, position } = await prepareUnstakeReadyPosition(new BN(0));
    const { pendingRandomness, actionNonce } = await requestUnstake(positionId);
    expect(actionNonce.toString()).toBe("1");

    const pendingAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(
      pendingRandomness,
    );
    expect(pendingAccount.actionType).toHaveProperty("unstake");
    expect(pendingAccount.actionNonce.toString()).toBe(actionNonce.toString());
    expect(pendingAccount.configVersionSnapshot.toString()).toBe("1");

    const positionAccount = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(positionAccount.pendingActionActive).toBe(true);
    expect(positionAccount.pendingActionType).toHaveProperty("unstake");
    expect(positionAccount.pendingActionNonce.toString()).toBe(actionNonce.toString());
  }, 60_000);

  it("settle_unstake returns RODEO principal and removes a Bull position", async () => {
    let attempts = 0;
    let positionId: BN | undefined;
    let settleInfo: { position: web3.PublicKey; pendingRandomness: web3.PublicKey; actionNonce: BN } | undefined;

    while (attempts < 20) {
      attempts++;
      const prep = await prepareUnstakeReadyPosition(new BN(0));
      if (prep.role === "bull") {
        positionId = prep.positionId;
        settleInfo = await requestUnstake(positionId);
        break;
      }
      // Close non-bull positions to keep state consistent.
      const { pendingRandomness, actionNonce } = await requestUnstake(prep.positionId);
      await settleUnstake(prep.positionId, actionNonce);
    }

    if (!positionId || !settleInfo) {
      throw new Error("Failed to reveal a Bull after 20 attempts");
    }

    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const rodeoBefore = await getAccount(provider.connection, payerRodeoAccount);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    await settleUnstake(positionId, settleInfo.actionNonce);

    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const rodeoAfter = await getAccount(provider.connection, payerRodeoAccount);
    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    const stakeAmount = new BN(100_000_000_000);
    const returned = stakeAmount.muln(9_500).divn(10_000);
    const burned = stakeAmount.sub(returned);

    expect(new BN(principalVaultAfter.amount.toString()).toString()).toBe(
      new BN(principalVaultBefore.amount.toString()).sub(stakeAmount).toString(),
    );
    expect(new BN(rodeoAfter.amount.toString()).toString()).toBe(
      new BN(rodeoBefore.amount.toString()).add(returned).toString(),
    );
    expect(gameAfter.livePositionCount.toString()).toBe(
      gameBefore.livePositionCount.subn(1).toString(),
    );
    expect(gameAfter.activeBullCount.toString()).toBe(
      gameBefore.activeBullCount.subn(1).toString(),
    );
    expect(gameAfter.accountedPrincipalAtomic.toString()).toBe(
      gameBefore.accountedPrincipalAtomic.sub(stakeAmount).toString(),
    );

    const unassignedPosition = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(
      settleInfo.position,
    );
    expect(unassignedPosition).toBeNull();
  }, 120_000);

  it("settle_unstake pays ANSEM to the owner for a safe Cowboy", async () => {
    let attempts = 0;
    let positionId: BN | undefined;
    let settleInfo: { position: web3.PublicKey; pendingRandomness: web3.PublicKey; actionNonce: BN } | undefined;

    const claimable = new BN(1_000_000_000);
    await ensureRecognizedReserve(claimable);

    while (attempts < 32) {
      attempts++;
      const prep = await prepareUnstakeReadyPosition(new BN(0));
      if (prep.role !== "cowboy") {
        const { pendingRandomness, actionNonce } = await requestUnstake(prep.positionId);
        await settleUnstake(prep.positionId, actionNonce);
        continue;
      }

      // Credit claimable on the Cowboy so the safe-payout path can be observed.
      const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(prep.position);
      const cowboyKindCode = pos.cowboyKind.desperado ? 254 : pos.cowboyKind.rank![0];
      await fixturePreparePosition(prep.positionId, {
        roleCode: 1,
        cowboyKindCode,
        accrualWeight: pos.accrualWeight,
        buckPower: pos.buckPower,
        claimable,
        positionClaimableLiabilityDelta: claimable,
      });

      const { position, pendingRandomness, actionNonce } = await requestUnstake(prep.positionId);
      const pendingAccount =
        await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(pendingRandomness);
      const randomOutput = deriveMockCommitment(
        position,
        1,
        actionNonce,
        pendingAccount.committedProtocolEpoch,
      );
      if (!mapUnstakeTheftFlag({
        randomOutput,
        domain: RandomnessDomain.UnstakeTheft,
        position: position.toBuffer(),
        actionNonce: BigInt(actionNonce.toString()),
      }, PROTOCOL_CONFIG_V1)) {
        positionId = prep.positionId;
        settleInfo = { position, pendingRandomness, actionNonce };
        break;
      }
      await settleUnstake(prep.positionId, actionNonce);
    }

    if (!positionId || !settleInfo) {
      throw new Error("Failed to reveal a safe non-Desperado Cowboy after 32 attempts");
    }

    const ansemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    await settleUnstake(positionId, settleInfo.actionNonce);

    const ansemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(new BN(ansemAfter.amount.toString()).toString()).toBe(
      new BN(ansemBefore.amount.toString()).add(claimable).toString(),
    );
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.sub(claimable).toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.sub(claimable).toString(),
    );
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.sub(claimable).toString(),
    );
  }, 120_000);

  it("settle_unstake materializes a Cowboy orphan remainder at the scale boundary", async () => {
    const { positionId } = await findCowboyPosition(5);
    await prepareUnstakeReadyPositionById(positionId, new BN(0));

    const rewardBeforeFixture = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const posAccount = await rodeoAccounts(rodeoCoreProgram).position.fetch(
      derivePosition(rodeoCoreProgram.programId, globalConfig, positionId)[0],
    );

    // Position holds a sub-atomic Cowboy remainder. The global orphan bucket is
    // one position-remainder away from reaching the scale, so settlement should
    // release exactly one whole atomic ANSEM.
    const positionRemainder = new BN(150);
    const globalOrphan = COWBOY_REWARD_INDEX_SCALE.sub(positionRemainder);
    await fixtureSetPositionRemainders(positionId, {
      cowboyAccrualRemainderScaled: positionRemainder,
      bullAccrualRemainderScaled: new BN(0),
      lastCowboyRewardIndex: posAccount.lastCowboyRewardIndex,
      lastBullRewardPerWeight: posAccount.lastBullRewardPerWeight,
    });

    await fixtureSetOrphanedRemainder({
      cowboyOrphanedAccrualRemainderScaled: globalOrphan,
      bullOrphanedAccrualRemainderScaled: new BN(0),
      cowboyUnmaterializedLiabilityAtomic: new BN(100),
      bullPoolLiabilityAtomic: new BN(0),
      totalAnsemLiabilityAtomic: new BN(100),
      recognizedRewardBalanceAtomic: new BN(0),
      lastClosedEpochTimestamp: rewardBeforeFixture.lastClosedEpochTimestamp,
      epochStartedAt: rewardBeforeFixture.epochStartedAt,
    });

    const orphanedRewardPromise = collectOneEvent<{
      rewardSource: { cowboy?: {}; bull?: {} };
      amountAtomic: BN;
      remainingRemainderScaled: BN;
      totalAnsemLiabilityAtomicAfter: BN;
    }>("orphanedRewardReleased");

    const rewardBeforeUnstake = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultBefore = await getAccount(provider.connection, rewardVault);

    const { actionNonce } = await requestUnstake(positionId);
    await settleUnstake(positionId, actionNonce);

    const orphanedReward = await orphanedRewardPromise;
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const vaultAfter = await getAccount(provider.connection, rewardVault);

    expect(orphanedReward.rewardSource).toHaveProperty("cowboy");
    expect(orphanedReward.amountAtomic.toString()).toBe("1");
    expect(orphanedReward.remainingRemainderScaled.toString()).toBe("0");
    expect(orphanedReward.totalAnsemLiabilityAtomicAfter.toString()).toBe("99");

    expect(rewardAfter.cowboyOrphanedAccrualRemainderScaled.toString()).toBe("0");
    expect(rewardAfter.cowboyUnmaterializedLiabilityAtomic.toString()).toBe(
      rewardBeforeUnstake.cowboyUnmaterializedLiabilityAtomic.subn(1).toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBeforeUnstake.totalAnsemLiabilityAtomic.subn(1).toString(),
    );
    expect(rewardAfter.orphanedRewardReleasedAtomic.toString()).toBe(
      rewardBeforeUnstake.orphanedRewardReleasedAtomic.addn(1).toString(),
    );
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBeforeUnstake.recognizedRewardBalanceAtomic.toString(),
    );
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());

    const closedPosition = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(
      derivePosition(rodeoCoreProgram.programId, globalConfig, positionId)[0],
    );
    expect(closedPosition).toBeNull();
  }, 120_000);

  it("settle_unstake materializes a Bull orphan remainder at the scale boundary", async () => {
    const { positionId } = await findBullPosition();
    await prepareUnstakeReadyPositionById(positionId, new BN(0));

    const rewardBeforeFixture = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const posAccount = await rodeoAccounts(rodeoCoreProgram).position.fetch(
      derivePosition(rodeoCoreProgram.programId, globalConfig, positionId)[0],
    );

    const positionRemainder = new BN(200);
    const globalOrphan = REWARD_PER_WEIGHT_SCALE.sub(positionRemainder);
    await fixtureSetPositionRemainders(positionId, {
      cowboyAccrualRemainderScaled: new BN(0),
      bullAccrualRemainderScaled: positionRemainder,
      lastCowboyRewardIndex: posAccount.lastCowboyRewardIndex,
      lastBullRewardPerWeight: posAccount.lastBullRewardPerWeight,
    });

    await fixtureSetOrphanedRemainder({
      cowboyOrphanedAccrualRemainderScaled: new BN(0),
      bullOrphanedAccrualRemainderScaled: globalOrphan,
      cowboyUnmaterializedLiabilityAtomic: new BN(0),
      bullPoolLiabilityAtomic: new BN(100),
      totalAnsemLiabilityAtomic: new BN(100),
      recognizedRewardBalanceAtomic: new BN(0),
      lastClosedEpochTimestamp: rewardBeforeFixture.lastClosedEpochTimestamp,
      epochStartedAt: rewardBeforeFixture.epochStartedAt,
    });

    const orphanedRewardPromise = collectOneEvent<{
      rewardSource: { cowboy?: {}; bull?: {} };
      amountAtomic: BN;
      remainingRemainderScaled: BN;
      totalAnsemLiabilityAtomicAfter: BN;
    }>("orphanedRewardReleased");

    const rewardBeforeUnstake = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    const { actionNonce } = await requestUnstake(positionId);
    await settleUnstake(positionId, actionNonce);

    const orphanedReward = await orphanedRewardPromise;
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(orphanedReward.rewardSource).toHaveProperty("bull");
    expect(orphanedReward.amountAtomic.toString()).toBe("1");
    expect(orphanedReward.remainingRemainderScaled.toString()).toBe("0");
    expect(orphanedReward.totalAnsemLiabilityAtomicAfter.toString()).toBe("99");

    expect(rewardAfter.bullPoolLiabilityAtomic.toString()).toBe(
      rewardBeforeUnstake.bullPoolLiabilityAtomic.subn(1).toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBeforeUnstake.totalAnsemLiabilityAtomic.subn(1).toString(),
    );
    expect(rewardAfter.orphanedRewardReleasedAtomic.toString()).toBe(
      rewardBeforeUnstake.orphanedRewardReleasedAtomic.addn(1).toString(),
    );
  }, 120_000);

  it("emits BullRewardDistributed when a Bull accrues on unstake", async () => {
    const { positionId } = await findBullPosition();
    await prepareUnstakeReadyPositionById(positionId, new BN(0));

    const { position } = await deriveStakeAccounts(positionId);
    const posAccount = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const rewardBeforeFixture = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    // Per-position Bull remainder is > one full scale, so sync_bull_rewards
    // accrues one whole ANSEM when last == current.
    const positionRemainder = REWARD_PER_WEIGHT_SCALE.addn(200);
    await fixtureSetPositionRemainders(positionId, {
      cowboyAccrualRemainderScaled: new BN(0),
      bullAccrualRemainderScaled: positionRemainder,
      lastCowboyRewardIndex: posAccount.lastCowboyRewardIndex,
      lastBullRewardPerWeight: posAccount.lastBullRewardPerWeight,
    });

    await fixtureSetOrphanedRemainder({
      cowboyOrphanedAccrualRemainderScaled: new BN(0),
      bullOrphanedAccrualRemainderScaled: new BN(0),
      cowboyUnmaterializedLiabilityAtomic: new BN(0),
      bullPoolLiabilityAtomic: new BN(2),
      totalAnsemLiabilityAtomic: new BN(2),
      recognizedRewardBalanceAtomic: new BN(2),
      lastClosedEpochTimestamp: rewardBeforeFixture.lastClosedEpochTimestamp,
      epochStartedAt: rewardBeforeFixture.epochStartedAt,
    });

    await fundRewardVault(new BN(2));

    const bullRewardPromise = collectOneEvent<{
      position: string;
      owner: string;
      amountAtomic: BN;
      rewardPerWeightScaled: BN;
    }>("bullRewardDistributed");

    const { actionNonce } = await requestUnstake(positionId);
    await settleUnstake(positionId, actionNonce);

    const bullReward = await bullRewardPromise;
    expect(bullReward.amountAtomic.toString()).toBe("1");
    expect(bullReward.rewardPerWeightScaled.toString()).toBe(posAccount.lastBullRewardPerWeight.toString());
  }, 120_000);

  it("does not emit BullRewardDistributed when a Bull has zero accrual on unstake", async () => {
    const { positionId } = await findBullPosition();
    await prepareUnstakeReadyPositionById(positionId, new BN(0));

    const { position } = await deriveStakeAccounts(positionId);
    const posAccount = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const rewardBeforeFixture = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    // Sub-scale per-position remainder => accrued == 0.
    const positionRemainder = new BN(200);
    await fixtureSetPositionRemainders(positionId, {
      cowboyAccrualRemainderScaled: new BN(0),
      bullAccrualRemainderScaled: positionRemainder,
      lastCowboyRewardIndex: posAccount.lastCowboyRewardIndex,
      lastBullRewardPerWeight: posAccount.lastBullRewardPerWeight,
    });

    await fixtureSetOrphanedRemainder({
      cowboyOrphanedAccrualRemainderScaled: new BN(0),
      bullOrphanedAccrualRemainderScaled: new BN(0),
      cowboyUnmaterializedLiabilityAtomic: new BN(0),
      bullPoolLiabilityAtomic: new BN(0),
      totalAnsemLiabilityAtomic: new BN(0),
      recognizedRewardBalanceAtomic: new BN(0),
      lastClosedEpochTimestamp: rewardBeforeFixture.lastClosedEpochTimestamp,
      epochStartedAt: rewardBeforeFixture.epochStartedAt,
    });

    const noBullRewardPromise = collectEventsDuring<{
      position: string;
      owner: string;
      amountAtomic: BN;
      rewardPerWeightScaled: BN;
    }>("bullRewardDistributed", 2_000);

    const { actionNonce } = await requestUnstake(positionId);
    await settleUnstake(positionId, actionNonce);

    const bullEvents = await noBullRewardPromise;
    expect(bullEvents.length).toBe(0);
  }, 120_000);

  it("recover_unstake_timeout cancels the pending action after timeout", async () => {
    const { positionId } = await prepareUnstakeReadyPosition(new BN(0));
    const { pendingRandomness, actionNonce } = await requestUnstake(positionId);
    await sleep(2_500);
    await recoverUnstakeTimeout(positionId, actionNonce);

    const positionAccount = await rodeoAccounts(rodeoCoreProgram).position.fetch(
      (await deriveStakeAccounts(positionId)).position,
    );
    expect(positionAccount.pendingActionActive).toBe(false);
    expect(positionAccount.pendingActionType).toHaveProperty("reveal");
    expect(positionAccount.pendingActionNonce.toString()).toBe("0");

    const pendingAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(
      pendingRandomness,
    );
    expect(pendingAccount).toBeNull();
  }, 60_000);

  it("settle_unstake uses the historical ProtocolConfig version for the RODEO split", async () => {
    const { positionId, position } = await prepareUnstakeReadyPosition(new BN(0));

    const { pendingRandomness, actionNonce } = await requestUnstake(positionId);
    const pendingAccount =
      await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(pendingRandomness);
    expect(pendingAccount.configVersionSnapshot.toString()).toBe("1");

    // Activate ProtocolConfig V2 after the unstake request is already open.
    const protocolConfigV2 = await fixtureCreateProtocolConfigV2(new BN(2));
    await fixtureSetCurrentConfigVersion(protocolConfigV2);

    const globalConfigAccount = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    expect(globalConfigAccount.currentConfigVersion.toString()).toBe("2");

    const posBefore = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posBefore.claimableAnsemAtomic.toString()).toBe("0");

    const ansemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const rodeoBefore = await getAccount(provider.connection, payerRodeoAccount);

    await settleUnstake(positionId, actionNonce);

    const ansemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfter = await getAccount(provider.connection, rewardVault);
    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const rodeoAfter = await getAccount(provider.connection, payerRodeoAccount);

    const v1Returned = stakeAmountAtomic.muln(9_500).divn(10_000);

    expect(new BN(principalVaultAfter.amount.toString()).toString()).toBe(
      new BN(principalVaultBefore.amount.toString()).sub(stakeAmountAtomic).toString(),
    );
    expect(new BN(rodeoAfter.amount.toString()).sub(new BN(rodeoBefore.amount.toString())).toString()).toBe(
      v1Returned.toString(),
    );
    expect(ansemAfter.amount.toString()).toBe(ansemBefore.amount.toString());
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());

    // The pending randomness was opened under V1; the same random output must
    // map to safe (not stolen) for V1, so the historical V1 config owns the
    // unstake settlement even though V2 is now active. With claimable 0 this
    // is vacuous for ANSEM but still deterministic.
    const randomOutput = deriveMockCommitment(
      position,
      1,
      actionNonce,
      pendingAccount.committedProtocolEpoch,
    );
    const stolenUnderV1 = mapUnstakeTheftFlag(
      {
        randomOutput,
        domain: RandomnessDomain.UnstakeTheft,
        position: position.toBuffer(),
        actionNonce: BigInt(actionNonce.toString()),
      },
      PROTOCOL_CONFIG_V1,
    );
    expect(stolenUnderV1).toBe(false);
  }, 120_000);

  it("request_unstake enforces owner, no pending action, and preserves token/state", async () => {
    const claimable = new BN(1_000_000_000);
    await ensureRecognizedReserve(claimable);

    const { positionId, position } = await findPositionForUnstake(
      (_id, _pos, _role, cowboyKind, stolen) => cowboyKind !== "desperado" && !stolen,
    );
    await prepareUnstakeReadyPositionById(positionId, claimable);

    // Non-owner request fails.
    const nonOwner = web3.Keypair.generate();
    await expect(requestUnstake(positionId, nonOwner)).rejects.toThrow();

    const posBefore = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posBefore.nextActionNonce.toString()).toBe("1");

    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const rodeoBefore = await getAccount(provider.connection, payerRodeoAccount);
    const ansemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    const { pendingRandomness, actionNonce } = await requestUnstake(positionId);

    const pendingAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(pendingRandomness);
    expect(pendingAccount.configVersionSnapshot.toString()).toBe("1");
    expect(pendingAccount.actionType).toHaveProperty("unstake");
    expect(pendingAccount.actionNonce.toString()).toBe(actionNonce.toString());

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posAfter.status).toHaveProperty("active");
    expect(posAfter.pendingActionActive).toBe(true);
    expect(posAfter.pendingActionType).toHaveProperty("unstake");
    expect(posAfter.pendingActionNonce.toString()).toBe(actionNonce.toString());
    expect(posAfter.nextActionNonce.toString()).toBe("2");

    // Existing pending action blocks a second request.
    await expect(requestUnstake(positionId)).rejects.toThrow();

    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const rodeoAfter = await getAccount(provider.connection, payerRodeoAccount);
    const ansemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(principalVaultAfter.amount.toString()).toBe(principalVaultBefore.amount.toString());
    expect(rodeoAfter.amount.toString()).toBe(rodeoBefore.amount.toString());
    expect(ansemAfter.amount.toString()).toBe(ansemBefore.amount.toString());
    expect(gameAfter.livePositionCount.toString()).toBe(gameBefore.livePositionCount.toString());
    expect(gameAfter.totalActiveCowboyWeight.toString()).toBe(gameBefore.totalActiveCowboyWeight.toString());
    expect(gameAfter.activeCowboyCount.toString()).toBe(gameBefore.activeCowboyCount.toString());
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(rewardBefore.totalAnsemLiabilityAtomic.toString());
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.toString(),
    );

    // Clean up.
    await settleUnstake(positionId, actionNonce);
  }, 120_000);

  interface PositionUnstakedEvent {
    ansemFate: unknown;
    ansemPaidToOwner: BN;
    ansemRoutedToBullPool: BN;
  }

  interface BullPoolContributionEvent {
    source: unknown;
    amountAtomic: BN;
    epoch: BN;
  }

  function ansemFateKey(fate: unknown, expected: string) {
    if (fate && typeof fate === "object") {
      expect(Object.keys(fate)).toContain(expected);
    } else if (typeof fate === "string") {
      expect(fate).toBe(expected);
    } else {
      throw new Error("Unexpected ansemFate shape");
    }
  }

  function bullPoolSourceKey(source: unknown, expected: string) {
    if (source && typeof source === "object") {
      expect(Object.keys(source)).toContain(expected);
    } else if (typeof source === "string") {
      expect(source).toBe(expected);
    } else {
      throw new Error("Unexpected BullPoolContribution source shape");
    }
  }

  async function findV1SafeV2StolenCowboy(maxAttempts = 2000): Promise<{
    positionId: BN;
    position: web3.PublicKey;
    randomOutput: Uint8Array;
  }> {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    let candidate = game.nextPositionId.toNumber();
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(candidate);
      const [position] = derivePosition(
        rodeoCoreProgram.programId,
        globalConfig,
        positionId,
      );
      const role = expectedRevealRole(position, PROTOCOL_CONFIG_V1);
      if (role !== "cowboy") {
        candidate++;
        continue;
      }
      const cowboyKind = expectedCowboyKind(position, PROTOCOL_CONFIG_V1);
      if (cowboyKind === "desperado") {
        candidate++;
        continue;
      }
      const v1Stolen = expectedUnstakeTheftFlag(
        position,
        new BN(1),
        new BN(0),
        PROTOCOL_CONFIG_V1,
      );
      if (v1Stolen) {
        candidate++;
        continue;
      }
      const v2Stolen = expectedUnstakeTheftFlag(
        position,
        new BN(1),
        new BN(0),
        PROTOCOL_CONFIG_V2,
      );
      if (!v2Stolen) {
        candidate++;
        continue;
      }
      nextPositionId = candidate + 1;
      const randomOutput = deriveMockCommitment(position, 1, new BN(1), new BN(0));
      return { positionId, position, randomOutput };
    }
    throw new Error("Could not find a V1-safe / V2-stolen Cowboy position");
  }

  async function findV2StolenCowboy(maxAttempts = 1000): Promise<{
    positionId: BN;
    position: web3.PublicKey;
  }> {
    const game = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    let candidate = game.nextPositionId.toNumber();
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(candidate);
      const [position] = derivePosition(
        rodeoCoreProgram.programId,
        globalConfig,
        positionId,
      );
      const role = expectedRevealRole(position, PROTOCOL_CONFIG_V2);
      if (role !== "cowboy") {
        candidate++;
        continue;
      }
      const cowboyKind = expectedCowboyKind(position, PROTOCOL_CONFIG_V2);
      if (cowboyKind === "desperado") {
        candidate++;
        continue;
      }
      const stolen = expectedUnstakeTheftFlag(
        position,
        new BN(1),
        new BN(0),
        PROTOCOL_CONFIG_V2,
      );
      if (!stolen) {
        candidate++;
        continue;
      }
      nextPositionId = candidate + 1;
      return { positionId, position };
    }
    throw new Error("Could not find a V2-stolen non-Desperado Cowboy position");
  }

  it("stolen Cowboy routes ANSEM to active Bull pool with exact liability/index changes", async () => {
    const { positionId: bullPositionId } = await findBullPosition();
    await prepareUnstakeReadyPositionById(bullPositionId, new BN(0));

    const claimable = new BN(1_000_000_000);
    const { positionId: cowboyPositionId, position: cowboyPosition } =
      await findPositionForUnstake(
        (_id, _pos, _role, cowboyKind, stolen) => cowboyKind !== "desperado" && stolen,
      );
    await ensureRecognizedReserve(claimable);
    await prepareUnstakeReadyPositionById(cowboyPositionId, claimable);

    const ownerAnsemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const bullBefore = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(bullAccumulator);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    const bullPoolContributionPromise = collectOneEvent<BullPoolContributionEvent>(
      "bullPoolContribution",
    );
    const positionUnstakedPromise = collectOneEvent<PositionUnstakedEvent>("positionUnstaked");
    const rewardPaidPromise = collectEvents<{ amountAtomic: BN }>("rewardPaid", 1, 2_000);

    const { actionNonce } = await requestUnstake(cowboyPositionId);
    await settleUnstake(cowboyPositionId, actionNonce);

    const ownerAnsemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfter = await getAccount(provider.connection, rewardVault);
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const bullAfter = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(bullAccumulator);
    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const unassignedPosition =
      await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(cowboyPosition);

    expect(ownerAnsemAfter.amount.toString()).toBe(ownerAnsemBefore.amount.toString());
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.toString(),
    );
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.sub(claimable).toString(),
    );
    expect(rewardAfter.bullPoolLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolLiabilityAtomic.add(claimable).toString(),
    );
    expect(rewardAfter.bullPoolUnallocatedLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolUnallocatedLiabilityAtomic.toString(),
    );
    expect(rewardAfter.ansemClaimedAtomic.toString()).toBe(
      rewardBefore.ansemClaimedAtomic.toString(),
    );

    const totalPower = gameBefore.totalActiveBullPower;
    const numerator = claimable.mul(REWARD_PER_WEIGHT_SCALE).add(bullBefore.bullIndexRemainderScaled);
    const increment = numerator.div(totalPower);
    const newRemainder = numerator.mod(totalPower);
    const expectedRewardPerWeight = bullBefore.rewardPerWeightScaled.add(increment);

    expect(bullAfter.rewardPerWeightScaled.toString()).toBe(expectedRewardPerWeight.toString());
    expect(bullAfter.bullIndexRemainderScaled.toString()).toBe(newRemainder.toString());

    expect(gameAfter.activeBullCount.toString()).toBe(gameBefore.activeBullCount.toString());
    expect(gameAfter.totalActiveBullPower.toString()).toBe(gameBefore.totalActiveBullPower.toString());
    expect(gameAfter.activeCowboyCount.toString()).toBe(
      gameBefore.activeCowboyCount.subn(1).toString(),
    );
    expect(gameAfter.livePositionCount.toString()).toBe(
      gameBefore.livePositionCount.subn(1).toString(),
    );
    expect(gameAfter.accountedPrincipalAtomic.toString()).toBe(
      gameBefore.accountedPrincipalAtomic.sub(stakeAmountAtomic).toString(),
    );

    expect(unassignedPosition).toBeNull();

    const positionUnstaked = await positionUnstakedPromise;
    ansemFateKey(positionUnstaked.ansemFate, "toBullPool");
    expect(positionUnstaked.ansemPaidToOwner.toString()).toBe("0");
    expect(positionUnstaked.ansemRoutedToBullPool.toString()).toBe(claimable.toString());

    const bullPoolContribution = await bullPoolContributionPromise;
    bullPoolSourceKey(bullPoolContribution.source, "unstakeTheft");
    expect(bullPoolContribution.amountAtomic.toString()).toBe(claimable.toString());
    expect(bullPoolContribution.epoch.toString()).toBe(rewardBefore.currentEpoch.toString());

    const rewardPaid = await rewardPaidPromise;
    expect(rewardPaid.length).toBe(0);
  }, 180_000);

  it("stolen Cowboy with zero active Bulls routes to unallocated liability", async () => {
    await unstakeAllBulls();

    const claimable = new BN(1_000_000_000);
    const { positionId, position } = await findPositionForUnstake(
      (_id, _pos, _role, cowboyKind, stolen) => cowboyKind !== "desperado" && stolen,
    );
    await ensureRecognizedReserve(claimable);
    await prepareUnstakeReadyPositionById(positionId, claimable);

    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const ownerAnsemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const bullBefore = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(bullAccumulator);

    const bullPoolContributionPromise = collectOneEvent<BullPoolContributionEvent>(
      "bullPoolContribution",
    );
    const positionUnstakedPromise = collectOneEvent<PositionUnstakedEvent>("positionUnstaked");
    const rewardPaidPromise = collectEvents<{ amountAtomic: BN }>("rewardPaid", 1, 2_000);

    const { actionNonce } = await requestUnstake(positionId);
    await settleUnstake(positionId, actionNonce);

    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const ownerAnsemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfter = await getAccount(provider.connection, rewardVault);
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const bullAfter = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(bullAccumulator);
    const unassignedPosition = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position);

    expect(ownerAnsemAfter.amount.toString()).toBe(ownerAnsemBefore.amount.toString());
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.toString(),
    );
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.sub(claimable).toString(),
    );
    expect(rewardAfter.bullPoolLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolLiabilityAtomic.toString(),
    );
    expect(rewardAfter.bullPoolUnallocatedLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolUnallocatedLiabilityAtomic.add(claimable).toString(),
    );
    expect(rewardAfter.ansemClaimedAtomic.toString()).toBe(
      rewardBefore.ansemClaimedAtomic.toString(),
    );

    expect(bullAfter.rewardPerWeightScaled.toString()).toBe(
      bullBefore.rewardPerWeightScaled.toString(),
    );
    expect(bullAfter.bullIndexRemainderScaled.toString()).toBe(
      bullBefore.bullIndexRemainderScaled.toString(),
    );

    expect(gameAfter.activeBullCount.toString()).toBe(gameBefore.activeBullCount.toString());
    expect(gameAfter.totalActiveBullPower.toString()).toBe(gameBefore.totalActiveBullPower.toString());
    expect(gameAfter.activeCowboyCount.toString()).toBe(
      gameBefore.activeCowboyCount.subn(1).toString(),
    );
    expect(gameAfter.livePositionCount.toString()).toBe(
      gameBefore.livePositionCount.subn(1).toString(),
    );
    expect(gameAfter.accountedPrincipalAtomic.toString()).toBe(
      gameBefore.accountedPrincipalAtomic.sub(stakeAmountAtomic).toString(),
    );

    expect(unassignedPosition).toBeNull();

    const positionUnstaked = await positionUnstakedPromise;
    ansemFateKey(positionUnstaked.ansemFate, "toBullPool");
    expect(positionUnstaked.ansemPaidToOwner.toString()).toBe("0");
    expect(positionUnstaked.ansemRoutedToBullPool.toString()).toBe(claimable.toString());

    const bullPoolContribution = await bullPoolContributionPromise;
    bullPoolSourceKey(bullPoolContribution.source, "unstakeTheft");
    expect(bullPoolContribution.amountAtomic.toString()).toBe(claimable.toString());

    const rewardPaid = await rewardPaidPromise;
    expect(rewardPaid.length).toBe(0);
  }, 180_000);

  it("Desperado exit is immune to unstake theft and receives full ANSEM", async () => {
    const claimable = new BN(1_000_000_000);
    const { positionId, position } = await findCowboyPosition(254, 20000);
    await ensureRecognizedReserve(claimable);
    await prepareUnstakeReadyPositionById(positionId, claimable);

    const ownerAnsemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const rodeoBefore = await getAccount(provider.connection, payerRodeoAccount);

    const positionUnstakedPromise = collectOneEvent<PositionUnstakedEvent>("positionUnstaked");

    const { actionNonce } = await requestUnstake(positionId);
    await settleUnstake(positionId, actionNonce);

    const ownerAnsemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfter = await getAccount(provider.connection, rewardVault);
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const rodeoAfter = await getAccount(provider.connection, payerRodeoAccount);
    const unassignedPosition = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position);

    expect(new BN(ownerAnsemAfter.amount.toString()).toString()).toBe(
      new BN(ownerAnsemBefore.amount.toString()).add(claimable).toString(),
    );
    expect(vaultAfter.amount.toString()).toBe(
      new BN(vaultBefore.amount.toString()).sub(claimable).toString(),
    );
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.sub(claimable).toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.sub(claimable).toString(),
    );
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.sub(claimable).toString(),
    );
    expect(rewardAfter.bullPoolLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolLiabilityAtomic.toString(),
    );
    expect(rewardAfter.bullPoolUnallocatedLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolUnallocatedLiabilityAtomic.toString(),
    );
    expect(rewardAfter.ansemClaimedAtomic.toString()).toBe(
      rewardBefore.ansemClaimedAtomic.add(claimable).toString(),
    );

    const returned = stakeAmountAtomic.muln(9_500).divn(10_000);
    const burned = stakeAmountAtomic.sub(returned);
    expect(new BN(principalVaultAfter.amount.toString()).toString()).toBe(
      new BN(principalVaultBefore.amount.toString()).sub(stakeAmountAtomic).toString(),
    );
    expect(new BN(rodeoAfter.amount.toString()).toString()).toBe(
      new BN(rodeoBefore.amount.toString()).add(returned).toString(),
    );

    expect(gameAfter.livePositionCount.toString()).toBe(
      gameBefore.livePositionCount.subn(1).toString(),
    );
    expect(gameAfter.activeCowboyCount.toString()).toBe(
      gameBefore.activeCowboyCount.subn(1).toString(),
    );
    expect(gameAfter.accountedPrincipalAtomic.toString()).toBe(
      gameBefore.accountedPrincipalAtomic.sub(stakeAmountAtomic).toString(),
    );

    expect(unassignedPosition).toBeNull();

    const positionUnstaked = await positionUnstakedPromise;
    ansemFateKey(positionUnstaked.ansemFate, "immune");
    expect(positionUnstaked.ansemPaidToOwner.toString()).toBe(claimable.toString());
    expect(positionUnstaked.ansemRoutedToBullPool.toString()).toBe("0");
  }, 180_000);

  it("Bull settlement does not double-decrement bull_pool_liability", async () => {
    const stolenAmount = new BN(1_000_000_000);

    const { positionId: bullPositionId, position: bullPosition } = await findBullPosition();
    await prepareUnstakeReadyPositionById(bullPositionId, new BN(0));

    const { positionId: cowboyPositionId } = await findPositionForUnstake(
      (_id, _pos, _role, cowboyKind, stolen) => cowboyKind !== "desperado" && stolen,
    );
    await ensureRecognizedReserve(stolenAmount);
    await prepareUnstakeReadyPositionById(cowboyPositionId, stolenAmount);

    const { actionNonce: bullActionNonce } = await requestUnstake(bullPositionId);
    const { actionNonce: cowboyActionNonce } = await requestUnstake(cowboyPositionId);

    const rewardBeforeCowboy = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const bullBeforeCowboy = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(
      bullAccumulator,
    );
    const gameBeforeCowboy = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(
      globalGameState,
    );
    const positionBullBeforeCowboy = await rodeoAccounts(rodeoCoreProgram).position.fetch(
      bullPosition,
    );
    const ownerAnsemBeforeCowboy = await getAccount(provider.connection, payerAnsemAccount);

    await settleUnstake(cowboyPositionId, cowboyActionNonce);

    const rewardBeforeBull = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const bullBeforeBull = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(
      bullAccumulator,
    );
    const ownerAnsemBeforeBull = await getAccount(provider.connection, payerAnsemAccount);

    expect(rewardBeforeBull.bullPoolLiabilityAtomic.sub(rewardBeforeCowboy.bullPoolLiabilityAtomic).toString()).toBe(
      stolenAmount.toString(),
    );
    expect(ownerAnsemBeforeBull.amount.toString()).toBe(ownerAnsemBeforeCowboy.amount.toString());

    const totalPower = gameBeforeCowboy.totalActiveBullPower;
    const numerator = stolenAmount
      .mul(REWARD_PER_WEIGHT_SCALE)
      .add(bullBeforeCowboy.bullIndexRemainderScaled);
    const expectedIndexAfterCowboy = bullBeforeCowboy.rewardPerWeightScaled.add(
      numerator.div(totalPower),
    );
    const expectedBullIndexRemainder = numerator.mod(totalPower);

    expect(bullBeforeBull.rewardPerWeightScaled.toString()).toBe(
      expectedIndexAfterCowboy.toString(),
    );
    expect(bullBeforeBull.bullIndexRemainderScaled.toString()).toBe(
      expectedBullIndexRemainder.toString(),
    );

    const bullPower = new BN(positionBullBeforeCowboy.buckPower);
    const deltaIndex = expectedIndexAfterCowboy.sub(positionBullBeforeCowboy.lastBullRewardPerWeight);
    const expectedPayout = deltaIndex
      .mul(bullPower)
      .add(positionBullBeforeCowboy.bullAccrualRemainderScaled)
      .div(REWARD_PER_WEIGHT_SCALE);

    const positionUnstakedPromise = collectOneEvent<PositionUnstakedEvent>("positionUnstaked");

    await settleUnstake(bullPositionId, bullActionNonce);

    const ownerAnsemAfterBull = await getAccount(provider.connection, payerAnsemAccount);
    const rewardAfterBull = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameAfterBull = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(
      globalGameState,
    );
    const unassignedBull = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(
      bullPosition,
    );

    const payout = rewardAfterBull.ansemClaimedAtomic.sub(rewardBeforeBull.ansemClaimedAtomic);
    expect(payout.toString()).toBe(expectedPayout.toString());
    expect(payout.gtn(0)).toBe(true);

    expect(new BN(ownerAnsemAfterBull.amount.toString()).toString()).toBe(
      new BN(ownerAnsemBeforeBull.amount.toString()).add(payout).toString(),
    );
    expect(rewardAfterBull.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBeforeBull.totalAnsemLiabilityAtomic.sub(payout).toString(),
    );
    expect(rewardAfterBull.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBeforeBull.recognizedRewardBalanceAtomic.sub(payout).toString(),
    );
    expect(rewardAfterBull.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBeforeBull.positionClaimableLiabilityAtomic.toString(),
    );
    expect(rewardAfterBull.bullPoolLiabilityAtomic.toString()).toBe(
      rewardBeforeBull.bullPoolLiabilityAtomic.sub(payout).toString(),
    );

    expect(gameAfterBull.activeBullCount.toString()).toBe(
      gameBeforeCowboy.activeBullCount.subn(1).toString(),
    );
    expect(gameAfterBull.livePositionCount.toString()).toBe(
      gameBeforeCowboy.livePositionCount.subn(2).toString(),
    );
    expect(gameAfterBull.accountedPrincipalAtomic.toString()).toBe(
      gameBeforeCowboy.accountedPrincipalAtomic.sub(stakeAmountAtomic.muln(2)).toString(),
    );

    expect(unassignedBull).toBeNull();

    const positionUnstaked = await positionUnstakedPromise;
    ansemFateKey(positionUnstaked.ansemFate, "toOwner");
    expect(positionUnstaked.ansemPaidToOwner.toString()).toBe(payout.toString());
    expect(positionUnstaked.ansemRoutedToBullPool.toString()).toBe("0");
  }, 180_000);

  it("zero-ANSEM unstake exits without ANSEM transfer", async () => {
    const { positionId, position } = await findPositionForUnstake(
      (_id, _pos, _role, cowboyKind, stolen) => cowboyKind !== "desperado" && !stolen,
    );
    await prepareUnstakeReadyPositionById(positionId, new BN(0));

    const posBefore = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(posBefore.claimableAnsemAtomic.toString()).toBe("0");

    const ownerAnsemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const rodeoBefore = await getAccount(provider.connection, payerRodeoAccount);

    const rewardPaidPromise = collectEvents<{ amountAtomic: BN }>("rewardPaid", 1, 2_000);

    const { actionNonce } = await requestUnstake(positionId);
    await settleUnstake(positionId, actionNonce);

    const ownerAnsemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfter = await getAccount(provider.connection, rewardVault);
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const rodeoAfter = await getAccount(provider.connection, payerRodeoAccount);
    const unassignedPosition = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position);

    expect(ownerAnsemAfter.amount.toString()).toBe(ownerAnsemBefore.amount.toString());
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.toString(),
    );
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.toString(),
    );
    expect(rewardAfter.ansemClaimedAtomic.toString()).toBe(
      rewardBefore.ansemClaimedAtomic.toString(),
    );

    const returned = stakeAmountAtomic.muln(9_500).divn(10_000);
    expect(new BN(principalVaultAfter.amount.toString()).toString()).toBe(
      new BN(principalVaultBefore.amount.toString()).sub(stakeAmountAtomic).toString(),
    );
    expect(new BN(rodeoAfter.amount.toString()).sub(new BN(rodeoBefore.amount.toString())).toString()).toBe(
      returned.toString(),
    );

    expect(gameAfter.livePositionCount.toString()).toBe(
      gameBefore.livePositionCount.subn(1).toString(),
    );
    expect(gameAfter.activeCowboyCount.toString()).toBe(
      gameBefore.activeCowboyCount.subn(1).toString(),
    );
    expect(gameAfter.accountedPrincipalAtomic.toString()).toBe(
      gameBefore.accountedPrincipalAtomic.sub(stakeAmountAtomic).toString(),
    );

    expect(unassignedPosition).toBeNull();

    const rewardPaid = await rewardPaidPromise;
    expect(rewardPaid.length).toBe(0);
  }, 120_000);

  it("recover_unstake_timeout is rejected before timeout and preserves all state", async () => {
    const claimable = new BN(1_000_000_000);
    const { positionId, position } = await findPositionForUnstake(
      (_id, _pos, _role, cowboyKind, stolen) => cowboyKind !== "desperado" && !stolen,
    );
    await ensureRecognizedReserve(claimable);
    await prepareUnstakeReadyPositionById(positionId, claimable);

    const posBefore = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const ownerRodeoBefore = await getAccount(provider.connection, payerRodeoAccount);
    const ownerAnsemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    const { actionNonce } = await requestUnstake(positionId);
    const posAfterRequest = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);

    await expect(recoverUnstakeTimeout(positionId, actionNonce)).rejects.toThrow();

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const ownerRodeoAfter = await getAccount(provider.connection, payerRodeoAccount);
    const ownerAnsemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfter = await getAccount(provider.connection, rewardVault);
    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(posAfter.claimableAnsemAtomic.toString()).toBe(posBefore.claimableAnsemAtomic.toString());
    expect(posAfter.nextActionNonce.toString()).toBe(posAfterRequest.nextActionNonce.toString());
    expect(posAfter.pendingActionActive).toBe(true);
    expect(posAfter.pendingActionType).toHaveProperty("unstake");
    expect(posAfter.pendingActionNonce.toString()).toBe(actionNonce.toString());

    expect(principalVaultAfter.amount.toString()).toBe(principalVaultBefore.amount.toString());
    expect(ownerRodeoAfter.amount.toString()).toBe(ownerRodeoBefore.amount.toString());
    expect(ownerAnsemAfter.amount.toString()).toBe(ownerAnsemBefore.amount.toString());
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());
    expect(gameAfter.livePositionCount.toString()).toBe(gameBefore.livePositionCount.toString());
    expect(gameAfter.activeCowboyCount.toString()).toBe(gameBefore.activeCowboyCount.toString());
    expect(gameAfter.totalActiveCowboyWeight.toString()).toBe(
      gameBefore.totalActiveCowboyWeight.toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.toString(),
    );
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.toString(),
    );
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.toString(),
    );
    expect(rewardAfter.bullPoolLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolLiabilityAtomic.toString(),
    );
    expect(rewardAfter.bullPoolUnallocatedLiabilityAtomic.toString()).toBe(
      rewardBefore.bullPoolUnallocatedLiabilityAtomic.toString(),
    );
  }, 120_000);

  it("recover_unstake_timeout after timeout preserves all state and allows a new request", async () => {
    const claimable = new BN(1_000_000_000);
    const { positionId, position } = await findPositionForUnstake(
      (_id, _pos, _role, cowboyKind, stolen) => cowboyKind !== "desperado" && !stolen,
    );
    await ensureRecognizedReserve(claimable);
    await prepareUnstakeReadyPositionById(positionId, claimable);

    const posBefore = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const ownerRodeoBefore = await getAccount(provider.connection, payerRodeoAccount);
    const ownerAnsemBefore = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBefore = await getAccount(provider.connection, rewardVault);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const rewardBefore = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    const { pendingRandomness: pendingRandomness1, actionNonce: actionNonce1 } =
      await requestUnstake(positionId);
    const posAfterRequest = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);

    await sleep(2_500);
    await recoverUnstakeTimeout(positionId, actionNonce1);

    const posAfter = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const ownerRodeoAfter = await getAccount(provider.connection, payerRodeoAccount);
    const ownerAnsemAfter = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfter = await getAccount(provider.connection, rewardVault);
    const gameAfter = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const rewardAfter = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(principalVaultAfter.amount.toString()).toBe(principalVaultBefore.amount.toString());
    expect(ownerRodeoAfter.amount.toString()).toBe(ownerRodeoBefore.amount.toString());
    expect(ownerAnsemAfter.amount.toString()).toBe(ownerAnsemBefore.amount.toString());
    expect(vaultAfter.amount.toString()).toBe(vaultBefore.amount.toString());
    expect(gameAfter.livePositionCount.toString()).toBe(gameBefore.livePositionCount.toString());
    expect(gameAfter.activeCowboyCount.toString()).toBe(gameBefore.activeCowboyCount.toString());
    expect(gameAfter.totalActiveCowboyWeight.toString()).toBe(
      gameBefore.totalActiveCowboyWeight.toString(),
    );
    expect(rewardAfter.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBefore.totalAnsemLiabilityAtomic.toString(),
    );
    expect(rewardAfter.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBefore.positionClaimableLiabilityAtomic.toString(),
    );
    expect(rewardAfter.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBefore.recognizedRewardBalanceAtomic.toString(),
    );

    expect(posAfter.pendingActionActive).toBe(false);
    expect(posAfter.pendingActionType).toHaveProperty("reveal");
    expect(posAfter.pendingActionNonce.toString()).toBe("0");
    expect(posAfter.nextActionNonce.toString()).toBe(posAfterRequest.nextActionNonce.toString());
    expect(posAfter.claimableAnsemAtomic.toString()).toBe(posBefore.claimableAnsemAtomic.toString());

    const pendingAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(
      pendingRandomness1,
    );
    expect(pendingAccount).toBeNull();

    const { pendingRandomness: pendingRandomness2, actionNonce: actionNonce2 } =
      await requestUnstake(positionId);
    expect(actionNonce2.gt(actionNonce1)).toBe(true);
    expect(pendingRandomness2.toBase58()).not.toBe(pendingRandomness1.toBase58());

    await expect(settleUnstake(positionId, actionNonce1)).rejects.toThrow();

    // Clean up with the valid new action.
    await settleUnstake(positionId, actionNonce2);
  }, 120_000);

  it("historical V1/V2 unstake snapshot with same input producing different theft", async () => {
    const { positionId: positionAId, position: positionA, randomOutput } =
      await findV1SafeV2StolenCowboy();
    const v1Prediction = expectedUnstakeTheftFlag(
      positionA,
      new BN(1),
      new BN(0),
      PROTOCOL_CONFIG_V1,
    );
    const v2Prediction = expectedUnstakeTheftFlag(
      positionA,
      new BN(1),
      new BN(0),
      PROTOCOL_CONFIG_V2,
    );

    const claimable = new BN(1_000_000_000);
    await ensureRecognizedReserve(claimable);
    await prepareUnstakeReadyPositionById(positionAId, claimable);

    const { pendingRandomness: pendingA, actionNonce: actionNonceA } =
      await requestUnstake(positionAId);
    const pendingAccountA = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(pendingA);
    expect(pendingAccountA.configVersionSnapshot.toString()).toBe("1");

    const protocolConfigV2 = await fixtureCreateProtocolConfigV2(new BN(2));
    await fixtureSetCurrentConfigVersion(protocolConfigV2);

    const ownerAnsemBeforeA = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBeforeA = await getAccount(provider.connection, rewardVault);
    const rewardBeforeA = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const principalVaultBeforeA = await getAccount(provider.connection, principalVault);
    const rodeoBeforeA = await getAccount(provider.connection, payerRodeoAccount);

    await settleUnstake(positionAId, actionNonceA);

    const ownerAnsemAfterA = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfterA = await getAccount(provider.connection, rewardVault);
    const rewardAfterA = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const principalVaultAfterA = await getAccount(provider.connection, principalVault);
    const rodeoAfterA = await getAccount(provider.connection, payerRodeoAccount);

    expect(new BN(ownerAnsemAfterA.amount.toString()).sub(new BN(ownerAnsemBeforeA.amount.toString())).toString()).toBe(
      claimable.toString(),
    );
    expect(vaultAfterA.amount.toString()).toBe(
      new BN(vaultBeforeA.amount.toString()).sub(claimable).toString(),
    );
    expect(rewardAfterA.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBeforeA.positionClaimableLiabilityAtomic.sub(claimable).toString(),
    );
    expect(rewardAfterA.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBeforeA.totalAnsemLiabilityAtomic.sub(claimable).toString(),
    );
    expect(rewardAfterA.recognizedRewardBalanceAtomic.toString()).toBe(
      rewardBeforeA.recognizedRewardBalanceAtomic.sub(claimable).toString(),
    );
    expect(rewardAfterA.ansemClaimedAtomic.toString()).toBe(
      rewardBeforeA.ansemClaimedAtomic.add(claimable).toString(),
    );

    const v1Returned = stakeAmountAtomic.muln(9_500).divn(10_000);
    expect(new BN(principalVaultAfterA.amount.toString()).toString()).toBe(
      new BN(principalVaultBeforeA.amount.toString()).sub(stakeAmountAtomic).toString(),
    );
    expect(new BN(rodeoAfterA.amount.toString()).toString()).toBe(
      new BN(rodeoBeforeA.amount.toString()).add(v1Returned).toString(),
    );

    const { positionId: positionBId, position: positionB } = await findV2StolenCowboy();
    await ensureRecognizedReserve(claimable);
    await prepareUnstakeReadyPositionById(positionBId, claimable);

    const { pendingRandomness: pendingB, actionNonce: actionNonceB } =
      await requestUnstake(positionBId);
    const pendingAccountB = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(pendingB);
    expect(pendingAccountB.configVersionSnapshot.toString()).toBe("2");

    const gameBeforeB = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const rewardBeforeB = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const ownerAnsemBeforeB = await getAccount(provider.connection, payerAnsemAccount);
    const vaultBeforeB = await getAccount(provider.connection, rewardVault);
    const principalVaultBeforeB = await getAccount(provider.connection, principalVault);
    const rodeoBeforeB = await getAccount(provider.connection, payerRodeoAccount);

    const positionUnstakedPromise = collectOneEvent<PositionUnstakedEvent>("positionUnstaked");

    await settleUnstake(positionBId, actionNonceB);

    const gameAfterB = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);
    const rewardAfterB = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);
    const ownerAnsemAfterB = await getAccount(provider.connection, payerAnsemAccount);
    const vaultAfterB = await getAccount(provider.connection, rewardVault);
    const principalVaultAfterB = await getAccount(provider.connection, principalVault);
    const rodeoAfterB = await getAccount(provider.connection, payerRodeoAccount);
    const unassignedB = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(positionB);

    expect(unassignedB).toBeNull();
    expect(ownerAnsemAfterB.amount.toString()).toBe(ownerAnsemBeforeB.amount.toString());
    expect(vaultAfterB.amount.toString()).toBe(vaultBeforeB.amount.toString());

    if (gameBeforeB.totalActiveBullPower.gtn(0)) {
      const totalPower = gameBeforeB.totalActiveBullPower;
      const bullBefore = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(bullAccumulator);
      const numerator = claimable
        .mul(REWARD_PER_WEIGHT_SCALE)
        .add(bullBefore.bullIndexRemainderScaled);
      const increment = numerator.div(totalPower);
      const newRemainder = numerator.mod(totalPower);
      const bullAfter = await rodeoAccounts(rodeoCoreProgram).bullAccumulator.fetch(bullAccumulator);
      expect(bullAfter.rewardPerWeightScaled.toString()).toBe(
        bullBefore.rewardPerWeightScaled.add(increment).toString(),
      );
      expect(bullAfter.bullIndexRemainderScaled.toString()).toBe(newRemainder.toString());
      expect(rewardAfterB.bullPoolLiabilityAtomic.toString()).toBe(
        rewardBeforeB.bullPoolLiabilityAtomic.add(claimable).toString(),
      );
      expect(rewardAfterB.bullPoolUnallocatedLiabilityAtomic.toString()).toBe(
        rewardBeforeB.bullPoolUnallocatedLiabilityAtomic.toString(),
      );
    } else {
      expect(rewardAfterB.bullPoolUnallocatedLiabilityAtomic.toString()).toBe(
        rewardBeforeB.bullPoolUnallocatedLiabilityAtomic.add(claimable).toString(),
      );
      expect(rewardAfterB.bullPoolLiabilityAtomic.toString()).toBe(
        rewardBeforeB.bullPoolLiabilityAtomic.toString(),
      );
    }
    expect(rewardAfterB.positionClaimableLiabilityAtomic.toString()).toBe(
      rewardBeforeB.positionClaimableLiabilityAtomic.sub(claimable).toString(),
    );
    expect(rewardAfterB.totalAnsemLiabilityAtomic.toString()).toBe(
      rewardBeforeB.totalAnsemLiabilityAtomic.toString(),
    );
    expect(rewardAfterB.ansemClaimedAtomic.toString()).toBe(
      rewardBeforeB.ansemClaimedAtomic.toString(),
    );

    const v2Returned = stakeAmountAtomic.muln(8_000).divn(10_000);
    expect(new BN(principalVaultAfterB.amount.toString()).toString()).toBe(
      new BN(principalVaultBeforeB.amount.toString()).sub(stakeAmountAtomic).toString(),
    );
    expect(new BN(rodeoAfterB.amount.toString()).toString()).toBe(
      new BN(rodeoBeforeB.amount.toString()).add(v2Returned).toString(),
    );

    const positionUnstaked = await positionUnstakedPromise;
    ansemFateKey(positionUnstaked.ansemFate, "toBullPool");
    expect(positionUnstaked.ansemPaidToOwner.toString()).toBe("0");
    expect(positionUnstaked.ansemRoutedToBullPool.toString()).toBe(claimable.toString());

    console.log("historical V1/V2 same-input vector:", {
      positionA: positionAId.toString(),
      positionB: positionBId.toString(),
      randomOutput: Buffer.from(randomOutput).toString("hex"),
      v1Prediction,
      v2Prediction,
    });
  }, 180_000);



  it("production Bull reveal: proof-buffer lifecycle, registry mutation, receipt, and refund", async () => {
    // Independent player (A) and prover (B).
    const player = web3.Keypair.generate();
    const prover = web3.Keypair.generate();

    // Fund player for staking and prover for buffer rent/fees.
    const fundIxA = web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: player.publicKey,
      lamports: 1_000_000_000,
    });
    const fundIxB = web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: prover.publicKey,
      lamports: 100_000_000,
    });
    await provider.sendAndConfirm(new web3.Transaction().add(fundIxA, fundIxB), [payer]);

    // Fund player RODEO by creating an associated account and transferring
    // from the payer's prefunded account. The mint authority was revoked in
    // beforeAll, so mintTo is not available.
    const playerRodeoAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      rodeoMint,
      player.publicKey,
    );
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerRodeoAccount, payer.publicKey, 100_000_000_000n),
      ),
      [payer],
    );

    // Pre-reveal BullRegistry state from chain and tracker parity.
    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const registryBefore = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const beforeRoot = new Uint8Array(registryBefore.ownerTreeRoot);
    const beforeCount = BigInt(registryBefore.totalBullCount.toString());
    const beforePower = BigInt(registryBefore.totalBuckPower.toString());
    const beforeVersion = BigInt(registryBefore.registryVersion.toString());
    await syncTrackerWithChain();

    // Find a position that deterministically reveals as Bull.
    const { positionId, position } = await findBullPosition();

    // Player stakes the position.
    await stakeAndCommit(positionId, stakeAmountAtomic, playerRodeoAccount, player);

    // Build, stage, and settle the real production Bull proof.
    const staged = await revealBullWithProof(positionId, player, prover);

    // Prover/player SOL pre-settlement captured inside revealBullWithProof.
    const proverBalanceBeforeSettle = staged.proverBalanceBeforeSettle;
    const playerBalanceBeforeSettle = staged.playerBalanceBeforeSettle;

    const bufferLamportsBefore = staged.bufferLamportsBefore;
    const bufferDataLenBefore = staged.bufferDataLenBefore;
    const bufferAccountBefore = staged.bufferAccount;
    expect(bufferAccountBefore.consumed).toBe(false);
    expect(bufferAccountBefore.finalized).toBe(true);
    expect(bufferAccountBefore.refundRecipient.equals(prover.publicKey)).toBe(true);
    expect(bufferAccountBefore.position.equals(position)).toBe(true);

    // Assert Position is Bull and owner is player A.
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.role.bull).toBeTruthy();
    expect(pos.owner.equals(player.publicKey)).toBe(true);
    expect(pos.buckPower).toBeGreaterThan(0);
    expect(pos.revealConfigVersion.toString()).toBe("1");

    // Assert BullRegistry mutation.
    const registryAfter = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfter.totalBullCount.toString())).toBe(beforeCount + 1n);
    expect(BigInt(registryAfter.totalBuckPower.toString())).toBe(beforePower + BigInt(pos.buckPower));
    expect(BigInt(registryAfter.registryVersion.toString())).toBe(beforeVersion + 1n);
    expect(Buffer.from(new Uint8Array(registryAfter.ownerTreeRoot)).equals(
      Buffer.from(bullRegistryTracker.buildRegistry().rootNode.hash),
    )).toBe(true);

    // Assert tracker matches chain.
    await assertTrackerMatchesChain();

    // Assert owner membership proof in the resulting tree.
    const ownerMembershipProof = ownerProof(bullRegistryTracker.buildRegistry(), player.publicKey);
    expect(ownerMembershipProof.leaf.owner.equals(player.publicKey)).toBe(true);
    expect(ownerMembershipProof.leaf.activeBullCount).toBe(1n);
    expect(ownerMembershipProof.leaf.totalBuckPower).toBe(BigInt(pos.buckPower));

    // Assert Bull membership proof in the resulting tree.
    const bullMembershipProof = bullProof(bullRegistryTracker.buildRegistry(), player.publicKey, position);
    expect(bullMembershipProof.leaf.position.equals(position)).toBe(true);
    expect(bullMembershipProof.leaf.buckPower).toBe(pos.buckPower);
    expect(bullMembershipProof.leaf.owner.equals(player.publicKey)).toBe(true);

    // Assert MPL Core PositionReceipt exists with correct ownership and plugins.
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptInfo = await provider.connection.getAccountInfo(receiptAsset);
    expect(receiptInfo).not.toBeNull();
    expect(receiptInfo!.owner.equals(MPL_CORE_PROGRAM_ID)).toBe(true);
    // TODO: add specific plugin/owner assertions once MPL Core helpers are available.

    // Assert the BullProofBuffer was closed and rent refunded to prover B.
    const bufferInfoAfter = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfoAfter).toBeNull();

    const proverBalanceAfter = await getLamportBalance(provider, prover.publicKey);
    const playerBalanceAfter = await getLamportBalance(provider, player.publicKey);

    // Prover B must receive the full buffer rent, not just "at least" the seed funding.
    const proverRefund = proverBalanceAfter - proverBalanceBeforeSettle;
    const playerBalanceChange = playerBalanceAfter - playerBalanceBeforeSettle;
    expect(proverRefund).toBe(bufferLamportsBefore);
    // Prover B receives the entire buffer rent; player A does not.
    expect(proverBalanceAfter).toBe(proverBalanceBeforeSettle + bufferLamportsBefore);
    // Player A's balance changes only by small rent refunds/fees (e.g. the
    // pending-randomness account is closed to them); it does NOT increase by the
    // much larger buffer rent, which went to the prover.
    expect(Math.abs(playerBalanceChange)).toBeLessThan(10_000_000);
    expect(playerBalanceChange).toBeLessThan(bufferLamportsBefore);

    console.log('BullProofBuffer close evidence:', {
      bufferPda: staged.bufferPda.toBase58(),
      bufferLamportsBefore,
      bufferDataLenBefore,
      bufferFinalized: bufferAccountBefore.finalized,
      bufferConsumedBefore: bufferAccountBefore.consumed,
      proverBalanceBeforeSettle,
      proverBalanceAfter,
      proverRefund,
      playerBalanceBeforeSettle,
      playerBalanceAfter,
      playerBalanceChange,
      receiptAsset: receiptAsset.toBase58(),
    });

    // Attempting to reuse the closed buffer must fail because it no longer exists.
    await expect(
      rodeoCoreProgram.methods
        .settleReveal()
        .accounts({
          settler: player.publicKey,
          globalConfig,
          globalGameState,
          rewardState,
          bullAccumulator,
          position,
          pendingRandomness: staged.pendingRandomness,
          protocolConfig: protocolConfigV1,
          owner: player.publicKey,
          receiptOwner: player.publicKey,
          receiptAsset,
          receiptCollection,
          receiptAuthority,
          receiptFunder: web3.PublicKey.findProgramAddressSync(
            [Buffer.from("receipt-funder"), position.toBuffer()],
            rodeoCoreProgram.programId,
          )[0],
          providerRandomnessAccount: web3.SYSVAR_RENT_PUBKEY,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          bullProofBuffer: staged.bufferPda,
          refundRecipient: prover.publicKey,
          systemProgram: web3.SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
        .signers([player])
        .rpc(),
    ).rejects.toThrow();
  }, 180_000);

  it("production Bull unstake: final-bull removal, receipt burn, and proof-buffer refund", async () => {
    // Independent player A and prover B.
    const player = web3.Keypair.generate();
    const prover = web3.Keypair.generate();

    // Fund player for staking/fees and prover for buffer rent/fees.
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: player.publicKey,
          lamports: 1_000_000_000,
        }),
        web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: prover.publicKey,
          lamports: 100_000_000,
        }),
      ),
      [payer],
    );

    // Pre-unstake BullRegistry state and tracker parity.
    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const registryBefore = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const beforeRoot = new Uint8Array(registryBefore.ownerTreeRoot);
    const beforeCount = BigInt(registryBefore.totalBullCount.toString());
    const beforePower = BigInt(registryBefore.totalBuckPower.toString());
    const beforeVersion = BigInt(registryBefore.registryVersion.toString());
    await syncTrackerWithChain();

    // Find a position that deterministically reveals as Bull, stake/reveal it,
    // then unstake it with a real removal proof.
    const { positionId, position } = await findBullPosition();
    const playerRodeoAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      rodeoMint,
      player.publicKey,
    );
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerRodeoAccount, payer.publicKey, 100_000_000_000n),
      ),
      [payer],
    );
    await stakeAndCommit(positionId, stakeAmountAtomic, playerRodeoAccount, player);
    await revealBullWithProof(positionId, player, prover);

    // Re-capture pre-unstake registry state after the Bull has been revealed.
    const registryBeforeUnstake = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const unstakeBeforeCount = BigInt(registryBeforeUnstake.totalBullCount.toString());
    const unstakeBeforePower = BigInt(registryBeforeUnstake.totalBuckPower.toString());
    const unstakeBeforeVersion = BigInt(registryBeforeUnstake.registryVersion.toString());
    expect(unstakeBeforeCount).toBeGreaterThan(0n);
    expect(unstakeBeforePower).toBeGreaterThan(0n);
    await syncTrackerWithChain();

    const claimable = new BN(1_000_000_000);
    const unstake = await unstakeBullWithProof(positionId, player, prover, claimable);

    // BullRegistry post-state: this Bull is removed and the owner tree root
    // is independently reconstructed by the tracker.
    const registryAfter = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfter.totalBullCount.toString())).toBe(unstakeBeforeCount - 1n);
    expect(BigInt(registryAfter.totalBuckPower.toString())).toBe(unstakeBeforePower - BigInt(unstake.bullPower.toString()));
    expect(BigInt(registryAfter.registryVersion.toString())).toBe(unstakeBeforeVersion + 1n);
    expect(Buffer.from(new Uint8Array(registryAfter.ownerTreeRoot)).equals(
      Buffer.from(bullRegistryTracker.buildRegistry().rootNode.hash),
    )).toBe(true);
    if (unstakeBeforeCount === 1n) {
      expect(Buffer.from(new Uint8Array(registryAfter.ownerTreeRoot)).equals(
        Buffer.from(emptyOwnerTreeRoot()),
      )).toBe(true);
    }

    // Independent owner non-membership proof verifies against the resulting root.
    const resultingRegistry = bullRegistryTracker.buildRegistry();
    const ownerAbsenceProof = ownerProof(resultingRegistry, player.publicKey);
    expect(ownerAbsenceProof.leaf.activeBullCount).toBe(0n);
    expect(ownerAbsenceProof.leaf.totalBuckPower).toBe(0n);
    verifyOwnerProof(player.publicKey, ownerAbsenceProof, resultingRegistry.rootNode);

    // Position and pending randomness are closed.
    const [pendingRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      position,
      1,
      new BN(unstake.actionNonce.toString()),
    );
    expect(await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position)).toBeNull();
    expect(await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(pendingRandomness)).toBeNull();

    // MPL Core PositionReceipt is burned / no longer an active receipt.
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptInfo = await provider.connection.getAccountInfo(receiptAsset);
    // MPL Core BurnV1 leaves a 1-byte tombstone owned by the MPL Core program.
    // The asset is no longer a usable PositionReceipt (discriminant 0x00).
    expect(receiptInfo).not.toBeNull();
    expect(receiptInfo!.owner.equals(MPL_CORE_PROGRAM_ID)).toBe(true);
    expect(receiptInfo!.data.length).toBe(1);
    expect(receiptInfo!.data[0]).toBe(0);

    // BullProofBuffer closed and prover B refunded.
    const bufferInfoAfter = await provider.connection.getAccountInfo(unstake.bufferPda);
    expect(bufferInfoAfter === null || bufferInfoAfter.lamports === 0).toBe(true);
    const proverBalanceAfter = await getLamportBalance(provider, prover.publicKey);
    expect(proverBalanceAfter).toBe(unstake.proverBalanceBeforeSettle + unstake.bufferLamportsBefore);

    // ReceiptFunder cleaned and refunded to the owner (player A).
    const receiptFunderAfter = await getLamportBalance(provider, unstake.receiptFunder);
    expect(receiptFunderAfter).toBe(0);
    const playerBalanceAfter = await getLamportBalance(provider, player.publicKey);
    expect(playerBalanceAfter - unstake.playerBalanceBeforeSettle).toBeGreaterThanOrEqual(unstake.receiptFunderBefore);

    // RODEO 5/95 exit: 5% burned, 95% returned to owner.
    const playerRodeoAfter = await getAccount(provider.connection, unstake.playerRodeoAccount);
    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const rodeoMintInfoAfter = await getMint(provider.connection, rodeoMint);
    const returned = stakeAmountAtomic.muln(9_500).divn(10_000);
    const burned = stakeAmountAtomic.sub(returned);
    expect(new BN(playerRodeoAfter.amount.toString()).toString()).toBe(returned.toString());
    expect(new BN(principalVaultAfter.amount.toString()).toString()).toBe(
      new BN(unstake.principalVaultBefore.amount.toString()).sub(stakeAmountAtomic).toString(),
    );
    expect(rodeoMintInfoAfter.supply.toString()).toBe(
      (BigInt(unstake.rodeoMintInfoBefore.supply.toString()) - BigInt(burned.toString())).toString(),
    );

    // Bull ANSEM immunity: all synchronized ANSEM goes to owner, none to bull pool.
    const playerAnsemAfter = await getAccount(provider.connection, unstake.playerAnsemAccount);
    expect(new BN(playerAnsemAfter.amount.toString()).toString()).toBe(
      new BN(unstake.playerAnsemBefore.amount.toString()).add(claimable).toString(),
    );
    const rewardVaultAfter = await getAccount(provider.connection, rewardVault);
    expect(new BN(rewardVaultAfter.amount.toString()).toString()).toBe(
      new BN(unstake.rewardVaultBefore.amount.toString()).sub(claimable).toString(),
    );

    // Replay of the same settle_unstake must be rejected.
    await expect(
      settleUnstake(positionId, new BN(unstake.actionNonce.toString()), payer, {
        bufferPda: unstake.bufferPda,
        refundRecipient: prover.publicKey,
      }, {
        ownerRodeoAccount: unstake.playerRodeoAccount,
        ownerAnsemAccount: unstake.playerAnsemAccount,
      }),
    ).rejects.toThrow();

    console.log('Bull unstake final-bull removal evidence:', {
      positionId: positionId.toString(),
      position: position.toBase58(),
      owner: player.publicKey.toBase58(),
      prover: prover.publicKey.toBase58(),
      bufferPda: unstake.bufferPda.toBase58(),
      bufferLamportsBefore: unstake.bufferLamportsBefore,
      bufferDataLenBefore: unstake.bufferDataLenBefore,
      proverBalanceBeforeSettle: unstake.proverBalanceBeforeSettle,
      proverBalanceAfter,
      proverRefund: unstake.bufferLamportsBefore,
      playerBalanceBeforeSettle: unstake.playerBalanceBeforeSettle,
      playerBalanceAfter,
      receiptFunderBefore: unstake.receiptFunderBefore,
      receiptFunderLamportsAfter: receiptFunderAfter,
      registryCountBefore: unstakeBeforeCount.toString(),
      registryCountAfter: registryAfter.totalBullCount.toString(),
      registryPowerBefore: unstakeBeforePower.toString(),
      registryPowerAfter: registryAfter.totalBuckPower.toString(),
      registryVersionBefore: unstakeBeforeVersion.toString(),
      registryVersionAfter: registryAfter.registryVersion.toString(),
      ownerTreeRootAfter: Buffer.from(new Uint8Array(registryAfter.ownerTreeRoot)).toString('hex'),
      emptyOwnerTreeRoot: Buffer.from(emptyOwnerTreeRoot()).toString('hex'),
      claimable: claimable.toString(),
      returned: returned.toString(),
      burned: burned.toString(),
      playerAnsemReceived: claimable.toString(),
      receiptAssetAfter: receiptInfo
        ? { owner: receiptInfo.owner.toBase58(), lamports: receiptInfo.lamports, dataLen: receiptInfo.data.length }
        : null,
    });
  }, 240_000);



  it("production Bull unstake: owner-remains removal with a second Bull unchanged", async () => {
    // Player A owns two live Bulls. Unstake one and assert A remains in the
    // registry with exactly the remaining Bull.
    const playerA = web3.Keypair.generate();
    const proverA = web3.Keypair.generate();
    const proverB = web3.Keypair.generate();

    await provider.sendAndConfirm(
      new web3.Transaction().add(
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: playerA.publicKey, lamports: 1_500_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: proverA.publicKey, lamports: 150_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: proverB.publicKey, lamports: 100_000_000 }),
      ),
      [payer],
    );

    // Capture registry state before creating A's Bulls.
    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const registryPre = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const preCount = BigInt(registryPre.totalBullCount.toString());
    const prePower = BigInt(registryPre.totalBuckPower.toString());
    const preVersion = BigInt(registryPre.registryVersion.toString());

    // Create A's first Bull using the production reveal flow.
    const { positionId: positionId1, position: position1 } = await findBullPosition();
    const playerARodeoAccount = await createAssociatedTokenAccount(provider.connection, payer, rodeoMint, playerA.publicKey);
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerARodeoAccount, payer.publicKey, 200_000_000_000n),
      ),
      [payer],
    );
    await stakeAndCommit(positionId1, stakeAmountAtomic, playerARodeoAccount, playerA);
    await revealBullWithProof(positionId1, playerA, proverA);

    // Create A's second Bull with a different prover.
    const { positionId: positionId2, position: position2 } = await findBullPosition();
    await stakeAndCommit(positionId2, stakeAmountAtomic, playerARodeoAccount, playerA);
    await revealBullWithProof(positionId2, playerA, proverB);

    const pos1 = await rodeoAccounts(rodeoCoreProgram).position.fetch(position1);
    const pos2 = await rodeoAccounts(rodeoCoreProgram).position.fetch(position2);
    expect(BigInt(pos1.buckPower)).toBeGreaterThan(0n);
    expect(BigInt(pos2.buckPower)).toBeGreaterThan(0n);

    const registryBefore = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const beforeCount = BigInt(registryBefore.totalBullCount.toString());
    const beforePower = BigInt(registryBefore.totalBuckPower.toString());
    const beforeVersion = BigInt(registryBefore.registryVersion.toString());
    expect(beforeCount).toBe(preCount + 2n);
    expect(beforePower).toBe(prePower + BigInt(pos1.buckPower) + BigInt(pos2.buckPower));
    expect(beforeVersion).toBe(preVersion + 2n);

    const ownerBullsBefore = bullRegistryTracker.getBulls(playerA.publicKey);
    expect(ownerBullsBefore.length).toBe(2);
    expect(ownerBullsBefore.some((b) => b.position.equals(position1))).toBe(true);
    expect(ownerBullsBefore.some((b) => b.position.equals(position2))).toBe(true);

    // Capture Bull #2 pre-state.
    const [receiptAsset2] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position2.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptInfo2Before = await provider.connection.getAccountInfo(receiptAsset2);
    expect(receiptInfo2Before).not.toBeNull();
    const receipt2OwnerBefore = receiptInfo2Before!.owner;
    const receipt2DataLenBefore = receiptInfo2Before!.data.length;

    // Prepare and request Unstake for Bull #1.
    const claimable = new BN(1_000_000_000);
    await fixturePreparePosition(positionId1, {
      roleCode: 2,
      cowboyKindCode: 0,
      accrualWeight: pos1.accrualWeight,
      buckPower: pos1.buckPower,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });
    await ensureRecognizedReserve(claimable);
    const { actionNonce: actionNonce1 } = await requestUnstake(positionId1, playerA);

    const playerAAnsemAccount = await createAssociatedTokenAccount(provider.connection, payer, ansemMint, playerA.publicKey);

    // Build and stage the current removal proof for Bull #1.
    const { staged, bufferLamportsBefore } = await buildAndStageUnstakeProof(
      positionId1,
      actionNonce1,
      playerA,
      proverA,
      new BN(2),
    );

    // Pre-settlement balances.
    const playerRodeoBefore = await getAccount(provider.connection, playerARodeoAccount);
    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const rodeoMintInfoBefore = await getMint(provider.connection, rodeoMint);
    const playerAnsemBefore = await getAccount(provider.connection, playerAAnsemAccount);
    const rewardVaultBefore = await getAccount(provider.connection, rewardVault);
    const proverBalanceBeforeSettle = await getLamportBalance(provider, proverA.publicKey);

    // Settle Bull #1 unstake.
    await settleUnstake(positionId1, actionNonce1, payer, {
      bufferPda: staged.bufferPda,
      refundRecipient: staged.refundRecipient,
    }, {
      ownerRodeoAccount: playerARodeoAccount,
      ownerAnsemAccount: playerAAnsemAccount,
    });

    // Update tracker and assert parity.
    bullRegistryTracker.unregisterBull(playerA.publicKey, position1);
    await assertTrackerMatchesChain();

    const registryAfter = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfter.totalBullCount.toString())).toBe(beforeCount - 1n);
    expect(BigInt(registryAfter.totalBuckPower.toString())).toBe(beforePower - BigInt(pos1.buckPower));
    expect(BigInt(registryAfter.registryVersion.toString())).toBe(beforeVersion + 1n);
    expect(Buffer.from(new Uint8Array(registryAfter.ownerTreeRoot)).equals(
      Buffer.from(bullRegistryTracker.buildRegistry().rootNode.hash),
    )).toBe(true);

    // Owner A remains with exactly Bull #2.
    const ownerBullsAfter = bullRegistryTracker.getBulls(playerA.publicKey);
    expect(ownerBullsAfter.length).toBe(1);
    expect(ownerBullsAfter[0].position.equals(position2)).toBe(true);
    expect(ownerBullsAfter[0].buckPower).toBe(pos2.buckPower);

    // Bull #1 must be absent.
    expect(bullRegistryTracker.hasBull(playerA.publicKey, position1)).toBe(false);

    // Bull #2 position unchanged.
    const pos2After = await rodeoAccounts(rodeoCoreProgram).position.fetch(position2);
    expect(pos2After.positionId.toString()).toBe(pos2.positionId.toString());
    expect(pos2After.owner.equals(playerA.publicKey)).toBe(true);
    expect(pos2After.buckPower).toBe(pos2.buckPower);
    expect(pos2After.revealConfigVersion.toString()).toBe(pos2.revealConfigVersion.toString());
    expect(pos2After.role.bull).toBeTruthy();

    // Bull #2 receipt unchanged.
    const receiptInfo2After = await provider.connection.getAccountInfo(receiptAsset2);
    expect(receiptInfo2After).not.toBeNull();
    expect(receiptInfo2After!.owner.equals(receipt2OwnerBefore)).toBe(true);
    expect(receiptInfo2After!.data.length).toBe(receipt2DataLenBefore);

    // Bull #1 full exit lifecycle.
    const [pendingRandomness1] = deriveRandomness(
      rodeoCoreProgram.programId,
      position1,
      1,
      actionNonce1,
    );
    expect(await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position1)).toBeNull();
    expect(await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(pendingRandomness1)).toBeNull();

    const [receiptAsset1] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position1.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptInfo1After = await provider.connection.getAccountInfo(receiptAsset1);
    expect(receiptInfo1After).not.toBeNull();
    expect(receiptInfo1After!.owner.equals(MPL_CORE_PROGRAM_ID)).toBe(true);
    expect(receiptInfo1After!.data.length).toBe(1);
    expect(receiptInfo1After!.data[0]).toBe(0);

    // Buffer closed and prover refunded.
    const bufferInfoAfter = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfoAfter === null || bufferInfoAfter.lamports === 0).toBe(true);
    const proverBalanceAfterSettle = await getLamportBalance(provider, proverA.publicKey);
    expect(proverBalanceAfterSettle).toBe(proverBalanceBeforeSettle + bufferLamportsBefore);

    // RODEO 5/95 and ANSEM immunity.
    const returned = stakeAmountAtomic.muln(9_500).divn(10_000);
    const burned = stakeAmountAtomic.sub(returned);
    const playerRodeoAfter = await getAccount(provider.connection, playerARodeoAccount);
    const principalVaultAfter = await getAccount(provider.connection, principalVault);
    const rodeoMintInfoAfter = await getMint(provider.connection, rodeoMint);
    const playerAnsemAfter = await getAccount(provider.connection, playerAAnsemAccount);
    const rewardVaultAfter = await getAccount(provider.connection, rewardVault);

    expect(new BN(playerRodeoAfter.amount.toString()).toString()).toBe(
      new BN(playerRodeoBefore.amount.toString()).add(returned).toString(),
    );
    expect(new BN(principalVaultAfter.amount.toString()).toString()).toBe(
      new BN(principalVaultBefore.amount.toString()).sub(stakeAmountAtomic).toString(),
    );
    expect(new BN(rodeoMintInfoAfter.supply.toString()).toString()).toBe(
      new BN(rodeoMintInfoBefore.supply.toString()).sub(burned).toString(),
    );
    expect(new BN(playerAnsemAfter.amount.toString()).toString()).toBe(
      new BN(playerAnsemBefore.amount.toString()).add(claimable).toString(),
    );
    expect(new BN(rewardVaultAfter.amount.toString()).toString()).toBe(
      new BN(rewardVaultBefore.amount.toString()).sub(claimable).toString(),
    );

    // Replay rejected.
    await expect(
      settleUnstake(positionId1, actionNonce1, payer, {
        bufferPda: staged.bufferPda,
        refundRecipient: staged.refundRecipient,
      }, {
        ownerRodeoAccount: playerARodeoAccount,
        ownerAnsemAccount: playerAAnsemAccount,
      }),
    ).rejects.toThrow();
  }, 240_000);

  it("production Bull unstake: stale current proof rejected after another Bull registry mutation, then fresh current proof succeeds", async () => {
    // Player A owns Bull #1; prover A stages the proof.
    // Player B owns Bull #2 to mutate the registry between staging and settlement.
    const playerA = web3.Keypair.generate();
    const proverA = web3.Keypair.generate();
    const playerB = web3.Keypair.generate();
    const proverB = web3.Keypair.generate();

    await provider.sendAndConfirm(
      new web3.Transaction().add(
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: playerA.publicKey, lamports: 1_000_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: proverA.publicKey, lamports: 100_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: playerB.publicKey, lamports: 1_000_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: proverB.publicKey, lamports: 100_000_000 }),
      ),
      [payer],
    );

    // A stakes and reveals Bull #1.
    const { positionId: positionIdA, position: positionA } = await findBullPosition();
    const playerARodeoAccount = await createAssociatedTokenAccount(provider.connection, payer, rodeoMint, playerA.publicKey);
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerARodeoAccount, payer.publicKey, 100_000_000_000n),
      ),
      [payer],
    );
    await stakeAndCommit(positionIdA, stakeAmountAtomic, playerARodeoAccount, playerA);
    await revealBullWithProof(positionIdA, playerA, proverA);

    // Make A's Bull unstake-eligible and request Unstake.
    const posA = await rodeoAccounts(rodeoCoreProgram).position.fetch(positionA);
    await fixturePreparePosition(positionIdA, {
      roleCode: 2,
      cowboyKindCode: 0,
      accrualWeight: posA.accrualWeight,
      buckPower: posA.buckPower,
      claimable: new BN(0),
      positionClaimableLiabilityDelta: new BN(0),
    });
    const { actionNonce: actionNonceA } = await requestUnstake(positionIdA, playerA);

    // Stage a removal proof against the current registry (R1 / V1).
    const { staged: staleStaged } = await buildAndStageUnstakeProof(
      positionIdA,
      actionNonceA,
      playerA,
      proverA,
      new BN(2),
    );

    // B stakes and reveals Bull #2, moving the registry to R2 / V2.
    const { positionId: positionIdB, position: positionB } = await findBullPosition();
    const playerBRodeoAccount = await createAssociatedTokenAccount(provider.connection, payer, rodeoMint, playerB.publicKey);
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerBRodeoAccount, payer.publicKey, 100_000_000_000n),
      ),
      [payer],
    );
    await stakeAndCommit(positionIdB, stakeAmountAtomic, playerBRodeoAccount, playerB);
    await revealBullWithProof(positionIdB, playerB, proverB);

    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const staleRegistryBefore = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const staleBeforeCount = BigInt(staleRegistryBefore.totalBullCount.toString());
    const staleBeforePower = BigInt(staleRegistryBefore.totalBuckPower.toString());
    const staleBeforeVersion = BigInt(staleRegistryBefore.registryVersion.toString());
    expect(staleBeforeCount).toBeGreaterThan(1n);
    expect(staleBeforePower).toBeGreaterThan(0n);

    const playerAAnsemAccount = await createAssociatedTokenAccount(provider.connection, payer, ansemMint, playerA.publicKey);

    // Settlement with the stale R1 proof must fail because the current registry is now R2.
    await expect(
      settleUnstake(positionIdA, actionNonceA, payer, {
        bufferPda: staleStaged.bufferPda,
        refundRecipient: staleStaged.refundRecipient,
      }, {
        ownerRodeoAccount: playerARodeoAccount,
        ownerAnsemAccount: playerAAnsemAccount,
      }),
    ).rejects.toThrow();

    // Build and stage a FRESH removal proof for A's SAME pending Unstake action
    // against the CURRENT registry (R2 / V2).
    const { staged: freshStaged } = await buildAndStageUnstakeProof(
      positionIdA,
      actionNonceA,
      playerA,
      proverA,
      new BN(3),
    );

    // Settlement with the fresh CURRENT proof must succeed.
    await settleUnstake(positionIdA, actionNonceA, payer, {
      bufferPda: freshStaged.bufferPda,
      refundRecipient: freshStaged.refundRecipient,
    }, {
      ownerRodeoAccount: playerARodeoAccount,
      ownerAnsemAccount: playerAAnsemAccount,
    });

    // Bull #1 is removed; Bull #2 remains.
    bullRegistryTracker.unregisterBull(playerA.publicKey, positionA);
    await assertTrackerMatchesChain();

    const registryAfter = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfter.totalBullCount.toString())).toBe(staleBeforeCount - 1n);
    expect(BigInt(registryAfter.registryVersion.toString())).toBe(staleBeforeVersion + 1n);
    expect(BigInt(registryAfter.totalBuckPower.toString())).toBe(
      staleBeforePower - BigInt(posA.buckPower.toString()),
    );
    expect(Buffer.from(new Uint8Array(registryAfter.ownerTreeRoot)).equals(
      Buffer.from(bullRegistryTracker.buildRegistry().rootNode.hash),
    )).toBe(true);

    // A's position and pending randomness are closed.
    const [pendingRandomnessA] = deriveRandomness(
      rodeoCoreProgram.programId,
      positionA,
      1,
      actionNonceA,
    );
    expect(await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(positionA)).toBeNull();
    expect(await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(pendingRandomnessA)).toBeNull();

    // A's receipt is burned to the MPL Core tombstone.
    const [receiptAssetA] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), positionA.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptInfoA = await provider.connection.getAccountInfo(receiptAssetA);
    expect(receiptInfoA).not.toBeNull();
    expect(receiptInfoA!.owner.equals(MPL_CORE_PROGRAM_ID)).toBe(true);
    expect(receiptInfoA!.data.length).toBe(1);
    expect(receiptInfoA!.data[0]).toBe(0);

    // B's position and receipt remain active.
    const posB = await rodeoAccounts(rodeoCoreProgram).position.fetch(positionB);
    expect(posB.owner.equals(playerB.publicKey)).toBe(true);
    expect(posB.role.bull).toBeTruthy();

    // The stale proof buffer was not consumed; the fresh one was consumed and closed.
    const staleBufferInfo = await provider.connection.getAccountInfo(staleStaged.bufferPda);
    expect(staleBufferInfo).not.toBeNull();
    const staleBufferAccount = await rodeoAccounts(rodeoCoreProgram).bullProofBuffer.fetch(staleStaged.bufferPda);
    expect(staleBufferAccount.consumed).toBe(false);
    expect(staleBufferAccount.finalized).toBe(true);

    const freshBufferInfo = await provider.connection.getAccountInfo(freshStaged.bufferPda);
    expect(freshBufferInfo === null || freshBufferInfo.lamports === 0).toBe(true);
  }, 240_000);

  it("production Bull unstake: fresh current proof succeeds after another Bull registry mutation", async () => {
    // Player A owns Bull #1 and requests Unstake.
    // Player B then reveals Bull #2, so A's proof must be built against R2/V2.
    const playerA = web3.Keypair.generate();
    const proverA = web3.Keypair.generate();
    const playerB = web3.Keypair.generate();
    const proverB = web3.Keypair.generate();

    await provider.sendAndConfirm(
      new web3.Transaction().add(
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: playerA.publicKey, lamports: 1_000_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: proverA.publicKey, lamports: 100_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: playerB.publicKey, lamports: 1_000_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: proverB.publicKey, lamports: 100_000_000 }),
      ),
      [payer],
    );

    const { positionId: positionIdA, position: positionA } = await findBullPosition();
    const playerARodeoAccount = await createAssociatedTokenAccount(provider.connection, payer, rodeoMint, playerA.publicKey);
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerARodeoAccount, payer.publicKey, 100_000_000_000n),
      ),
      [payer],
    );
    await stakeAndCommit(positionIdA, stakeAmountAtomic, playerARodeoAccount, playerA);
    await revealBullWithProof(positionIdA, playerA, proverA);

    const posA = await rodeoAccounts(rodeoCoreProgram).position.fetch(positionA);
    await fixturePreparePosition(positionIdA, {
      roleCode: 2,
      cowboyKindCode: 0,
      accrualWeight: posA.accrualWeight,
      buckPower: posA.buckPower,
      claimable: new BN(0),
      positionClaimableLiabilityDelta: new BN(0),
    });
    const { actionNonce: actionNonceA } = await requestUnstake(positionIdA, playerA);

    // B reveals Bull #2 while A's Unstake is still pending.
    const { positionId: positionIdB, position: positionB } = await findBullPosition();
    const playerBRodeoAccount = await createAssociatedTokenAccount(provider.connection, payer, rodeoMint, playerB.publicKey);
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerBRodeoAccount, payer.publicKey, 100_000_000_000n),
      ),
      [payer],
    );
    await stakeAndCommit(positionIdB, stakeAmountAtomic, playerBRodeoAccount, playerB);
    await revealBullWithProof(positionIdB, playerB, proverB);

    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const freshRegistryBefore = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const unstakeBeforeCount = BigInt(freshRegistryBefore.totalBullCount.toString());
    const unstakeBeforePower = BigInt(freshRegistryBefore.totalBuckPower.toString());
    const unstakeBeforeVersion = BigInt(freshRegistryBefore.registryVersion.toString());
    expect(unstakeBeforeCount).toBeGreaterThan(0n);
    expect(unstakeBeforePower).toBeGreaterThan(0n);

    const playerAAnsemAccount = await createAssociatedTokenAccount(provider.connection, payer, ansemMint, playerA.publicKey);

    // Build and stage a fresh CURRENT removal proof for A's SAME pending action.
    const { staged: freshStaged } = await buildAndStageUnstakeProof(
      positionIdA,
      actionNonceA,
      playerA,
      proverA,
      new BN(2),
    );

    await settleUnstake(positionIdA, actionNonceA, payer, {
      bufferPda: freshStaged.bufferPda,
      refundRecipient: freshStaged.refundRecipient,
    }, {
      ownerRodeoAccount: playerARodeoAccount,
      ownerAnsemAccount: playerAAnsemAccount,
    });

    bullRegistryTracker.unregisterBull(playerA.publicKey, positionA);
    await assertTrackerMatchesChain();

    const registryAfter = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfter.totalBullCount.toString())).toBe(unstakeBeforeCount - 1n);
    expect(BigInt(registryAfter.registryVersion.toString())).toBe(unstakeBeforeVersion + 1n);
    expect(BigInt(registryAfter.totalBuckPower.toString())).toBe(
      unstakeBeforePower - BigInt(posA.buckPower.toString()),
    );
    expect(Buffer.from(new Uint8Array(registryAfter.ownerTreeRoot)).equals(
      Buffer.from(bullRegistryTracker.buildRegistry().rootNode.hash),
    )).toBe(true);

    const [pendingRandomnessA] = deriveRandomness(
      rodeoCoreProgram.programId,
      positionA,
      1,
      actionNonceA,
    );
    expect(await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(positionA)).toBeNull();
    expect(await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetchNullable(pendingRandomnessA)).toBeNull();

    const posB = await rodeoAccounts(rodeoCoreProgram).position.fetch(positionB);
    expect(posB.owner.equals(playerB.publicKey)).toBe(true);
    expect(posB.role.bull).toBeTruthy();
  }, 240_000);


  it("BullProofBuffer atomic rollback on late receipt-burn failure during Bull unstake", async () => {
    // Independent player A and prover B.
    const player = web3.Keypair.generate();
    const prover = web3.Keypair.generate();

    await provider.sendAndConfirm(
      new web3.Transaction().add(
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: player.publicKey, lamports: 1_500_000_000 }),
        web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: prover.publicKey, lamports: 100_000_000 }),
      ),
      [payer],
    );

    const { positionId, position } = await findBullPosition();
    const playerRodeoAccount = await createAssociatedTokenAccount(provider.connection, payer, rodeoMint, player.publicKey);
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerRodeoAccount, payer.publicKey, 100_000_000_000n),
      ),
      [payer],
    );
    await stakeAndCommit(positionId, stakeAmountAtomic, playerRodeoAccount, player);
    await revealBullWithProof(positionId, player, prover);

    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const claimable = new BN(1_000_000_000);
    await fixturePreparePosition(positionId, {
      roleCode: 2,
      cowboyKindCode: 0,
      accrualWeight: pos.accrualWeight,
      buckPower: pos.buckPower,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });
    await ensureRecognizedReserve(claimable);

    const { actionNonce } = await requestUnstake(positionId, player);

    const playerAnsemAccount = await createAssociatedTokenAccount(provider.connection, payer, ansemMint, player.publicKey);

    const { staged, bufferLamportsBefore } = await buildAndStageUnstakeProof(
      positionId,
      actionNonce,
      player,
      prover,
      new BN(2),
    );

    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const registryBefore = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const beforeCount = BigInt(registryBefore.totalBullCount.toString());
    const beforePower = BigInt(registryBefore.totalBuckPower.toString());
    const beforeVersion = BigInt(registryBefore.registryVersion.toString());
    const beforeRoot = Buffer.from(new Uint8Array(registryBefore.ownerTreeRoot));

    const positionBefore = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const bufferInfoBefore = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfoBefore).not.toBeNull();
    const bufferAccountBefore = await rodeoAccounts(rodeoCoreProgram).bullProofBuffer.fetch(staged.bufferPda);
    expect(bufferAccountBefore.consumed).toBe(false);
    expect(bufferAccountBefore.finalized).toBe(true);

    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptFunderBefore = await provider.connection.getAccountInfo(receiptFunder);
    expect(receiptFunderBefore).not.toBeNull();

    const proverBalanceBefore = await getLamportBalance(provider, prover.publicKey);
    const playerRodeoBefore = await getAccount(provider.connection, playerRodeoAccount);
    const principalVaultBefore = await getAccount(provider.connection, principalVault);
    const rodeoMintInfoBefore = await getMint(provider.connection, rodeoMint);
    const playerAnsemBefore = await getAccount(provider.connection, playerAnsemAccount);
    const rewardVaultBefore = await getAccount(provider.connection, rewardVault);

    // Record the real ReceiptFunder lamports before we force a late failure.
    const receiptFunderLamportsBefore = receiptFunderBefore!.lamports;

    // Force a late downstream failure by supplying an invalid receipt_funder
    // account. The proof and economic logic are valid, but burn_position_receipt
    // validates the funder PDA and will reject the wrong key.
    await expect(
      settleUnstake(positionId, actionNonce, payer, {
        bufferPda: staged.bufferPda,
        refundRecipient: staged.refundRecipient,
        receiptFunder: payer.publicKey,
      }, {
        ownerRodeoAccount: playerRodeoAccount,
        ownerAnsemAccount: playerAnsemAccount,
      }),
    ).rejects.toThrow();

    // Full rollback assertions.
    const bufferInfoAfterFailure = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfoAfterFailure).not.toBeNull();
    expect(bufferInfoAfterFailure!.lamports).toBe(bufferLamportsBefore);
    expect(bufferInfoAfterFailure!.data.length).toBe(bufferInfoBefore!.data.length);
    const bufferAccountAfterFailure = await rodeoAccounts(rodeoCoreProgram).bullProofBuffer.fetch(
      staged.bufferPda,
    );
    expect(bufferAccountAfterFailure.consumed).toBe(false);
    expect(bufferAccountAfterFailure.finalized).toBe(true);
    expect(bufferAccountAfterFailure.refundRecipient.equals(prover.publicKey)).toBe(true);
    expect(bufferAccountAfterFailure.expectedPayloadLength).toBe(bufferAccountBefore.expectedPayloadLength);

    const registryAfterFailure = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfterFailure.totalBullCount.toString())).toBe(beforeCount);
    expect(BigInt(registryAfterFailure.totalBuckPower.toString())).toBe(beforePower);
    expect(BigInt(registryAfterFailure.registryVersion.toString())).toBe(beforeVersion);
    expect(Buffer.from(new Uint8Array(registryAfterFailure.ownerTreeRoot)).equals(beforeRoot)).toBe(true);

    const positionAfterFailure = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(positionAfterFailure.status).toEqual(positionBefore.status);
    expect(positionAfterFailure.pendingActionActive).toBe(positionBefore.pendingActionActive);
    expect(positionAfterFailure.role).toEqual(positionBefore.role);
    expect(positionAfterFailure.owner.equals(positionBefore.owner)).toBe(true);
    expect(positionAfterFailure.receiptAsset.toBase58()).toBe(positionBefore.receiptAsset.toBase58());

    const proverBalanceAfterFailure = await getLamportBalance(provider, prover.publicKey);
    expect(proverBalanceAfterFailure).toBe(proverBalanceBefore);

    const receiptFunderAfterFailure = await provider.connection.getAccountInfo(receiptFunder);
    expect(receiptFunderAfterFailure).not.toBeNull();
    expect(receiptFunderAfterFailure!.lamports).toBe(receiptFunderLamportsBefore);

    const playerRodeoAfterFailure = await getAccount(provider.connection, playerRodeoAccount);
    const principalVaultAfterFailure = await getAccount(provider.connection, principalVault);
    const rodeoMintInfoAfterFailure = await getMint(provider.connection, rodeoMint);
    const playerAnsemAfterFailure = await getAccount(provider.connection, playerAnsemAccount);
    const rewardVaultAfterFailure = await getAccount(provider.connection, rewardVault);

    expect(new BN(playerRodeoAfterFailure.amount.toString()).toString()).toBe(
      new BN(playerRodeoBefore.amount.toString()).toString(),
    );
    expect(new BN(principalVaultAfterFailure.amount.toString()).toString()).toBe(
      new BN(principalVaultBefore.amount.toString()).toString(),
    );
    expect(new BN(rodeoMintInfoAfterFailure.supply.toString()).toString()).toBe(
      new BN(rodeoMintInfoBefore.supply.toString()).toString(),
    );
    expect(new BN(playerAnsemAfterFailure.amount.toString()).toString()).toBe(
      new BN(playerAnsemBefore.amount.toString()).toString(),
    );
    expect(new BN(rewardVaultAfterFailure.amount.toString()).toString()).toBe(
      new BN(rewardVaultBefore.amount.toString()).toString(),
    );

    // Retry with the SAME valid BullProofBuffer and the correct funder PDA.
    await settleUnstake(positionId, actionNonce, payer, {
      bufferPda: staged.bufferPda,
      refundRecipient: staged.refundRecipient,
    }, {
      ownerRodeoAccount: playerRodeoAccount,
      ownerAnsemAccount: playerAnsemAccount,
    });

    // Post-success final assertions.
    const bufferInfoAfterSuccess = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfoAfterSuccess).toBeNull();

    const positionAfterSuccess = await rodeoAccounts(rodeoCoreProgram).position.fetchNullable(position);
    expect(positionAfterSuccess).toBeNull();

    bullRegistryTracker.unregisterBull(player.publicKey, position);
    await assertTrackerMatchesChain();

    const registryAfterSuccess = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfterSuccess.totalBullCount.toString())).toBe(beforeCount - 1n);
    expect(BigInt(registryAfterSuccess.registryVersion.toString())).toBe(beforeVersion + 1n);
    expect(BigInt(registryAfterSuccess.totalBuckPower.toString())).toBe(
      beforePower - BigInt(pos.buckPower),
    );
    expect(Buffer.from(new Uint8Array(registryAfterSuccess.ownerTreeRoot)).equals(
      Buffer.from(bullRegistryTracker.buildRegistry().rootNode.hash),
    )).toBe(true);

    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptInfoAfterSuccess = await provider.connection.getAccountInfo(receiptAsset);
    expect(receiptInfoAfterSuccess).not.toBeNull();
    expect(receiptInfoAfterSuccess!.owner.equals(MPL_CORE_PROGRAM_ID)).toBe(true);
    expect(receiptInfoAfterSuccess!.data.length).toBe(1);
    expect(receiptInfoAfterSuccess!.data[0]).toBe(0);

    const proverBalanceAfterSuccess = await getLamportBalance(provider, prover.publicKey);
    expect(proverBalanceAfterSuccess).toBe(proverBalanceBefore + bufferLamportsBefore);
  }, 240_000);

  it("BullProofBuffer atomic rollback on late CreateV2 funder failure", async () => {
    // Independent player A and prover B.
    const player = web3.Keypair.generate();
    const prover = web3.Keypair.generate();

    // Fund both wallets.
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: player.publicKey,
          lamports: 1_000_000_000,
        }),
        web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: prover.publicKey,
          lamports: 100_000_000,
        }),
      ),
      [payer],
    );

    const playerRodeoAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      rodeoMint,
      player.publicKey,
    );
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        createTransferInstruction(payerRodeoAccount, playerRodeoAccount, payer.publicKey, 100_000_000_000n),
      ),
      [payer],
    );

    // Pre-failure registry/tracker parity.
    const [registryPda] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);
    const registryBefore = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    const beforeRoot = new Uint8Array(registryBefore.ownerTreeRoot);
    const beforeCount = BigInt(registryBefore.totalBullCount.toString());
    const beforePower = BigInt(registryBefore.totalBuckPower.toString());
    const beforeVersion = BigInt(registryBefore.registryVersion.toString());
    await syncTrackerWithChain();

    // Find a fresh Bull position and stake it.
    const { positionId, position } = await findBullPosition();
    await stakeAndCommit(positionId, stakeAmountAtomic, playerRodeoAccount, player);

    const { pendingRandomness } = await deriveStakeAccounts(positionId);

    // Build and stage a valid real Bull proof buffer.  We do NOT call the helper
    // that also settles, because the rollback test needs to inspect pre-failure
    // state and then intentionally break the downstream CreateV2 payer.
    await syncTrackerWithChain();
    const bullLeaf: BullLeaf = {
      position,
      positionId: BigInt(positionId.toString()),
      owner: player.publicKey,
      buckPower: 0,
      revealConfigVersion: 1n,
    };
    const staged = await stageRevealProofForBull(
      rodeoCoreProgram,
      globalConfig,
      position,
      pendingRandomness,
      prover,
      new BN(1),
      bullRegistryTracker,
      bullLeaf,
    );

    // Capture pre-failure state explicitly.
    const positionBefore = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    const bufferInfoBefore = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfoBefore).not.toBeNull();
    const bufferAccountBefore = await rodeoAccounts(rodeoCoreProgram).bullProofBuffer.fetch(
      staged.bufferPda,
    );
    expect(bufferAccountBefore.consumed).toBe(false);
    expect(bufferAccountBefore.finalized).toBe(true);
    const proverBalanceBefore = await getLamportBalance(provider, prover.publicKey);
    const receiptFunder = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    )[0];

    // stakeAndCommit prefunds the ReceiptFunder with RECEIPT_RESERVE_LAMPORTS.
    // Close that PDA and recreate it with the bare rent-exempt minimum for 0 bytes.
    // This is a valid System-Program-owned PDA, but it cannot pay the MPL Core
    // asset rent in settle_reveal, causing a late CreateV2 CPI failure.
    await rodeoCoreProgram.methods
      .testFixtureCloseReceiptFunder()
      .accounts({
        authority: payer.publicKey,
        position,
        funder: receiptFunder,
        beneficiary: payer.publicKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const funderLamportsBeforeFailure = new BN(await provider.connection.getMinimumBalanceForRentExemption(0));
    await rodeoCoreProgram.methods
      .testFixtureCreateReceiptFunder(funderLamportsBeforeFailure)
      .accounts({
        authority: payer.publicKey,
        position,
        funder: receiptFunder,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const funderInfoBeforeFailure = await provider.connection.getAccountInfo(receiptFunder);
    expect(funderInfoBeforeFailure).not.toBeNull();
    expect(funderInfoBeforeFailure!.lamports).toBe(funderLamportsBeforeFailure.toNumber());
    expect(funderInfoBeforeFailure!.data.length).toBe(0);

    // Attempt the real production settle_reveal. It MUST fail because the
    // ReceiptFunder cannot pay MPL Core asset rent.
    await expect(
      settleReveal(positionId, player, {
        bufferPda: staged.bufferPda,
        refundRecipient: staged.refundRecipient,
      }),
    ).rejects.toThrow();

    // Full rollback assertions.
    const bufferInfoAfterFailure = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfoAfterFailure).not.toBeNull();
    expect(bufferInfoAfterFailure!.lamports).toBe(bufferInfoBefore!.lamports);
    expect(bufferInfoAfterFailure!.data.length).toBe(bufferInfoBefore!.data.length);
    const bufferAccountAfterFailure = await rodeoAccounts(rodeoCoreProgram).bullProofBuffer.fetch(
      staged.bufferPda,
    );
    expect(bufferAccountAfterFailure.consumed).toBe(false);
    expect(bufferAccountAfterFailure.finalized).toBe(true);
    expect(bufferAccountAfterFailure.refundRecipient.equals(prover.publicKey)).toBe(true);
    expect(bufferAccountAfterFailure.expectedPayloadLength).toBe(
      bufferAccountBefore.expectedPayloadLength,
    );

    const registryAfterFailure = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfterFailure.totalBullCount.toString())).toBe(beforeCount);
    expect(BigInt(registryAfterFailure.totalBuckPower.toString())).toBe(beforePower);
    expect(BigInt(registryAfterFailure.registryVersion.toString())).toBe(beforeVersion);
    expect(Buffer.from(new Uint8Array(registryAfterFailure.ownerTreeRoot)).equals(Buffer.from(beforeRoot))).toBe(true);

    const positionAfterFailure = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(positionAfterFailure.status).toEqual(positionBefore.status);
    expect(positionAfterFailure.pendingActionActive).toBe(positionBefore.pendingActionActive);
    expect(positionAfterFailure.role).toEqual(positionBefore.role);
    expect(positionAfterFailure.owner.equals(positionBefore.owner)).toBe(true);
    expect(positionAfterFailure.receiptAsset.equals(web3.PublicKey.default)).toBe(true);

    const proverBalanceAfterFailure = await getLamportBalance(provider, prover.publicKey);
    expect(proverBalanceAfterFailure).toBe(proverBalanceBefore);

    const receiptFunderAfterFailure = await provider.connection.getAccountInfo(receiptFunder);
    expect(receiptFunderAfterFailure).not.toBeNull();
    expect(receiptFunderAfterFailure!.lamports).toBe(funderLamportsBeforeFailure.toNumber());

    // Retry fix: fund the ReceiptFunder to the standard reserve so the same
    // valid BullProofBuffer can now pay the MPL Core CreateV2.
    const receiptFunderReserve = 5_500_000;
    await provider.sendAndConfirm(
      new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: receiptFunder,
          lamports: receiptFunderReserve,
        }),
      ),
      [payer],
    );

    // Retry with the SAME valid BullProofBuffer. It must now succeed.
    await settleReveal(positionId, player, {
      bufferPda: staged.bufferPda,
      refundRecipient: staged.refundRecipient,
    });

    // Post-success final assertions.
    const bufferInfoAfterSuccess = await provider.connection.getAccountInfo(staged.bufferPda);
    expect(bufferInfoAfterSuccess).toBeNull();

    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.role.bull).toBeTruthy();
    expect(pos.owner.equals(player.publicKey)).toBe(true);
    expect(pos.buckPower).toBeGreaterThan(0);

    const actualBull: BullLeaf = {
      position,
      positionId: BigInt(positionId.toString()),
      owner: player.publicKey,
      buckPower: pos.buckPower,
      revealConfigVersion: BigInt(pos.revealConfigVersion.toString()),
    };
    bullRegistryTracker.registerBull(player.publicKey, actualBull);

    const registryAfterSuccess = await rodeoAccounts(rodeoCoreProgram).bullRegistry.fetch(registryPda);
    expect(BigInt(registryAfterSuccess.totalBullCount.toString())).toBe(beforeCount + 1n);
    expect(BigInt(registryAfterSuccess.totalBuckPower.toString())).toBe(
      beforePower + BigInt(pos.buckPower),
    );
    expect(BigInt(registryAfterSuccess.registryVersion.toString())).toBe(beforeVersion + 1n);
    await assertTrackerMatchesChain();

    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const receiptInfoAfterSuccess = await provider.connection.getAccountInfo(receiptAsset);
    expect(receiptInfoAfterSuccess).not.toBeNull();
    expect(receiptInfoAfterSuccess!.owner.equals(MPL_CORE_PROGRAM_ID)).toBe(true);

    const proverBalanceAfterSuccess = await getLamportBalance(provider, prover.publicKey);
    expect(proverBalanceAfterSuccess).toBe(proverBalanceBefore + bufferInfoBefore!.lamports);

    console.log('BullProofBuffer rollback evidence:', {
      positionId: positionId.toString(),
      bufferPda: staged.bufferPda.toBase58(),
      bufferLamportsBefore: bufferInfoBefore!.lamports,
      bufferLamportsAfterFailure: bufferInfoAfterFailure!.lamports,
      bufferLamportsAfterSuccess: 0,
      funderLamportsBeforeFailure,
      proverBalanceBefore,
      proverBalanceAfterFailure,
      proverBalanceAfterSuccess,
      registryCountBefore: beforeCount.toString(),
      registryCountAfterFailure: registryAfterFailure.totalBullCount.toString(),
      registryCountAfterSuccess: registryAfterSuccess.totalBullCount.toString(),
    });
  }, 180_000);

});
