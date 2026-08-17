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

## Files

* Test harness: `tests/integration/devnet-switchboard.test.ts`
* This report: `docs/devnet-switchboard-smoke-test.md`
