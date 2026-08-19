# Rodeo real Switchboard devnet smoke test

Branch: `phase-3/bull-registry-mint-theft`
Date: 2026-08-17

## Summary

A production (non-`mock-randomness`) build of `rodeo_core` was deployed to a temporary
identity on Solana devnet, initialized with the real Switchboard On-Demand
randomness provider, and exercised through the full commit → reveal → settle flow.
All on-chain security checks behaved as designed. No outcome-selection or replay
paths succeeded.

## Identities and dependencies

| Item | Value |
|------|-------|
| Canonical production `rodeo_core` program ID | `CdEU5FfgsPgrPMMLsDAPY29sN4sWqZpMetAXVY633NhA` |
| Temporary devnet `rodeo_core` program ID | `EHaQcMmf9AtbCSLYct9ZoGwoLfGkb9B64nYCqRpM86ks` |
| Devnet payer/deployer wallet (public key only) | `FFZwNMcRoMBu75kP8fpQJKPMubtQSPepPyKfFTvzkSQ6` |
| Switchboard On-Demand Rust crate | `switchboard-on-demand` `0.13.0` |
| Switchboard TS SDK | `@switchboard-xyz/on-demand` `3.10.6` |
| Switchboard Common SDK | `@switchboard-xyz/common` `5.8.5` |
| Switchboard devnet program | `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` |
| Selected Switchboard oracle | `6zNYHErDrEwFJnVESwwMBvJE8tp2AUNypnNWviVHLefz` |

## Transaction sequence

| Step | Signature | Slot | Local block time (UTC-5) |
|------|-----------|------|--------------------------|
| Program deploy | `5a2Vuu2xQJ8NDWehf3DdvDvpJbHJNZizPxK6KsknM5B5L3bFRNvERGS5SyTwnWeWyHBJaFNgGBgosQ5eEjrECA89` | 484880289 | 15:31:18 |
| Initialize protocol + create receipt collection | `krCGpxeAZNfjgKgsDDQ2HnfznmJp5Y5iFsJ9cBA3j7UTLPNUwtUrDiSbH8gai56Nv7cJXHdJyLceXTCia5CLnN4` | 484880342 | 15:31:32 |
| 1. Create + commit Switchboard randomness account | `21RxJhBqR3xqdgHdSH2E4eUShEaTC87EKbQsgVrRK3J8EUMtXzAo6ykbKgrycCprENvHQzWVWYcDba3umsYxmtxr` | 484885102 | 15:52:36 |
| 2. Rodeo `stakeAndCommit` (player irreversibly committed) | `4cDBd4TcpA3bV63AZVpey8CR9HEt4XuZ7ySzXj2cwTHRiKMu2pKe9o8CnwZPw8ZPuaBXLLRJg8HMh4sv1Qvqh33s` | 484885105 | 15:52:37 |
| 3. First `settleReveal` (before fulfillment) — rejected | (failed tx, see logs below) | — | — |
| 4. Reveal + settle in one transaction | `5mf1bT8mkLG2sNnbv3ChPaifiMC6nW1e7pN85HQArAtTs3ESDJ5SiAGA95MYvn2TvepTvdNwzJjmRPRaPiwUJL9p` | 484885122 | 15:52:42 |

## Fairness chronology

* **T1 — player commitment:** `stakeAndCommit` lands at slot **484885105**.
  At that slot the Switchboard randomness account has been committed but not yet
  revealed, so `RandomnessAccountData::get_value(clock.slot)` fails. The Rodeo
  program stores `committed_slot = 484885102` and the provider account pubkey.
* **T2 — randomness request commitment:** The Switchboard `randomnessCommit`
  instruction lands at slot **484885102**, before the Rodeo stake.
* **T3 — randomness becomes knowable:** The oracle publishes the reveal value
  inside the same transaction as settlement. The reveal instruction updates the
  account's `reveal_slot` to the current slot.
* **T4 — Rodeo consumes the value:** The settlement instruction runs in the same
  transaction as the reveal, after the reveal has written the value. The program
  verifies `seed_slot == committed_slot` and that `get_value(clock.slot)` succeeds.

Because `get_value` only succeeds at the exact `reveal_slot`, the player cannot
settle before the reveal, and the program only accepts the value corresponding
to the originally committed `seed_slot`. A dedicated adversarial test confirmed
that attempting to reveal a randomness account and *then* bind it to a fresh Rodeo
action in the same transaction is rejected with `RandomnessNotResolved`.

## Result of successful settle

