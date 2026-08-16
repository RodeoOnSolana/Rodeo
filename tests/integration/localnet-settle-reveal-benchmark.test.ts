import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import { beforeAll, describe, expect, it } from "vitest";
import { stageBullProofBuffer, deriveBullRegistryPda } from "./bull-registry-tracker.js";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const MPL_CORE_PROGRAM_ID = new web3.PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);
const skipBenchmarkSuite = process.env.RODEO_TEST_SUITE !== "benchmark";
const root = resolve(import.meta.dirname, "../..");
const SETTLE_REVEAL_HEAP_BYTES = 32_768;
const SETTLE_REVEAL_CU = 1_400_000;

interface FixtureCase {
  case: string;
  scale: number;
  position: string;
  positionId: number;
  globalConfig: string;
  programId: string;
  victim: string;
  finalOwner: string;
  newBull: {
    position: string;
    owner: string;
    buck_power: number;
    reveal_config_version: number;
  };
  selectedBull: {
    position: string;
    owner: string;
    buck_power: number;
  };
  payloadHex: string;
  ownerTreeRoot: number[];
  totalBullCount: number;
  totalBuckPower: number;
  registryVersion: number;
  snapshotRoot: number[];
  snapshotTotalCount: number;
  snapshotTotalPower: number;
  snapshotVersion: number;
  currentOwnerTreeRoot: number[];
  currentTotalBullCount: number;
  currentTotalBuckPower: number;
  currentRegistryVersion: number;
  expectedSuccess?: boolean;
}

function loadIdl(name: string): Idl {
  const path = resolve(root, "target/idl", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
}

function cuFrom(tx: any): number {
  const raw = tx.meta?.computeUnitsConsumed;
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") return Number(raw);
  throw new Error(`computeUnitsConsumed unavailable in transaction metadata`);
}

async function getConfirmedTransaction(
  connection: web3.Connection,
  signature: string,
): Promise<any> {
  await connection.confirmTransaction(signature, "confirmed");
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) throw new Error(`Cannot retrieve transaction metadata for ${signature}`);
  return tx;
}

async function getLamportBalance(
  provider: AnchorProvider,
  address: web3.PublicKey,
): Promise<number> {
  return provider.connection.getBalance(address, "confirmed");
}

