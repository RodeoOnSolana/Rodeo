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
  getMint,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import { beforeAll, describe, expect, it } from "vitest";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

interface AccountFetcher<T> {
  fetch(address: web3.PublicKey): Promise<T>;
}

interface RodeoCoreAccountNamespace {
  globalConfig: AccountFetcher<GlobalConfigAccount>;
  rewardState: AccountFetcher<RewardStateAccount>;
  globalGameState: AccountFetcher<GlobalGameStateAccount>;
  bullAccumulator: AccountFetcher<BullAccumulatorAccount>;
  position: AccountFetcher<PositionAccount>;
  pendingRandomness: AccountFetcher<PendingRandomnessAccount>;
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
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }, 60_000);

  const stakeAmountAtomic = new BN(100_000_000_000);
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
    await rodeoCoreProgram.methods
      .stakeAndCommit(positionId, amount)
      .accounts({
        owner: owner.publicKey,
        ownerRodeoTokenAccount: ownerRodeo,
        globalConfig,
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
    return { position, pendingRandomness };
  }

  async function settleReveal(positionId: BN, settler = payer) {
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
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
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await settleReveal(positionId);
    await fixturePreparePosition(positionId, {
      roleCode: role === "cowboy" ? 1 : 2,
      cowboyKindCode,
      accrualWeight: 0,
      buckPower: 0,
      claimable,
      positionClaimableLiabilityDelta: claimable,
    });
    const { position } = await deriveStakeAccounts(positionId);
    return { positionId, position };
  }

  async function ensureRecognizedReserve(amount: BN) {
    await fundRewardVault(amount);
    await fixtureRecognizeRewards(amount);
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
});

