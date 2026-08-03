import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { beforeAll, describe, expect, it } from "vitest";

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

describe.skipIf(!localnetAvailable)("Anchor localnet workspace", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  const programs = {} as Record<keyof typeof expectedProgramIds, Program>;

  let rodeoMint: web3.PublicKey;
  let ansemMint: web3.PublicKey;
  let globalConfig: web3.PublicKey;
  let rewardState: web3.PublicKey;
  let globalGameState: web3.PublicKey;
  let bullAccumulator: web3.PublicKey;
  let principalVault: web3.PublicKey;
  let rewardVault: web3.PublicKey;
  let payerRodeoAccount: web3.PublicKey;

  function derivePosition(positionId: BN): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), globalConfig.toBuffer(), positionId.toArrayLike(Buffer, "le", 8)],
      programs.RodeoCore.programId,
    );
  }

  function deriveRandomness(
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
      programs.RodeoCore.programId,
    );
  }

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);
    payer = (provider.wallet as unknown as { payer: web3.Keypair }).payer;

    programs.RodeoCore = new Program(loadIdl("rodeo_core"), provider);
    programs.RodeoMarket = new Program(loadIdl("rodeo_market"), provider);
    programs.RodeoRouter = new Program(loadIdl("rodeo_router"), provider);

    if (!localnetAvailable) return;

    rodeoMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    ansemMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

    [globalConfig] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      programs.RodeoCore.programId,
    );
    [principalVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("principal-vault")],
      programs.RodeoCore.programId,
    );
    [rewardVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-vault")],
      programs.RodeoCore.programId,
    );
    [rewardState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-state"), globalConfig.toBuffer()],
      programs.RodeoCore.programId,
    );
    [globalGameState] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-game-state"), globalConfig.toBuffer()],
      programs.RodeoCore.programId,
    );
    [bullAccumulator] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bull-accumulator"), globalConfig.toBuffer()],
      programs.RodeoCore.programId,
    );

    payerRodeoAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      rodeoMint,
      payer.publicKey,
    );

    // The protocol requires the full RODEO supply to be minted at initialization.
    const expectedTotalSupply = 1_000_000_000_000_000n;
    await mintTo(provider.connection, payer, rodeoMint, payerRodeoAccount, payer, expectedTotalSupply);

    await programs.RodeoCore.methods
      .initializeProtocol(payer.publicKey, payer.publicKey, payer.publicKey)
      .accounts({
        payer: payer.publicKey,
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
    for (const [name, expectedId] of Object.entries(expectedProgramIds)) {
      const program = programs[name as keyof typeof expectedProgramIds];
      expect(program.programId.toBase58()).toBe(expectedId);
      expect(await provider.connection.getAccountInfo(program.programId)).not.toBeNull();
    }
  }, 30_000);

  it("initializes GlobalConfig with computed atomic values and governance addresses", async () => {
    const fetcher = programs.RodeoCore.account as unknown as {
      globalConfig: { fetch(address: web3.PublicKey): Promise<any> };
    };
    const config = await fetcher.globalConfig.fetch(globalConfig);

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
    expect(config.upgradeCouncil.toBase58()).toBe(payer.publicKey.toBase58());
    expect(config.treasuryCouncil.toBase58()).toBe(payer.publicKey.toBase58());
    expect(config.emergencyGuardians.toBase58()).toBe(payer.publicKey.toBase58());
  }, 30_000);

  it("initializes RewardState with zeroed liabilities, indices, and counters", async () => {
    const fetcher = programs.RodeoCore.account as unknown as {
      rewardState: { fetch(address: web3.PublicKey): Promise<any> };
    };
    const state = await fetcher.rewardState.fetch(rewardState);

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

  it("initializes GlobalGameState with zeroed population and principal counters", async () => {
    const fetcher = programs.RodeoCore.account as unknown as {
      globalGameState: { fetch(address: web3.PublicKey): Promise<any> };
    };
    const state = await fetcher.globalGameState.fetch(globalGameState);

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
    const fetcher = programs.RodeoCore.account as unknown as {
      bullAccumulator: { fetch(address: web3.PublicKey): Promise<any> };
    };
    const acc = await fetcher.bullAccumulator.fetch(bullAccumulator);

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
      programs.RodeoCore.methods
        .initializeProtocol(payer.publicKey, payer.publicKey, payer.publicKey)
        .accounts({
          payer: payer.publicKey,
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
    const [position] = derivePosition(positionId);
    const [randomness] = deriveRandomness(position, 0, new BN(0));

    expect(position.toBase58()).toBe(
      web3.PublicKey.findProgramAddressSync(
        [Buffer.from("position"), globalConfig.toBuffer(), positionId.toArrayLike(Buffer, "le", 8)],
        programs.RodeoCore.programId,
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
        programs.RodeoCore.programId,
      )[0].toBase58(),
    );
  }, 30_000);
});