* Position: `GRdSUNM1zVb3psNeYrVGKvoqYksyik4ccFn83u5DuMvj`
* Receipt asset: `7D3L4y2sorMoXKNQv8QGkhBjP3FoPRnqwWLhJ5oioFkB`
* Role: Cowboy
* Cowboy kind: rank 5
* Suit: hearts
* Switchboard random output (hex): `c96646ae4570af42a5452642caf54ae3ad6a34a080128d17cff0dd351be0268f`
* Compute units consumed by reveal+settle transaction: **126,809**

## Security matrix results

| Test | Expected | Observed on-chain | Status |
|------|----------|-------------------|--------|
| Unresolved randomness rejection | `settleReveal` fails before fulfillment | `RandomnessNotReady` (6050): "Randomness result is not yet available." | PASS |
| Fulfilled same request retry | `settleReveal` succeeds after reveal | Position settled as Cowboy | PASS |
| Outcome shopping (reveal then bind new action) | Rejected | `RandomnessNotResolved` (6098): "The Switchboard randomness account has not yet been revealed for this slot." | PASS |
| Fake provider account A — system-owned | Rejected | `InvalidProviderAccount` (6097) | PASS |
| Fake provider account B — wrong-program-owned | Rejected | `InvalidProviderAccount` (6097) | PASS |
| Replay settled action | Rejected | `AccountNotInitialized` (3012) because `pending_randomness` is closed | PASS |
| Cross-position binding with mismatched randomness | Rejected | `InvalidProviderAccount` (6097): stored provider account does not match | PASS |
| Common-settlement parity | Off-chain mapping matches on-chain outcome | Cowboy/rank5/hearts matched exactly | PASS |

## Outcome-shopping proof

An adversarial transaction was built as `[Switchboard revealIx, Rodeo stakeAndCommit]`.
After the reveal instruction executes, `get_value(clock.slot)` succeeds, so the
program correctly refuses to let a new action bind to that randomness:

```text
Program log: AnchorError thrown in programs/rodeo_core/src/lib.rs:347.
Error Code: RandomnessNotResolved. Error Number: 6098.
Error Message: The Switchboard randomness account has not yet been revealed for this slot.
```

This demonstrates the fairness invariant: a player cannot observe a resolved value
and then choose whether to take a Rodeo action against it.

## Common-settlement parity proof

The 32-byte Switchboard output from the successful settle was fed through the
same TypeScript probability mapping used by the SDK and local tests:

```
random output: c96646ae4570af42a5452642caf54ae3ad6a34a080128d17cff0dd351be0268f
mapped role:  cowboy
mapped rank:  rank5
mapped suit:  hearts
on-chain role: cowboy
on-chain kind: rank5
on-chain suit: hearts
```

This confirms the provider is used only as a source of randomness; the outcome
mapping is the same single implementation used in local mock tests.

## What was not tested on devnet

* **Timeout + late fulfillment:** the production `recover_reveal_timeout` window
  is far longer than a practical devnet smoke test. This path is covered by the
  local Rust tests and mock integration tests.
* **Real-provider Unstake:** `request_unstake` requires the position to satisfy
  the minimum stake age, which is also production-length on the deployed binary.
* **Real-provider Bull Reveal:** Bull outcomes require a fully staged
  `BullProofBuffer`. Building one on devnet would consume significantly more SOL
  than the remaining wallet balance and would not add new information about the
  randomness provider path.
* **Worst-case J1 CU with real provider:** not measured because no Bull reveal was
  executed on devnet. The Cowboy path consumed 126,809 CU.

## Oracle samples

* Randomness accounts committed on devnet during this run: **4**
* Successful real-provider settlements: **1** (Cowboy)

## Devnet SOL balance

* Starting balance before this test run: ~1.65 SOL
* Ending balance after all security tests: **1.436011679 SOL**
* Temporary devnet program closed and **8.10381336 SOL reclaimed**
* Final devnet wallet balance: **9.539820039 SOL**

## Second run: timeout, recovery, and late-fulfillment invariants

This run reused the existing temporary `FRuP...` deployment instead of redeploying. It targeted the `Timeout and recovery` suite in `devnet-switchboard.test.ts` and did not reopen the previously accepted Reveal security cases.

### Deployment preflight

