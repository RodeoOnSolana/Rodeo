import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getMint,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import { beforeAll, describe, expect, it } from "vitest";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const MPL_CORE_PROGRAM_ID = new web3.PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);
const RODEO_CORE_PROGRAM_ID = new web3.PublicKey(
  "EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z",
);

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);
const skipBenchmarkSuite = process.env.RODEO_TEST_SUITE !== "benchmark";
const BENCHMARK_HEAP_BYTES = Number(process.env.RODEO_HEAP_BYTES ?? 32_768);
const root = resolve(import.meta.dirname, "../..");

function loadIdl(name: string): Idl {
  const path = resolve(root, "target/idl", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
}

function programDataAddress(programId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
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

async function getConfirmedTransaction(
  connection: web3.Connection,
  signature: string,
): Promise<NonNullable<ReturnType<web3.Connection["getTransaction"]>> extends Promise<infer T> ? T : never> {
  await connection.confirmTransaction(signature, "confirmed");
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) throw new Error(`Cannot retrieve transaction metadata for ${signature}`);
  return tx as any;
}

function cuFrom(tx: any): number {
  const raw = tx.meta?.computeUnitsConsumed;
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") return Number(raw);
  throw new Error(`computeUnitsConsumed unavailable in transaction metadata`);
}

interface FixtureCase {
  case: string;
  scale: number;
  ownerCount: number;
  bullsInSelectedOwner: number;
  victim: string | null;
  newBull: {
    position: string;
    position_id: number;
    owner: string;
    buck_power: number;
    reveal_config_version: number;
  } | null;
  nonDefaultOwnerSiblings: number;
  nonDefaultBullSiblings: number;
  ownerSiblings: string[];
  bullSiblings: string[];
  payloadBytes: number;
  payloadHex: string;
  ownerTreeRoot: number[];
  totalBullCount: number;
  totalBuckPower: number;
  registryVersion: number;
}

interface FixtureFile {
  scales: { scale: number; ownerCount: number; totalBullCount: number; totalBuckPower: number }[];
  cases: FixtureCase[];
}

describe.skipIf(!localnetAvailable || skipBenchmarkSuite)("SBF sparse-tree BenchmarkSparseTree", () => {
  let provider: AnchorProvider;
  let payer: web3.Keypair;
  let rodeoCoreProgram: Program<Idl>;
  let globalConfig: web3.PublicKey;
  let bullRegistry: web3.PublicKey;
  const fixtures = JSON.parse(
      readFileSync(resolve(root, "tests/integration/fixtures/benchmark_fixtures.json"), "utf8"),
    ) as FixtureFile;
  const results: any[] = [];

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);

    const idl = loadIdl("rodeo_core");
    const instructionNames = idl.instructions.map((i: any) => i.name);
    if (!instructionNames.includes("benchmark_sparse_tree")) {
      throw new Error("benchmark_sparse_tree not found in target/idl/rodeo_core.json; build without test-fixtures?");
    }
    if (!instructionNames.includes("test_fixture_initialize_protocol_accounts")) {
      throw new Error("test_fixture_initialize_protocol_accounts not found in IDL; build without test-fixtures?");
    }

    rodeoCoreProgram = new Program<Idl>(idl, provider);

    [globalConfig] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      rodeoCoreProgram.programId,
    );
    [bullRegistry] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bull-registry"), globalConfig.toBuffer()],
      rodeoCoreProgram.programId,
    );

    await rodeoCoreProgram.methods
      .testFixtureInitializeProtocolAccounts()
      .accounts({
        authority: provider.wallet.publicKey,
        globalConfig,
        bullRegistry,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }, 120_000);

  const CHUNK_SIZE = 900;
  let bufferNonce = 0;

  it.each(fixtures.cases.filter((c: any) => c.case === "A"))("%s @ %i", async (fixture) => {
    const authority = provider.wallet.publicKey;
    const nonce = new BN(++bufferNonce);

    await rodeoCoreProgram.methods
      .testFixtureSetBullRegistry(
        Buffer.from(new Uint8Array(fixture.ownerTreeRoot)),
        new BN(fixture.totalBullCount),
        new BN(fixture.totalBuckPower),
        new BN(fixture.registryVersion),
      )
      .accounts({
        authority,
        globalConfig,
        bullRegistry,
      })
      .rpc();

    const payload = Buffer.from(fixture.payloadHex, "hex");
    let bufferPda: web3.PublicKey | null = null;
    let bufferAccountBytes = 0;
    let appendTxCount = 0;
    let initCu = 0;
    let appendCu = 0;
    let finalizeCu = 0;
    let bufferRent = 0;

    if (payload.length > 0) {
      [bufferPda] = web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("bull-proof-buffer"),
          authority.toBuffer(),
          authority.toBuffer(),
          nonce.toArrayLike(Buffer, "le", 8),
        ],
        rodeoCoreProgram.programId,
      );

      const initSig = await rodeoCoreProgram.methods
        .testFixtureInitializeBullProofBuffer(new BN(payload.length), nonce)
        .accounts({
          authority,
          globalConfig,
          bullProofBuffer: bufferPda,
          systemProgram: web3.SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const initTx = await getConfirmedTransaction(provider.connection, initSig);
      initCu = cuFrom(initTx);

      const bufferInfo = await provider.connection.getAccountInfo(bufferPda);
      bufferAccountBytes = bufferInfo?.data.length ?? 0;
      bufferRent = await provider.connection.getMinimumBalanceForRentExemption(bufferAccountBytes);

      for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
        const chunk = payload.subarray(offset, offset + CHUNK_SIZE);
        const appendSig = await rodeoCoreProgram.methods
          .testFixtureAppendBullProofBuffer(nonce, new BN(offset), chunk)
          .accounts({
            authority,
            bullProofBuffer: bufferPda,
          })
          .rpc();
        const appendTx = await getConfirmedTransaction(provider.connection, appendSig);
        appendCu += cuFrom(appendTx);
        appendTxCount += 1;
      }

      const finalizeSig = await rodeoCoreProgram.methods
        .testFixtureFinalizeBullProofBuffer(nonce)
        .accounts({
          authority,
          bullProofBuffer: bufferPda,
        })
        .rpc();
      const finalizeTx = await getConfirmedTransaction(provider.connection, finalizeSig);
      finalizeCu = cuFrom(finalizeTx);
    }

    const victim = fixture.victim ? new web3.PublicKey(fixture.victim) : null;
    const newBull = fixture.newBull
      ? {
          position: new web3.PublicKey(fixture.newBull.position),
          positionId: new BN(fixture.newBull.position_id),
          owner: new web3.PublicKey(fixture.newBull.owner),
          buckPower: fixture.newBull.buck_power,
          revealConfigVersion: new BN(fixture.newBull.reveal_config_version),
        }
      : null;

    const benchIx = await rodeoCoreProgram.methods
      .benchmarkSparseTree(victim, newBull)
      .accounts({
        authority,
        globalConfig,
        bullRegistry,
        bullProofBuffer: bufferPda ?? web3.PublicKey.default,
      })
      .instruction();

    const benchTx = new web3.Transaction().add(
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      web3.ComputeBudgetProgram.requestHeapFrame({ bytes: BENCHMARK_HEAP_BYTES }),
      benchIx,
    );

    let benchmarkCu = 0;
    let benchmarkSuccess = false;
    let benchmarkLogs: string[] = [];
    let benchSig: string | null = null;
    try {
      benchTx.feePayer = provider.wallet.publicKey;
      benchSig = await provider.sendAndConfirm(benchTx);
      const tx = await getConfirmedTransaction(provider.connection, benchSig);
      benchmarkCu = cuFrom(tx);
      benchmarkLogs = tx!.meta?.logMessages ?? [];
      benchmarkSuccess = benchmarkLogs.some((m: string) =>
        m.includes("SparseTreeBenchmarked"),
      );
    } catch (err: any) {
      const sig = err?.txid ?? err?.signature ?? null;
      if (sig) {
        const tx = await getConfirmedTransaction(provider.connection, sig);
        if (tx) {
          benchmarkCu = cuFrom(tx);
          benchmarkLogs = tx.meta?.logMessages ?? [];
        }
      }
      const logs = err?.logs ?? (typeof err?.getLogs === "function" ? err.getLogs() : undefined) ?? [];
      writeFileSync(
        resolve(root, `.ci-artifacts/benchmark_err_${fixture.case}_${fixture.scale}.json`),
        JSON.stringify({
          case: fixture.case,
          scale: fixture.scale,
          message: err?.message ?? String(err),
          txid: sig,
          logs: Array.isArray(logs) ? logs : [logs],
        }, null, 2)
      );
      benchmarkSuccess = false;
    }

    const row = {
      case_name: fixture.case,
      tree_scale: fixture.scale,
      owner_count: fixture.ownerCount,
      selected_owner_bull_count: fixture.bullsInSelectedOwner,
      victim_present: fixture.victim !== null,
      non_default_owner_siblings: fixture.nonDefaultOwnerSiblings,
      non_default_bull_siblings: fixture.nonDefaultBullSiblings,
      compressed_proof_bytes: fixture.payloadBytes,
      payload_bytes: fixture.payloadBytes,
      buffer_account_bytes: bufferAccountBytes,
      buffer_rent_lamports: bufferRent,
      append_tx_count: appendTxCount,
      init_compute_units: initCu,
      append_compute_units: appendCu,
      finalize_compute_units: finalizeCu,
      staging_compute_units: initCu + appendCu + finalizeCu,
      requested_heap_bytes: BENCHMARK_HEAP_BYTES,
      benchmark_compute_units: benchmarkCu,
      success: benchmarkSuccess,
    };
    if (!benchmarkSuccess) {
      writeFileSync(
        resolve(root, `.ci-artifacts/benchmark_logs_${fixture.case}_${fixture.scale}.json`),
        JSON.stringify({ case: fixture.case, scale: fixture.scale, logs: benchmarkLogs, cu: benchmarkCu }, null, 2)
      );
    }

    results.push(row);
    console.log(row);
  }, 90_000);

  it("prints benchmark result table", async () => {
    console.table(results);
    const outDir = resolve(root, ".ci-artifacts");
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `benchmark_heap_${BENCHMARK_HEAP_BYTES}.json`);
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log("wrote benchmark results to", outPath);
    expect(results.length).toBeGreaterThan(0);
  });
});
