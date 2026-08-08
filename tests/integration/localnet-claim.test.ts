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
  getMint,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
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
const skipClaimSuite = !localnetAvailable || process.env.RODEO_TEST_SUITE === "epoch";

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
  const REWARD_PER_WEIGHT_SCALE = new BN("1000000000000000000");
  let nextPositionId = 1;

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
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    const globalConfigAccount = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      globalConfigAccount.currentConfigVersion,
    );
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
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([owner])
      .rpc();
    return { position, pendingRandomness, protocolConfig };
  }

  async function settleReveal(positionId: BN, settler = payer) {
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
    const pendingRandomnessAccount = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(
      pendingRandomness,
    );
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      pendingRandomnessAccount.configVersionSnapshot,
    );
    await rodeoCoreProgram.methods
      .settleReveal()
      .accounts({
        settler: settler.publicKey,
        globalConfig,
        globalGameState,
        rewardState,
        bullAccumulator,
        position,
        pendingRandomness,
        protocolConfig,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([settler])
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

    await stakeAndCommit(positionId);
    await settleReveal(positionId);
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

    for (let id = 1; id < nextPositionId; id++) {
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
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await settleReveal(positionId);
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
    await stakeAndCommit(positionId);
    await settleReveal(positionId);
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
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(nextPositionId++);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      const role = expectedRevealRole(position);
      if (role !== "cowboy") continue;
      const cowboyKind = expectedCowboyKind(position);
      const stolen = expectedUnstakeTheftFlag(position, new BN(1), new BN(0));
      if (predicate(positionId, position, role, cowboyKind, stolen)) {
        return { positionId, position, role, cowboyKind, stolen };
      }
    }
    throw new Error("Could not find a matching unstake position");
  }

  async function findBullPosition(maxAttempts = 100): Promise<{ positionId: BN; position: web3.PublicKey }> {
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(nextPositionId++);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      if (expectedRevealRole(position) === "bull") {
        return { positionId, position };
      }
    }
    throw new Error("Could not find a Bull position");
  }

  async function findCowboyPosition(
    cowboyKindCode = 5,
    maxAttempts = 10000,
  ): Promise<{ positionId: BN; position: web3.PublicKey }> {
    const desiredKind =
      cowboyKindCode === 254 ? "desperado" : `rank${cowboyKindCode}`;
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(nextPositionId++);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      if (expectedRevealRole(position) !== "cowboy") continue;
      if (expectedCowboyKind(position) === desiredKind) {
        return { positionId, position };
      }
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
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([owner])
      .rpc();
    return { position, pendingRandomness, actionNonce };
  }

  async function settleUnstake(positionId: BN, actionNonce: BN, settler = payer) {
    const { position } = await deriveStakeAccounts(positionId);
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
    await rodeoCoreProgram.methods
      .settleUnstake()
      .accounts({
        settler: settler.publicKey,
        globalConfig,
        globalGameState,
        rewardState,
        bullAccumulator,
        position,
        pendingRandomness,
        protocolConfig,
        principalVault,
        rodeoMint,
        ownerRodeoAccount: payerRodeoAccount,
        rewardVault,
        ownerAnsemAccount: payerAnsemAccount,
        owner: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([settler])
      .rpc();
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

  function findV1SafeV2StolenCowboy(maxAttempts = 2000): {
    positionId: BN;
    position: web3.PublicKey;
    randomOutput: Uint8Array;
  } {
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(nextPositionId++);
      const [position] = derivePosition(
        rodeoCoreProgram.programId,
        globalConfig,
        positionId,
      );
      const role = expectedRevealRole(position, PROTOCOL_CONFIG_V1);
      if (role !== "cowboy") continue;
      const cowboyKind = expectedCowboyKind(position, PROTOCOL_CONFIG_V1);
      if (cowboyKind === "desperado") continue;
      const v1Stolen = expectedUnstakeTheftFlag(
        position,
        new BN(1),
        new BN(0),
        PROTOCOL_CONFIG_V1,
      );
      if (v1Stolen) continue;
      const v2Stolen = expectedUnstakeTheftFlag(
        position,
        new BN(1),
        new BN(0),
        PROTOCOL_CONFIG_V2,
      );
      if (!v2Stolen) continue;
      const randomOutput = deriveMockCommitment(position, 1, new BN(1), new BN(0));
      return { positionId, position, randomOutput };
    }
    throw new Error("Could not find a V1-safe / V2-stolen Cowboy position");
  }

  function findV2StolenCowboy(maxAttempts = 1000): {
    positionId: BN;
    position: web3.PublicKey;
  } {
    for (let i = 0; i < maxAttempts; i++) {
      const positionId = new BN(nextPositionId++);
      const [position] = derivePosition(
        rodeoCoreProgram.programId,
        globalConfig,
        positionId,
      );
      const role = expectedRevealRole(position, PROTOCOL_CONFIG_V2);
      if (role !== "cowboy") continue;
      const cowboyKind = expectedCowboyKind(position, PROTOCOL_CONFIG_V2);
      if (cowboyKind === "desperado") continue;
      const stolen = expectedUnstakeTheftFlag(
        position,
        new BN(1),
        new BN(0),
        PROTOCOL_CONFIG_V2,
      );
      if (stolen) return { positionId, position };
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
      findV1SafeV2StolenCowboy();
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

    const { positionId: positionBId, position: positionB } = findV2StolenCowboy();
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

});