| Item | Value |
|------|-------|
| Temp `rodeo_core` program ID | `FRuP5DDR7g2pc8aHs6m5FYYzCeij9ZZwS41eJFogfRB7` |
| ProgramData address | `Fk4zFNndbTQqYqkZydg99VR6utHcK5sLGkJmnc7f2E22` |
| Devnet payer/deployer | `FFZwNMcRoMBu75kP8fpQJKPMubtQSPepPyKfFTvzkSQ6` |
| Selected Switchboard oracle | `Hdu1niJgqVGhesoxgy37p6WBunVDoBacZJZVK7VRRevg` |
| Deployed binary SHA256 | `69978741dd5f284794e7bdebfc164a4e5997c82259bbed1687c163fbd69c518f` |
| Build features | `test-short-timeout` only |
| `mock-randomness` | disabled |
| `test-fixtures` | disabled |
| Production `MIN_STAKE_SECONDS` | `86_400` (24 hours) — not shortened |
| Last deployed slot | 484943551 |
| ProgramData balance | **8.13577368 SOL** |
| Payer balance before this run | **1.371010599 SOL** |

### Timeout / recovery

A legitimate `stakeAndCommit` was left to time out on the 2-second `test-short-timeout` build. `recoverRevealTimeout` succeeded after the timeout, closing the Position, PendingRandomness, and ReceiptFunder and refunding the 100,000 RODEO principal. No BullRegistry mutation or receipt was created.

| Step | Signature | Notes |
|------|-----------|-------|
| stakeAndCommit | `2S9Zrz97kTquYwnHPbMx4cCAiz39FGQMwxX6aUs7oz8r3w52zQXCUcE7DoRuWeo9roANd7k89pNwpvsYqo7hT3Xg` | Created Position and PendingRandomness |
| recoverRevealTimeout | `4VeQn21a3t4fVi86p6o74FANKwcsEb93MBiQEmHEUAFhQUuuL2oTBJcSN7mKQzKhkg5RNYpUfu9xAs3KdiSwUxu5` | Closed Position/PendingRandomness/ReceiptFunder and refunded principal |

State after recovery:

* `Position` account: **closed (null)**
* `PendingRandomness` account: **closed (null)**
* `ReceiptFunder` account: **closed (null)**
* `ReceiptAsset`: **not created**
* `BullRegistry`: unchanged
* Principal returned to owner

### Never-fulfilled provider recovery

The timeout recovery test above is the explicit never-fulfilled case: the Switchboard randomness request was committed but intentionally never revealed, the Rodeo timeout elapsed, and the player successfully recovered principal. The protocol does not trap the player when the provider never completes.

### Late fulfillment cannot resurrect

After the timeout recovery closed the action, a separate, freshly fulfilled Switchboard randomness account was used to attempt `settleReveal` against the recovered Position. The program rejected the late settlement because the Position was already closed.

| Step | Signature / log | Notes |
|------|-----------------|-------|
| stakeAndCommit | `RHfNYz7iajZKttcLaGp7ihCEHtMZ1KA5kW3rLgVdebCpiQobRXUk1pyef7ivSbzDsWdmr3YjNHNizra5qz51NKb` | Created a fresh Position and PendingRandomness |
| recoverRevealTimeout | (within same test) | Recovered after 2-second timeout; Position closed |
| Late settleReveal | logs included `AnchorError caused by account: position. Error Code: AccountNotInitialized. Error Number: 3012. ... Program FRuP... failed: custom program error: 0xbc4` | Rejected; consumed 9111 CU |

Security property: **no valid Switchboard result can resurrect a recovered Rodeo action** — the old action remains dead.

### Real-provider Unstake gate: completed on a new short-min-stake deployment

The `FRuP...` binary was built with `test-short-timeout` only and `MIN_STAKE_SECONDS = 86_400` (24 hours). To complete the real-provider Unstake gate without waiting a full day, a new isolated temporary deployment was created with an additional `test-short-min-stake` feature that lowers `MIN_STAKE_SECONDS` to 10 seconds. The `FRuP...` program was closed after the new deployment produced the Unstake evidence. See the Third run below for the complete Unstake chronology.

### Devnet SOL balance (this run)

| Checkpoint | Balance |
|------------|---------|
| Before timeout/recovery tests | 1.371010599 SOL |
| After timeout/recovery tests | 1.338056559 SOL |
| After late-fulfillment test | 1.321582039 SOL |

### Net cost summary (second run only)

* Transaction/oracle rent fees consumed: ~0.04943 SOL
* `FRuP...` deployment rent reclaimed: **8.13577368 SOL** (closed after Unstake evidence was captured)

## Third run: real-provider Unstake with short-min-stake

This run used a fresh temporary deployment `AqV3NnU4GhCWreAnmqnyRaXjjii9DcmrqWjf4vcZEqM7` with the `test-short-min-stake` compile-time feature enabled. It exercised the complete real-provider Reveal → Active → `request_unstake` → Switchboard reveal → `settle_unstake` lifecycle.

### Deployment preflight

