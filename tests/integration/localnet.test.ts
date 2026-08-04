import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
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

describe.skipIf(!localnetAvailable)("Anchor localnet workspace", () => {
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

    // The protocol requires the full RODEO supply to be minted before initialization.
    const expectedTotalSupply = 1_000_000_000_000_000n;
    await mintTo(provider.connection, payer, rodeoMint, payerRodeoAccount, payer, expectedTotalSupply);
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

  it("deploys all program boundaries under the pinned IDs", async () => {
    const allPrograms = { ...otherPrograms, RodeoCore: rodeoCoreProgram };
    for (const [name, expectedId] of Object.entries(expectedProgramIds)) {
      const program = allPrograms[name as keyof typeof allPrograms];
      expect(program.programId.toBase58()).toBe(expectedId);
      expect(await provider.connection.getAccountInfo(program.programId)).not.toBeNull();
    }
  }, 30_000);

  it("exports only the Phase 2B instructions and referenced ABI entries", async () => {
    const idl = loadIdl("rodeo_core");
    const instructionNames = idl.instructions?.map((ix: { name: string }) => ix.name) ?? [];
    const accountNames = new Set(idl.accounts?.map((account: { name: string }) => account.name));

    expect(instructionNames.sort()).toEqual(
      [
        "initialize_protocol",
        "set_pause_flags",
        "stake_and_commit",
        "settle_reveal",
        "recover_reveal_timeout",
      ].sort(),
    );
    expect(instructionNames).not.toContain("ensure_idl_accounts");

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
      "Position",
      "PendingRandomness",
    ];
    expect([...accountNames].sort()).toEqual(expectedAccounts.sort());
    expect(accountNames).not.toContain("WalletClaimCooldown");
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
    expect(sdkSource).not.toContain("ensure_idl_accounts");
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
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
    ).rejects.toThrow();
  }, 30_000);

  it("initializes GlobalConfig with computed atomic values and governance addresses", async () => {
    const config = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);

    expect(config.version).toBe(1);
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

  it("starts the first protocol epoch after the 12-hour pot-fill period", async () => {
    const config = await rodeoAccounts(rodeoCoreProgram).globalConfig.fetch(globalConfig);
    const state = await rodeoAccounts(rodeoCoreProgram).rewardState.fetch(rewardState);

    expect(state.epochStartedAt.toString()).toBe(
      config.launchTimestamp.addn(12 * 60 * 60).toString(),
    );
    expect(state.lastClosedEpochTimestamp.toString()).toBe(state.epochStartedAt.toString());
  }, 30_000);

  it("initializes GlobalGameState with zeroed population and principal counters", async () => {
    const state = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    expect(state.version).toBe(3);
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

  async function recoverRevealTimeout(positionId: BN, caller = payer) {
    const { position, pendingRandomness } = await deriveStakeAccounts(positionId);
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
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([caller])
      .rpc();
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

    const pending = await rodeoAccounts(rodeoCoreProgram).pendingRandomness.fetch(
      deriveRandomness(rodeoCoreProgram.programId, position, 0, new BN(0))[0],
    );
    expect(pending.settled).toBe(true);

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
    await expect(
      rodeoCoreProgram.methods
        .settleReveal()
        .accounts({
          settler: payer.publicKey,
          globalConfig,
          globalGameState,
          rewardState,
          bullAccumulator,
          position,
          pendingRandomness: wrongRandomness,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
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

  it("does not create a receipt asset or emit ReceiptCreated", async () => {
    const positionId = new BN(nextPositionId++);
    const { position } = await stakeAndCommit(positionId);
    await settleReveal(positionId);
    const pos = await rodeoAccounts(rodeoCoreProgram).position.fetch(position);
    expect(pos.receiptAsset.toBase58()).toBe(web3.PublicKey.default.toBase58());
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
    await rodeoCoreProgram.methods
      .setPauseFlags(pauseNewStakes, pauseNewRevealRequests, false, false)
      .accounts({
        authority: emergencyGuardians.publicKey,
        globalConfig,
      })
      .signers([emergencyGuardians])
      .rpc();
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

    const vaultBefore = await getAccount(provider.connection, principalVault);
    const ownerBefore = await getAccount(provider.connection, payerRodeoAccount);
    const gameBefore = await rodeoAccounts(rodeoCoreProgram).globalGameState.fetch(globalGameState);

    // The test build uses a short randomness timeout for local verification.
    await new Promise((r) => setTimeout(r, 2_500));
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
  }, 60_000);

  it("cannot recover a reveal timeout after settlement", async () => {
    const positionId = new BN(nextPositionId++);
    await stakeAndCommit(positionId);
    await settleReveal(positionId);
    await expect(recoverRevealTimeout(positionId)).rejects.toThrow();
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
    return {
      globalConfig,
      principalVault,
      rewardVault,
      rewardState,
      globalGameState,
      bullAccumulator,
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
