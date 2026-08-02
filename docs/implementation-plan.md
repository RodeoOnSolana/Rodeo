# Rodeo Protocol v1 — Implementation Plan

## Phase boundaries

| Phase | Scope | Deliverable |
| --- | --- | --- |
| Phase 0 | Architecture, workspace, SDK generation, local mock randomness, identity-preserving PDA design | Done and merged to `main`. |
| Phase 1 | Definitive protocol specification v1, simulator update, test-plan scaffolding | This branch. No production contract logic. |
| Phase 2 | Implement production instructions in `rodeo_core`, update IDLs and SDK | Follow-up branch from `main` after Phase 1 merges. |
| Phase 3 | Integrate production randomness provider, keeper, and indexer backends | After Phase 2. |
| Phase 4 | Marketplace, treasury router, and governance deployment | After Phase 3. |
| Phase 5 | Frontend, social competition integration, security audit, mainnet deployment | Final phase. |

## Phase 2 recommended implementation order

Implement in the following order so that each layer can be tested before the next is added.

1. **Protocol-definition constants and probability tables**
   - Add whole-token supply and stake helpers, `MIN_STAKE_SECONDS`, tax BPS constants, and runway constants.
   - Add approved integer probability tables.
   - Add accrual weights, buck power, and role/rank/tier/suit outcome mapping.
   - Add `COWBOY_REWARD_INDEX_SCALE` and `REWARD_PER_WEIGHT_SCALE`.
   - Add `Suit` enum, `CowboyKind`, and `OwnershipChangeReason` values.

2. **Economic-simulator updates**
   - Replace the generic event reducer with the approved rules.
   - Implement reveal outcome sampling using the probability tables.
   - Implement claim split, unstake tax/burn, and theft logic.
   - Implement epoch emissions and lazy Cowboy/Bull reward accounting.
   - Add property tests for every invariant.

3. **On-chain account schema extensions**
   - Extend `Position` with `cowboy_kind`, `suit`, `claimable_ansem_atomic`, `active_since`, `unstake_eligible_at`, `opened_at`, `last_cowboy_reward_index`, `last_bull_reward_per_weight`, `buck_power`, and `accrual_weight`.
   - Extend `RewardState` with explicit ANSEM liability buckets (`total_ansem_liability_atomic`, `cowboy_unmaterialized_liability_atomic`, `position_claimable_liability_atomic`, `bull_pool_liability_atomic`, `bull_pool_unallocated_liability_atomic`, `suit_vault_liability_atomic`), `recognized_reward_balance_atomic`, `unrecognized_reward_surplus_atomic`, `cowboy_reward_index`, and `suit_epoch`.
   - Add `GlobalGameState` account with live counters and `accounted_principal_atomic`.
   - Add global `BullAccumulator` account with `cowboy_reward_index` and `reward_per_weight_scaled`.
   - Add `BullRegistry` and `BullRegistryNode` design-proposal accounts for sortition.
   - Add per-source-mint `PendingBatch` accounts (Phase 4).

4. **BullRegistry design gate**
   - Finalize `BullRegistry` and `BullRegistryNode` account sizes, page capacity, and proof format.
   - Model worst-case compute cost for mint-theft selection.
   - Get owner approval before implementing the reveal instruction that uses mint theft.

5. **Reveal and randomness instructions (without mint theft selection until registry approved)**
   - Implement `request_reveal` (commit) and `settle_reveal` with outcome mapping for role, rank/tier, and suit.
   - Keep local mock randomness for tests behind a feature flag or a separate test-only path.
   - Do not integrate a production oracle in Phase 2; use the mock or a deterministic test harness that satisfies the same interface.
   - Mint theft remains blocked behind the BullRegistry gate.

6. **Claim instructions**
   - Implement wallet-level one-hour cooldown.
   - Implement normal Cowboy and Desperado splits.
   - Implement Bull reward pool claim using reward-per-buck-power.

7. **Unstake instruction**
   - Implement minimum stake period check using `Position.unstake_eligible_at`.
   - Implement `request_unstake` (commit) and `settle_unstake`.
   - Do not implement `cancel_unstake_request`; once committed, an unstake settles or timeout-recovers.
   - Implement 5% RODEO tax and burn, 95% return; burn amount = principal - returned.
   - Implement normal Cowboy unstake 100/0 outcome: 95% of the time pending ANSEM is paid to the owner, 5% of the time it is reclassified to the Bull pool. Desperado is immune.
   - Implement Bull reward settlement before account close.

8. **Ownership transfer primitives**
   - Extend `transfer_position` with forced settlement of pending ANSEM.
   - Add receipt asset check.
   - Keep marketplace listing/sale as a Phase 3/4 deliverable; Phase 2 only ensures the ownership-transfer primitive is correct.

9. **Epoch closure and reward recognition**
   - Implement permissionless `close_epochs(max_epochs)` with batched processing.
   - Compute free ANSEM, epoch emission, and Cowboy/suit split using per-epoch snapshots.
   - Update global `cowboy_reward_index` and `GlobalGameState` counters.
   - Implement permissionless `recognize_rewards` after catch-up for ANSEM that arrived after elapsed boundaries.
   - Track `unrecognized_reward_surplus_atomic` and ensure it never funds emissions before recognition.

10. **SDK and integration tests**
    - Regenerate IDLs and SDK clients after each program change.
    - Add integration tests for every new instruction and every error path.
    - Add invariant assertions to integration tests.

11. **Security review and audit preparation**
    - Threat-model randomness settlement ordering, oracle timeout, and marketplace atomicity.
    - Verify account sizes with new fields.
    - Run fuzz/property tests against the simulator.

## What Phase 2 must not do

- Integrate a production randomness provider (Phase 3).
- Implement mint-theft recipient selection until the `BullRegistry` design is approved.
- Implement the full marketplace listing/escrow/sale engine (Phase 3/4).
- Implement the treasury router swap integrations (Phase 4).
- Implement social scoring or oracle attestation (Phase 4/5).
- Make any economic parameter admin-configurable.

## Acceptance criteria for Phase 2

- All approved economic rules are implemented in `rodeo_core`.
- Integration tests pass on localnet for stake, reveal, claim, unstake, transfer, and epoch closure.
- Simulator and on-chain behavior match for a generated event trace.
- Security invariants from [security-invariants.md](./security-invariants.md) are asserted in tests.
- No new admin-controlled economic parameters are introduced.

## Phase 3–5 previews

### Phase 3: Production randomness and keeper

- Finalize and integrate the `BullRegistry` sortition tree.
- Select and integrate a reviewed randomness provider.
- Implement commit/settle timeout recovery.
- Build keeper bots for settlement and epoch closure.
- Add oracle outage simulations to integration tests.

### Phase 4: Marketplace and treasury router

- Implement atomic marketplace listing, sale, and gift.
- Implement `rodeo_router` with per-source-mint `PendingBatch` accounts, approved venues, and slippage protection.
- Implement governance multisig and timelock accounts.

### Phase 5: Frontend, social, audit, launch

- Build web frontend.
- Implement X-account linking and social-competition scoring pipeline.
- Conduct security audit and formal verification where feasible.
- Deploy to mainnet under governance.

## Open questions (BLOCKED)

See individual sub-documents. The most urgent Phase 2 blockers are:

- Final `BullRegistry` design, account sizes, page capacity, Merkle-sum proof format, and maximum supported Bull population.
- Exact `PendingBatch` schema per source mint.
- Exact Metaplex Core plugin and receipt-authority PDA configuration.
- Maximum balance/supply bounds for account sizing.