function programDataAddress(programId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

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
  version: BN,
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("protocol-config"),
      globalConfig.toBuffer(),
      version.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

async function revokeMintAuthorities(
  connection: web3.Connection,
  payer: web3.Keypair,
  mint: web3.PublicKey,
): Promise<void> {
  await setAuthority(connection, payer, mint, payer, AuthorityType.MintTokens, null);
}

function bytesEq(a: Uint8Array | number[], b: Uint8Array | number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function selectCase(cases: FixtureCase[]): FixtureCase {
  const selector = process.env.RODEO_BENCHMARK_CASE;
  if (selector) {
    const found = cases.find((c) => `${c.case}_${c.scale}` === selector);
    if (found) return found;
  }
  // Default to the first (small-scale) case.
  return cases[0];
}

describe.skipIf(!localnetAvailable || skipBenchmarkSuite)("SBF SettleReveal benchmark", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  let rodeoCoreProgram: Program<Idl>;
  let rodeoMint: web3.PublicKey;
  let ansemMint: web3.PublicKey;
  let payerRodeoAccount: web3.PublicKey;
  let globalConfig: web3.PublicKey;
  let rewardState: web3.PublicKey;
  let globalGameState: web3.PublicKey;
  let bullAccumulator: web3.PublicKey;
  let principalVault: web3.PublicKey;
  let rewardVault: web3.PublicKey;
  let receiptCollection: web3.PublicKey;
  let receiptAuthority: web3.PublicKey;
  let protocolConfigV1: web3.PublicKey;
  let bullRegistry: web3.PublicKey;

  const stakeAmountAtomic = new BN(100_000_000_000);
  const fixtureFile = JSON.parse(
    readFileSync(resolve(root, "tests/integration/fixtures/settle_reveal_fixtures.json"), "utf8"),
  ) as { cases: FixtureCase[] };

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);
    payer = (provider.wallet as unknown as { payer: web3.Keypair }).payer;

    const idl = loadIdl("rodeo_core");
    const instructionNames = idl.instructions.map((i: any) => i.name);
    for (const required of ["stake_and_commit", "initialize_bull_proof", "settle_reveal"]) {
      if (!instructionNames.includes(required)) {
        throw new Error(`${required} not found in target/idl/rodeo_core.json`);
      }
    }
    for (const required of [
      "test_fixture_set_bull_registry",
      "test_fixture_set_global_game_state",
      "test_fixture_set_reward_state",
    ]) {
      if (!instructionNames.includes(required)) {
        throw new Error(`${required} not found in IDL; build without test-fixtures?`);
      }
    }

    rodeoCoreProgram = new Program<Idl>(idl, provider);

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
    [bullRegistry] = deriveBullRegistryPda(rodeoCoreProgram.programId, globalConfig);

    const expectedTotalSupply = 1_000_000_000_000_000n;

    rodeoMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    ansemMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

    payerRodeoAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      rodeoMint,
      payer.publicKey,
    );

    await mintTo(
      provider.connection,
      payer,
      rodeoMint,
      payerRodeoAccount,
      payer,
      expectedTotalSupply,
    );

    const payerAnsemAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      ansemMint,
      payer.publicKey,
    );
    await mintTo(provider.connection, payer, ansemMint, payerAnsemAccount, payer, 2_000_000_000_000_000n);

    await revokeMintAuthorities(provider.connection, payer, rodeoMint);
    await revokeMintAuthorities(provider.connection, payer, ansemMint);

    [protocolConfigV1] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      new BN(1),
    );

    const programData = programDataAddress(rodeoCoreProgram.programId);
    const upgradeCouncil = web3.Keypair.generate();
    const treasuryCouncil = web3.Keypair.generate();
    const emergencyGuardians = web3.Keypair.generate();

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
  }, 120_000);

  async function stakeAndCommit(positionId: BN) {
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

    await rodeoCoreProgram.methods
      .stakeAndCommit(positionId, stakeAmountAtomic)
      .accounts({
        owner: payer.publicKey,
        ownerRodeoTokenAccount: payerRodeoAccount,
        globalConfig,
        protocolConfig: protocolConfigV1,
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

    return { position, pendingRandomness };
  }

  async function settleReveal(
    positionId: BN,
    receiptOwner: web3.PublicKey,
    bullProof: { bufferPda: web3.PublicKey; refundRecipient: web3.PublicKey },
  ) {
    const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
    const pos = await (rodeoCoreProgram.account as any).position.fetch(position);
    const [pendingRandomness] = deriveRandomness(
      rodeoCoreProgram.programId,
      position,
      0,
      new BN(0),
    );
    const [protocolConfig] = deriveProtocolConfig(
      rodeoCoreProgram.programId,
      globalConfig,
      new BN(1),
    );
    const [receiptAsset] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );
    const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-funder"), position.toBuffer()],
      rodeoCoreProgram.programId,
    );

    const sig = await rodeoCoreProgram.methods
      .settleReveal()
      .accounts({
        settler: payer.publicKey,
        globalConfig,
        globalGameState,
        rewardState,
        bullAccumulator,
        position,
        pendingRandomness,
        protocolConfig,
        owner: pos.owner,
        receiptOwner,
        receiptAsset,
        receiptCollection,
        receiptAuthority,
        receiptFunder,
        providerRandomnessAccount: web3.SYSVAR_RENT_PUBKEY,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        bullProofBuffer: bullProof.bufferPda,
        refundRecipient: bullProof.refundRecipient,
      })
      .preInstructions([
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: SETTLE_REVEAL_CU }),
        web3.ComputeBudgetProgram.requestHeapFrame({ bytes: SETTLE_REVEAL_HEAP_BYTES }),
      ])
      .signers([payer])
      .rpc();

    return { position, pendingRandomness, sig, receiptAsset };
  }

  it(
    "exercises the production SettleReveal path",
    async () => {
      const fixture = selectCase(fixtureFile.cases);
      const positionId = new BN(fixture.positionId);
      const [position] = derivePosition(rodeoCoreProgram.programId, globalConfig, positionId);
      const [pendingRandomness] = deriveRandomness(
        rodeoCoreProgram.programId,
        position,
        0,
        new BN(0),
      );

      // 1. Configure the deterministic fixture state.
      await rodeoCoreProgram.methods
        .testFixtureSetGlobalGameState(
          new BN(100),
          positionId,
          new BN(0),
          new BN(0),
        )
        .accounts({
          authority: payer.publicKey,
          globalConfig,
          globalGameState,
        })
        .signers([payer])
        .rpc();

      await rodeoCoreProgram.methods
        .testFixtureSetRewardState(new BN(0))
        .accounts({
          authority: payer.publicKey,
          globalConfig,
          rewardState,
        })
        .signers([payer])
        .rpc();

      await rodeoCoreProgram.methods
        .testFixtureSetBullRegistry(
          Buffer.from(new Uint8Array(fixture.snapshotRoot)),
          new BN(fixture.snapshotTotalCount),
          new BN(fixture.snapshotTotalPower),
          new BN(fixture.snapshotVersion),
        )
        .accounts({
          authority: payer.publicKey,
          globalConfig,
          bullRegistry,
        })
        .signers([payer])
        .rpc();

      // 2. Real production stake_and_commit.
      await stakeAndCommit(positionId);

      // 3. Move the registry to the "current" state the proof is built against.
      await rodeoCoreProgram.methods
        .testFixtureSetBullRegistry(
          Buffer.from(new Uint8Array(fixture.currentOwnerTreeRoot)),
          new BN(fixture.currentTotalBullCount),
          new BN(fixture.currentTotalBuckPower),
          new BN(fixture.currentRegistryVersion),
        )
        .accounts({
          authority: payer.publicKey,
          globalConfig,
          bullRegistry,
        })
        .signers([payer])
        .rpc();

      // 4. Stage the reveal BullProofBuffer through production instructions.
      const payloadBytes = Buffer.from(fixture.payloadHex, "hex");
      const nonce = new BN(1);
      const prover = payer;
      const staged = await stageBullProofBuffer(
        rodeoCoreProgram,
        globalConfig,
        position,
        pendingRandomness,
        prover,
        nonce,
        { reveal: {} },
        payloadBytes,
      );

      const bufferInfoBefore = await provider.connection.getAccountInfo(staged.bufferPda);
      expect(bufferInfoBefore).not.toBeNull();
      const bufferLamportsBefore = bufferInfoBefore!.lamports;

      const proverBalanceBefore = await getLamportBalance(provider, prover.publicKey);

      // 5. Production settle_reveal with the target compute/heap budget.
      const { receiptAsset, sig } = await settleReveal(
        positionId,
        new web3.PublicKey(fixture.finalOwner),
        {
          bufferPda: staged.bufferPda,
          refundRecipient: staged.refundRecipient,
        },
      );

      const settleTx = await getConfirmedTransaction(provider.connection, sig);
      const consumedCu = cuFrom(settleTx);

      // 6. Post-state assertions.
      const pos = await (rodeoCoreProgram.account as any).position.fetch(position);
      expect(pos.role.bull).toBeTruthy();
      expect(pos.owner.toBase58()).toBe(fixture.finalOwner);
      expect(pos.buckPower).toBe(fixture.newBull.buck_power);
      expect(pos.revealConfigVersion.toNumber()).toBe(fixture.newBull.reveal_config_version);

      const registry = await (rodeoCoreProgram.account as any).bullRegistry.fetch(bullRegistry);
      expect(Buffer.from(new Uint8Array(registry.ownerTreeRoot)).equals(
        Buffer.from(new Uint8Array(fixture.ownerTreeRoot)),
      )).toBe(true);
      expect(BigInt(registry.totalBullCount.toString())).toBe(BigInt(fixture.totalBullCount));
      expect(BigInt(registry.totalBuckPower.toString())).toBe(BigInt(fixture.totalBuckPower));
      expect(BigInt(registry.registryVersion.toString())).toBe(BigInt(fixture.registryVersion));

      const [receiptFunder] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("receipt-funder"), position.toBuffer()],
        rodeoCoreProgram.programId,
      );
      const receiptFunderInfo = await provider.connection.getAccountInfo(receiptFunder);
      expect(receiptFunderInfo).not.toBeNull();
      // The ReceiptFunder PDA must persist after reveal so it can pay for the
      // eventual receipt burn on unstake. It is not closed here.
      expect(receiptFunderInfo!.owner.toBase58()).toBe(web3.SystemProgram.programId.toBase58());

      const pendingInfo = await provider.connection.getAccountInfo(pendingRandomness);

      expect(pendingInfo).toBeNull();
      const bufferInfoAfter = await provider.connection.getAccountInfo(staged.bufferPda);

      expect(bufferInfoAfter).toBeNull();
      const receiptAssetInfo = await provider.connection.getAccountInfo(receiptAsset);

      expect(receiptAssetInfo).not.toBeNull();
      const proverBalanceAfter = await getLamportBalance(provider, prover.publicKey);
      expect(proverBalanceAfter).toBeGreaterThanOrEqual(proverBalanceBefore);

      console.log(
        `[settle-reveal] ${fixture.case} @ scale ${fixture.scale}: CU ${consumedCu}, payload ${payloadBytes.length} bytes`,
      );
    },
    120_000,
  );
});
