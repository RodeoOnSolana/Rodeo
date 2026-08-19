import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, setProvider, web3 } from "@coral-xyz/anchor";
import {
  buildRegistry,
  type BullLeaf,
  type RegistryEntry,
} from "./sparse-tree.js";
import { beforeAll, describe, expect, it } from "vitest";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const MPL_CORE_PROGRAM_ID = new web3.PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);
const skipBenchmarkSuite = process.env.RODEO_TEST_SUITE !== "benchmark";
const BENCHMARK_HEAP_BYTES = Number(process.env.RODEO_HEAP_BYTES ?? 32_768);
const root = resolve(import.meta.dirname, "../..");
const PARITY_SAMPLE_SIZE = 10_000;

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
): Promise<NonNullable<ReturnType<web3.Connection["getTransaction"]>> extends Promise<infer T> ? T : never> {
  await connection.confirmTransaction(signature, "confirmed");
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) throw new Error(`Cannot retrieve transaction metadata for ${signature}`);
  return tx as any;
}

function bytesEq(a: Uint8Array | number[], b: Uint8Array | number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const POWERS = [4, 6, 8, 10];
const BULL_DISTRIBUTION = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function u64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function detOwner(i: number): web3.PublicKey {
  return new web3.PublicKey(sha256(Buffer.concat([Buffer.from("owner"), u64le(i)])));
}

function detBull(ownerIndex: number, bullIndex: number): web3.PublicKey {
  return new web3.PublicKey(sha256(Buffer.concat([Buffer.from("bull"), u64le(ownerIndex), u64le(bullIndex)])));
}

function buildTsRegistry(scale: number) {
  const entries: RegistryEntry[] = [];
  let totalCount = 0;
  let totalPower = 0n;
  let ownerIndex = 0;

  const denseCount = scale >= 2000 ? 1000 : Math.floor(scale / 2);
  let remaining = scale - denseCount;

  function addOwner(count: number) {
    const owner = detOwner(ownerIndex);
    const bulls: BullLeaf[] = [];
    for (let j = 0; j < count; j++) {
      const position = detBull(ownerIndex, j);
      const power = POWERS[(ownerIndex + j) % POWERS.length];
      bulls.push({
        position,
        positionId: BigInt(totalCount + 1),
        owner,
        buckPower: power,
        revealConfigVersion: 1n,
      });
      totalCount++;
      totalPower += BigInt(power);
    }
    entries.push({ owner, bulls });
    ownerIndex++;
  }

  if (denseCount > 0) addOwner(denseCount);
  let patternIdx = 0;
  while (remaining > 0) {
    const wanted = BULL_DISTRIBUTION[patternIdx % BULL_DISTRIBUTION.length];
    const count = Math.min(wanted, remaining);
    if (count === 0) break;
    addOwner(count);
    remaining -= count;
    patternIdx++;
  }

  const reg = buildRegistry(entries);
  return { reg, totalCount, totalPower };
}

interface FixtureScale {
  scale: number;
  ownerCount: number;
  totalBullCount: number;
  totalBuckPower: number;
  ownerTreeRoot: number[];
  generationTimeSeconds: number;
  peakMemoryKb: number;
  ownerRootMatches?: boolean;
  bullRootMatches?: boolean;
}

interface FixtureCase {
  case: string;
  scale: number;
  ownerCount: number;
  bullsInSelectedOwner: number;
  ownerTreeRoot: number[];
  totalBullCount: number;
  totalBuckPower: number;
  registryVersion: number;
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
  payloadBytes: number;
  payloadHex: string;
  ownerSiblings: string[];
  bullSiblings: string[];
  expectedSuccess?: boolean;
  sectionBytes: {
    header: number;
    victim_owner: number;
    selected_owner: number;
    selected_bull: number;
    current_owner: number;
    current_bull: number;
    remove_bull: number;
    total: number;
  };
  randomOutput: number[] | null;
  position: string | null;
  actionNonce: number;
  externalCount: number;
  externalPower: number;
  selectedOwnerIntervalStart: number;
  selectedOwnerIntervalEnd: number;
  selectedBullIntervalStart: number;
  selectedBullIntervalEnd: number;
  snapshotRoot: number[];
  snapshotTotalCount: number;
  snapshotTotalPower: number;
  snapshotVersion: number;
  currentOwnerTreeRoot: number[];
  currentTotalBullCount: number;
  currentTotalBuckPower: number;
  currentRegistryVersion: number;
}

interface FixtureFile {
  scales: FixtureScale[];
  cases: FixtureCase[];
  meta?: { generatedAt: string; full: boolean };
}

describe.skipIf(!localnetAvailable || skipBenchmarkSuite)("SBF sparse-tree BenchmarkSparseTree", () => {
  let provider: AnchorProvider;
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
      throw new Error("benchmark_sparse_tree not found in target/idl/rodeo_core.json");
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

  it.each(fixtures.cases.map((c) => [c.case, c.scale, c] as [string, number, FixtureCase]))(
    "%s @ %i",
    async (_caseName, _scale, fixture) => {
      const authority = provider.wallet.publicKey;
      const nonce = new BN(++bufferNonce);

      await rodeoCoreProgram.methods
        .testFixtureSetBullRegistry(
          Buffer.from(new Uint8Array(fixture.currentOwnerTreeRoot)),
          new BN(fixture.currentTotalBullCount),
          new BN(fixture.currentTotalBuckPower),
          new BN(fixture.currentRegistryVersion),
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

        if (!bytesEq(fixture.snapshotRoot, fixture.currentOwnerTreeRoot)) {
          await rodeoCoreProgram.methods
            .testFixtureSetBullProofBufferSnapshot(
              Buffer.from(new Uint8Array(fixture.snapshotRoot)),
              new BN(fixture.snapshotVersion),
              new BN(fixture.snapshotTotalCount),
              new BN(fixture.snapshotTotalPower),
            )
            .accounts({
              authority,
              bullProofBuffer: bufferPda,
            })
            .rpc();
        }

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

      const requestedComputeUnits = 1_400_000;
      const benchTx = new web3.Transaction().add(
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: requestedComputeUnits }),
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
        benchmarkSuccess = benchmarkLogs.some((m: string) => m.includes("SparseTreeBenchmarked"));
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
          JSON.stringify(
            {
              case: fixture.case,
              scale: fixture.scale,
              message: err?.message ?? String(err),
              txid: sig,
              logs: Array.isArray(logs) ? logs : [logs],
            },
            null,
            2,
          ),
        );
        benchmarkSuccess = false;
      }

      const expectedSuccess = fixture.expectedSuccess !== false;
      if (expectedSuccess) {
        expect(benchmarkSuccess).toBe(true);
      } else {
        expect(benchmarkSuccess).toBe(false);
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
        requested_compute_units: requestedComputeUnits,
        benchmark_compute_units: benchmarkCu,
        success: benchmarkSuccess,
        section_bytes: fixture.sectionBytes,
        external_count: fixture.externalCount,
        external_power: fixture.externalPower,
        selected_owner_interval_start: fixture.selectedOwnerIntervalStart,
        selected_owner_interval_end: fixture.selectedOwnerIntervalEnd,
        selected_bull_interval_start: fixture.selectedBullIntervalStart,
        selected_bull_interval_end: fixture.selectedBullIntervalEnd,
        random_output: fixture.randomOutput,
        position: fixture.position,
        action_nonce: fixture.actionNonce,
        snapshot_root: fixture.snapshotRoot,
        current_owner_tree_root: fixture.currentOwnerTreeRoot,
      };
      if (!benchmarkSuccess) {
        writeFileSync(
          resolve(root, `.ci-artifacts/benchmark_logs_${fixture.case}_${fixture.scale}.json`),
          JSON.stringify({ case: fixture.case, scale: fixture.scale, logs: benchmarkLogs, cu: benchmarkCu }, null, 2),
        );
      }

      results.push(row);
      console.log(row);
    },
    120_000,
  );

  it("TypeScript/Rust deterministic root parity", () => {
    const parityResults: any[] = [];
    // Only compare the canonical owner-population scales (ownerCount > 10).
    // Bull-subtree and remove-one fixtures reuse small scale numbers but have
    // a different registry shape, so they are not meaningful root-parity targets
    // for the full owner-tree generator.
    const mainOwnerScales = fixtures.scales.filter(
      (s) => s.scale >= 100 && s.ownerCount > 10,
    );
    const uniqueSampleSizes = [
      ...new Set(mainOwnerScales.map((s) => Math.min(s.scale, PARITY_SAMPLE_SIZE))),
    ].sort((a, b) => a - b);

    for (const sampleSize of uniqueSampleSizes) {
      const target = mainOwnerScales.find((s) => s.scale === sampleSize);
      if (!target) {
        console.log(`No ${sampleSize} fixture for parity`);
        continue;
      }

      const { reg, totalCount, totalPower } = buildTsRegistry(sampleSize);
      const root = reg.rootNode;
      const ownerRootMatch = bytesEq(root.hash, target.ownerTreeRoot);
      const countMatch = root.count === BigInt(target.totalBullCount);
      const powerMatch = root.power === BigInt(target.totalBuckPower);

      parityResults.push({
        sampleSize,
        ownerRootMatch,
        countMatch,
        powerMatch,
        expectedRoot: Buffer.from(target.ownerTreeRoot).toString("hex"),
        gotRoot: Buffer.from(root.hash).toString("hex"),
      });

      expect(ownerRootMatch).toBe(true);
      expect(countMatch).toBe(true);
      expect(powerMatch).toBe(true);
    }

    console.table(parityResults);
  }, 300_000);

  it("prints benchmark result table", () => {
    console.table(results);
    const outDir = resolve(root, ".ci-artifacts");
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `benchmark_heap_${BENCHMARK_HEAP_BYTES}.json`);
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log("wrote benchmark results to", outPath);
    expect(results.length).toBeGreaterThan(0);
  });
});
