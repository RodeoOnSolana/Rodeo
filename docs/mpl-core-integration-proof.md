# MPL Core integration proof (Phase 2D3A)

This document tracks the technical foundation/proof layer for `PositionReceipt`
(Metaplex Core NFT receipts), split into independently reviewable PRs. No PR
in this series modifies production Rodeo gameplay instructions. The
production `rodeo_core` instruction count must remain exactly 10 until a
later, explicitly scoped phase.

Series:

- **2D3A1** (this PR): dependency + deterministic localnet/CI infrastructure.
- **2D3A2**: stateless `ReceiptAuthority` + `PositionReceipt` PDA + permanent
  plugin CPI proof (create/transfer/burn, positive and negative tests).
- **2D3A3**: official Collection + metadata/update-authority proof.
- **2D3A4**: receipt funding/rent architecture proof and recommendation.

## 2D3A1 scope

- Add the production `mpl-core` dependency to `programs/rodeo_core`.
- Prove the dependency graph is clean (single `anchor-lang`/`solana-program`
  version, no accidental Anchor 0.32 pull-in).
- Load the real Metaplex Core on-chain program into localnet/CI
  deterministically and prove it is present and executable.
- Add a dedicated `RODEO_TEST_SUITE=mplcore` integration-test profile.

Explicitly out of scope for 2D3A1: any receipt creation, transfer, burn,
collection, metadata, or funding logic; any change to production
`settle_reveal`, `settle_unstake`, `recover_reveal_timeout`,
`recover_unstake_timeout`, or `stake_and_commit`; any change to
`ProtocolConfig`.

## Dependency compatibility matrix

`mpl-core` versions were evaluated by editing `programs/rodeo_core/Cargo.toml`
in a scratch commit, running `cargo tree -p rodeo_core`, and reverting.
Compilation itself (`cargo check`, `anchor build`) can only be verified in
CI, because this development sandbox has no MSVC linker and no Anchor/Solana
CLI installed.

| Candidate | `cargo tree` result | Notes |
|---|---|---|
| `0.8.2` | N/A | Not published on crates.io. |
| `0.9.1` / `0.10.0` / `0.10.1` | **FAIL** | Bundle `anchor-lang ^0.30.0` -> `solana-program ^1.16` -> `curve25519-dalek` -> `zeroize <1.4`, which conflicts with this workspace's `anchor-lang 0.31.1` / `solana-program 2.x` chain. |
| `0.11.0` | N/A | Not published on crates.io (only `0.11.1`, `0.11.1-beta.*`, `0.11.2` exist near this version). |
| `0.11.1` | **OK** | Resolves to a single `anchor-lang 0.31.1`, single `solana-program 2.2.1`. Requires bumping `solana-program`/`solana-zk-sdk` from `2.1.0` to `2.2.1`. |
| **`0.11.2` (chosen)** | **OK** | Same clean, unified graph as `0.11.1`; newest version with that property. |
| `0.12.0` / `0.12.1` | **Risky** | Their `kaigan 0.5.0` dependency unconditionally pulls `anchor-lang 0.32.1` and a duplicate `solana-program 3.0.0`, alongside the `anchor-lang 0.31.1` / `solana-program 2.x` that `mpl-core` itself still declares. This produces two different major versions of `anchor-lang` and `solana-program` in the same dependency tree. |

Chosen dependency set (`programs/rodeo_core/Cargo.toml`):

```toml
anchor-lang = { version = "0.31.1", features = ["init-if-needed"] }
anchor-spl = { version = "0.31.1", default-features = false, features = ["token", "token_2022"] }
solana-program = "=2.2.1"
solana-zk-sdk = "=2.2.1"
mpl-core = { version = "=0.11.2", default-features = false }
```

Verified locally via `cargo tree -p rodeo_core`, `cargo tree -p rodeo_market`,
`cargo tree -p rodeo_router`: exactly one `anchor-lang v0.31.1`, one
`solana-program v2.2.1`, one `solana-pubkey v2.2.1` across the whole
workspace. No `anchor-lang v0.32.x` or `solana-program v3.x` present.

`cargo check`, `cargo test -p rodeo_core`, `anchor build`, and the SBF build
must additionally pass in CI (see the `verify` job in
`.github/workflows/ci.yml`) before this is considered proven; a local
`cargo check` cannot complete in this environment because it fails at the
native-linker step of build-script compilation (`link.exe not found`),
which is unrelated to `mpl-core` itself and reproduces identically on the
pre-existing `2.1.0` dependency set.

## Deterministic Metaplex Core localnet program

