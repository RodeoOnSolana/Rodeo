import { AnchorProvider, setProvider, web3 } from "@coral-xyz/anchor";
import { beforeAll, describe, it } from "vitest";

const skipBenchmarkSuite = process.env.RODEO_TEST_SUITE !== "benchmark";

describe.skipIf(skipBenchmarkSuite)("SBF sparse-tree BenchmarkSparseTree", () => {
  let provider: AnchorProvider;

  beforeAll(async () => {
    provider = AnchorProvider.env();
    setProvider(provider);
  });

  it("is a placeholder until the deterministic proof generator is ready", () => {
    // The benchmark fixture exists in the test-fixtures SBF binary.
    // This test will be filled with the off-chain proof generator and
    // transaction compute-unit extraction once the generator is in place.
    console.log("BenchmarkSparseTree CI path is connected; generator pending.");
  });
});