|| Item | Value |
|------|-------|
|| Temp `rodeo_core` program ID | `AqV3NnU4GhCWreAnmqnyRaXjjii9DcmrqWjf4vcZEqM7` |
|| ProgramData address | `3EDih58fQVdYDgi76Cy8DaY9zBWGmtveJ8F4P1Re57ai` |
|| Devnet payer/deployer | `FFZwNMcRoMBu75kP8fpQJKPMubtQSPepPyKfFTvzkSQ6` |
|| Deployed binary SHA256 | `7524e81d0c320afe83dbf80cb1be6086dea074b7b62c83a0a0166f8935378f39` |
|| Build features | `test-short-timeout`, `test-short-min-stake` |
|| `mock-randomness` | disabled |
|| `test-fixtures` | disabled |
|| Production `MIN_STAKE_SECONDS` | `86_400` (unchanged in default build) |
|| Shortened `MIN_STAKE_SECONDS` | `10` seconds (test feature only) |

### Unstake chronology

|| Step | Signature | Notes |
|------|-----------|-------|
|| stakeAndCommit | `5i6NR2PEi2ZQhFYw94YNueNqFH4VQxf2TnzgoXReYJaZnPsqy3EUnijaNaxyxhpMLy46xEeT1jPcKQxSdgbhKEXL` | Created Position with 100,000 whole RODEO (100,000,000,000 atomic, 6 decimals) principal |
|| reveal+settle | `1LTdCENyxGWBpcaBCQk9uBXz1KqiS6KRbWDfuPTHbodCUZ7RcTJ5JEZVDVYAVbUwsrts2vrKPRC2LPV3vij3FKj` | Settled as Cowboy; CU: 128,338 |
|| request_unstake | `33vaDUMsdK7N1bmN5E9mX4sRNRihf7Tx74qufpkPjJznEiyoTyF3bDFxDCkZ7euFY24QTCfoeedSkEm2ZYrjYAJC` | Opened Unstake PendingRandomness |
|| settle_unstake | `Ak4Ysk3Yn5LKyehTS2mmabHL8xpmpdymppH4owjsRsrhRLcrQLxhT86rg4UnbGaoKHPWzRyjQmExiNJkev5TnoS` | Real Switchboard reveal + settle; CU: 114,630 |

### Settle result

* Position: closed
* Role: Cowboy
* `activeSince`: `1787029393`
* `unstakeEligibleAt`: `1787029403` (10 seconds later, via `test-short-min-stake`)
* Switchboard random output (hex): `86f4aec00c7985c09f24190dff7d5e82738742340721d5719ba4ca1257d860a0`
* Expected Unstake theft: `false`
* ANSEM fate: ToOwner

### Economics

Using the historical `unstake_return_bps = 9_500` and `unstake_tax_bps = 500` on RODEO with 6 decimals (`1` whole = `1_000_000` atomic):

* Principal staked (raw/atomic): `100,000,000,000`
* Principal staked (whole RODEO): `100,000`
* RODEO returned to owner (raw/atomic): `95,000,000,000`
* RODEO returned to owner (whole RODEO): `95,000`
* RODEO burned (raw/atomic): `5,000,000,000`
* RODEO burned (whole RODEO): `5,000`
* ANSEM paid to owner: `0` (no accrued rewards in this isolated run)
* ANSEM routed to Bull pool: `0`
* BullRegistry: unchanged

### Lifecycle and replay

* `Position` account: **closed (null)**
* `PendingRandomness` account: **closed (null)**
* `ReceiptFunder` account: **closed (null)**
* `PositionReceipt` asset: **burned/tombstoned** (MPL Core leaves a 1-byte tombstone, ~2.4M lamports)
* `BullRegistry`: unchanged
* Replay attempt: rejected because the `pending_randomness` account and `position` no longer exist

### Devnet SOL balance (this run)

* Wallet balance before Unstake test: **2.813841585 SOL**
* Wallet balance after Unstake test: **2.778537636 SOL**
* Program close `AqV3...` reclaimed: **8.13577368 SOL**
* Program close `FRuP...` reclaimed: **8.13577368 SOL**
* Final wallet balance: **19.050074996 SOL**

### Net cost summary

|| Category | SOL |
|----------|-----|
|| PROGRAM RENT LOCKED | 16.27154736 |
|| PROGRAM RENT RECLAIMED | 16.27154736 |
|| ORACLE / TX / NONREFUNDABLE COSTS | 8.493994863 |
|| OTHER RENT LOST | 0 |
|| NET SOL CONSUMED | 8.493994863 |

## Files

* Test harness: `tests/integration/devnet-switchboard.test.ts`
* This report: `docs/devnet-switchboard-smoke-test.md`