The `mpl-core` crate on crates.io is the **Rust client SDK** (published from
`clients/rust` in the `metaplex-foundation/mpl-core` monorepo, confirmed via
the crate's embedded `.cargo_vcs_info.json`, git sha
`33eaba4d1cc792f79ee1107a290375efe144dbb2`); it does not contain the
on-chain program. The on-chain program lives under `programs/mpl-core` in
the same repository and is what actually runs at address
`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`.

The `metaplex-foundation/mpl-core` GitHub Releases only publish a prebuilt
`mpl_core_program.so` asset for a sparse subset of tags (`0.9.x`, `0.10.0`,
`0.11.0`, `0.12.0`, `0.13.x`, `0.14.0`, `0.15.x`, ...). There is no
`release/core@0.11.1` or `release/core@0.11.2` tag, so no official prebuilt
binary exists that exactly matches the pinned client version.

**Chosen approach for 2D3A1:** `scripts/fetch-mpl-core-program.sh` fetches
the on-chain program directly from its live mainnet-beta deployment via
`solana program dump`, on every CI run (never committed to git; see
`.gitignore`). This is:

- **Not silent**: the SHA-256 is printed, written to
  `vendor/mpl-core/mpl_core_program.so.sha256`, uploaded as a CI artifact,
  and appended to the job step summary on every run.
- **Verifiable independently**: the program ID
  `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` and its current executable
  hash can be cross-checked against any public Solana explorer.
- **Not yet pinned**: `scripts/fetch-mpl-core-program.sh` supports an
  optional `MPL_CORE_EXPECTED_SHA256` environment variable that, if set,
  fails the fetch step when the observed hash differs. This PR does not set
  it yet, because the first real hash is only known after this PR's CI run
  completes. **Follow-up action**: once CI has run once, pin the resulting
  hash as a required workflow input/secret (or a checked-in constant) so any
  future unannounced mainnet upgrade fails CI loudly instead of silently
  changing test behavior.

**License note**: `mpl-core`'s crates.io metadata lists a `non-standard`
license. The on-chain binary is fetched into an ephemeral CI environment for
test purposes only, is never committed to this repository, and is never
redistributed; this is flagged here for owner/legal awareness rather than
resolved unilaterally.

**Follow-up alternative** (not implemented in this PR): build
`programs/mpl-core` from source at commit
`33eaba4d1cc792f79ee1107a290375efe144dbb2` (the exact commit the `0.11.2`
client was published from) via `cargo build-sbf`, which would remove the
dependency on a live mainnet RPC endpoint during CI. This was not attempted
in 2D3A1 because that commit could not be located in the public commit
history returned by the GitHub API within this proof pass (404); resolving
that discrepancy with Metaplex is tracked as a follow-up rather than blocking
this PR.

## How the binary is loaded

`Anchor.toml` declares:

```toml
[[test.genesis]]
address = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
program = "vendor/mpl-core/mpl_core_program.so"
```

`anchor test` starts `solana-test-validator` with this binary loaded at
genesis, at its real mainnet program ID, before any Rodeo test runs.

## Test profile

A new `RODEO_TEST_SUITE=mplcore` profile (mirroring the existing `epoch` and
`claim` profiles) runs `tests/integration/localnet-mpl-core.test.ts`, which
proves only that the genesis-loaded program is present, executable, and
owned by the BPF Upgradeable Loader. It does not create, transfer, or burn
any Metaplex Core asset -- that is 2D3A2's scope.

## Why the `anchor` feature is disabled

Rodeo itself remains an Anchor 0.31.1 program. Only `mpl-core`'s optional
`anchor` feature is disabled. We do this because:

- The `anchor` feature pulls `anchor-lang` macros and `Account<BaseAssetV1>`
  wrappers into `mpl-core`, which is unnecessary for `rodeo_core`.
- All CPI builders (`CreateV2CpiBuilder`, `TransferV1CpiBuilder`,
  `BurnV1CpiBuilder`, `CreateCollectionV2CpiBuilder`, `UpdateV1CpiBuilder`,
  etc.) live in `mpl_core::generated::instructions` and are independent of the
  `anchor` feature.
- Core account parsing is done manually via `BaseAssetV1::load` (the
  `SolanaAccount` Borsh path) rather than `Account<'info, BaseAssetV1>`.
- This avoids an unnecessary Anchor-specific MPL Core integration layer while
  retaining the exact Core APIs Rodeo needs for 2D3A2–2D3A4.

The workspace still depends on `anchor-lang 0.31.1` and `anchor-spl 0.31.1`
for Rodeo's own instructions and SPL token wrappers.

## SBF stack safety and the mpl-core fork

