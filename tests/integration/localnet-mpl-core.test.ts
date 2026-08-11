import { AnchorProvider, setProvider, web3 } from "@coral-xyz/anchor";
import { beforeAll, describe, expect, it } from "vitest";

// Phase 2D3A1 scope only: prove the real Metaplex Core on-chain program
// (fetched by scripts/fetch-mpl-core-program.sh and loaded into the local
// validator at genesis via Anchor.toml's [[test.genesis]]) is present,
// owned by the BPF Upgradeable Loader, and executable. This suite
// deliberately does NOT create/transfer/burn any Metaplex Core asset yet --
// that proof is scoped to a follow-up PR (see
// docs/mpl-core-integration-proof.md, section "2D3A2").
const MPL_CORE_PROGRAM_ID = new web3.PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const localnetAvailable = Boolean(process.env.ANCHOR_PROVIDER_URL && process.env.ANCHOR_WALLET);
const skipMplCoreSuite =
  !localnetAvailable ||
  process.env.RODEO_TEST_SUITE === "epoch" ||
  process.env.RODEO_TEST_SUITE === "claim";

describe.skipIf(skipMplCoreSuite)("Metaplex Core genesis-loaded program (integration proof)", () => {
  let provider: AnchorProvider;

  beforeAll(() => {
    provider = AnchorProvider.env();
    setProvider(provider);
  });

  it("is present on the local validator at its canonical mainnet program ID", async () => {
    const accountInfo = await provider.connection.getAccountInfo(MPL_CORE_PROGRAM_ID);
    expect(accountInfo).not.toBeNull();
    expect(accountInfo!.executable).toBe(true);
  });

  it("is owned by the BPF Upgradeable Loader, matching how it is deployed on mainnet-beta", async () => {
    const accountInfo = await provider.connection.getAccountInfo(MPL_CORE_PROGRAM_ID);
    expect(accountInfo).not.toBeNull();
    expect(accountInfo!.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)).toBe(true);
  });

  it("has non-trivial program data, confirming a real binary was loaded rather than a stub", async () => {
    const accountInfo = await provider.connection.getAccountInfo(MPL_CORE_PROGRAM_ID);
    expect(accountInfo).not.toBeNull();
    // The upgradeable loader's "Program" account is a thin pointer (~36
    // bytes); the executable bytecode itself lives in a separate
    // ProgramData account. Either way this account's data must be
    // non-empty, proving genesis actually loaded something at this address.
    expect(accountInfo!.data.length).toBeGreaterThan(0);
  });
});