`mpl-core 0.11.2` contains an SBF stack-frame overflow in
`mpl_core::hooked::plugin::registry_records_to_plugin_list`. Under
platform-tools v1.52 (Rust 1.89.0) the linker reports:

```text
Stack offset of 4184 exceeded max offset of 4096 by 88 bytes,
please minimize large stack variables.
Estimated function frame size: 4224 bytes.
```

The overflow is inside `mpl-core` itself and persists when the `anchor`
feature is disabled.

### Fork provenance

- **Official upstream repository:** https://github.com/metaplex-foundation/mpl-core
- **Upstream base/version:** `0.11.2`
- **Exact upstream base commit (from `.cargo_vcs_info.json`):**
  `33eaba4d1cc792f79ee1107a290375efe144dbb2`
- **Rodeo fork URL:** https://github.com/RodeoOnSolana/mpl-core
- **Exact pinned patch commit:** `e31f5de77a0bd23793ddf27bc887dc675ecaec75`
- **Modified production file:** `src/hooked/plugin.rs`
- **Patch summary:** `registry_records_to_plugin_list` rewritten from a
  `try_fold` closure to a plain `for` loop that mutates one `PluginsList` in
  place.
- **Reason for patch:** eliminates the SBF stack-frame overflow caused by the
  `try_fold` closure keeping the accumulator `PluginsList` and the `Plugin`
  deserialization on the same stack frame.
- **Before stack diagnostic:**
  `Stack offset of 4184 exceeded max offset of 4096 by 88 bytes`
- **After stack result:** zero `Stack offset ... exceeded max offset` or
  `overwrites values in the frame` diagnostics across default, epoch, claim,
  and mpl-core SBF build profiles.
- **Semantic parity tests:** included in the fork; run by `cargo test --lib`
  in `RodeoOnSolana/mpl-core`. They compare the same fixture vectors through
  both the original `try_fold` and patched `for` loop implementations and
  cover:
  - `empty_registry_returns_default`
  - `one_known_plugin_populates_correct_field`
  - `multiple_known_plugins_populate_correct_fields`
  - `three_permanent_plugins_are_recognized`
  - `unknown_plugin_type_is_skipped`
  - `malformed_plugin_data_returns_error`
  - `out_of_range_offset_panics_same_as_upstream`
- **Upstream issue:** https://github.com/metaplex-foundation/mpl-core/issues/299
- **Removal condition:** delete the `[patch.crates-io]` override once an
  official `mpl-core` release:
  - contains an equivalent stack-safe fix for `registry_records_to_plugin_list`,
  - remains compatible with Rodeo's Anchor 0.31.1 / `solana-program 2.2.x`
    dependency graph, and
  - passes the full Rodeo CI/SBF stack-safety guard.

### `Cargo.toml` pinning

Workspace root (`Cargo.toml`):

```toml
[patch.crates-io]
mpl-core = { git = "https://github.com/RodeoOnSolana/mpl-core", rev = "e31f5de77a0bd23793ddf27bc887dc675ecaec75" }
```

`programs/rodeo_core/Cargo.toml`:

```toml
mpl-core = { version = "=0.11.2", default-features = false }
```

## 2D3A1 final state

- **2D3A1 merge commit:** `91048124aa94daa78f16f06cc788a1aa1d744dcd`
- **Main CI run:** https://github.com/RodeoOnSolana/Rodeo/actions/runs/31463659875 — `success`
- **Solana CLI:** `v2.2.20`
- **platform-tools:** `v1.52`
- **Anchor:** `0.31.1`
- **solana-program:** `2.2.1`
- **mpl-core:** `0.11.2` (patched fork `RodeoOnSolana/mpl-core` at `e31f5de77a0bd23793ddf27bc887dc675ecaec75`)
- **Upstream issue:** https://github.com/metaplex-foundation/mpl-core/issues/299
- **MPL Core program ID:** `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`
- **Localnet Core binary SHA256:** `f03e75373ae9cae07b5875f7818c55147b73c5607ca0f96968bab93cd583dc6e`
- **SBF stack-safety result:** zero `Stack offset ... exceeded max offset` and zero `overwrites values in the frame` diagnostics across default, epoch, claim, and mpl-core build profiles.
- **Anchor 0.31.1 status:** Rodeo remains an Anchor 0.31.1 program. Only `mpl-core`'s optional `anchor` feature is disabled; Rodeo uses `mpl-core`'s generated CPI builders directly and parses Core accounts via `BaseAssetV1::load` / `SolanaAccount` Borsh deserialization.

2D3A1 is complete and merged to `main`. 2D3A2 (receipt lifecycle proof) must not begin until explicitly scoped.
