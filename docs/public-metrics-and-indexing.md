# Rodeo Protocol v1 — Public Metrics and Indexing

## Indexer responsibilities

The `apps/indexer` boundary consumes on-chain events and account snapshots and produces a public, queryable view of protocol state. In Protocol v1 it does not implement a persistence backend; the document defines the schema and responsibilities that any backend must satisfy.

## Event sources

The indexer ingests:

- Anchor program event logs from `rodeo_core`, `rodeo_market`, and `rodeo_router`.
- Transaction metadata (signature, slot, timestamp, program IDs).
- Account snapshots for `Position`, `RewardState`, `GlobalGameState`, `BullAccumulator`, `BullRegistry`, `WalletClaimCooldown`, `PendingRandomness`, `PendingBatch`, and token vault balances.

## Derived tables

### `positions`

| Field | Source |
| --- | --- |
| `position_pda` | on-chain account address |
| `position_id` | `Position.position_id` |
| `owner` | current `Position.owner` |
| `role` | `Position.role` |
| `cowboy_kind` | `Position.cowboy_kind` |
| `suit` | `Position.suit` |
| `principal_atomic` | `Position.principal_amount` |
| `unstake_eligible_at` | `Position.unstake_eligible_at` |
| `claimable_ansem_atomic` | `Position.claimable_ansem_atomic` |
| `status` | `Position.status` |
| `opened_at` | `Position.opened_at` |
| `active_since` | `Position.active_since` |
| `accrual_weight` | `Position.accrual_weight` |
| `buck_power` | `Position.buck_power` |
| `pending_action_active` | `Position.pending_action_active` |
| `settlement_nonce` | `Position.settlement_nonce` |
| `state_version` | `Position.state_version` |
| `created_at_slot` | first `PositionStaked` event slot |

### `epochs`

| Field | Source |
| --- | --- |
| `epoch` | `RewardState.current_epoch` or `EpochClosed` events |
| `started_at` | `RewardState.epoch_started_at` |
| `closed_at` | `EpochClosed.snapshot_timestamp` |
| `cowboy_emission` | `EpochClosed.cowboy_emission` |
| `suit_vault_contribution` | `EpochClosed.suit_vault_contribution` |
| `free_ansem` | `min(reward_vault_balance, recognized_reward_balance) - total_ansem_liability` |
| `total_cowboy_weight` | `EpochClosed.total_cowboy_weight` |
| `total_bull_power` | `EpochClosed.total_bull_power` |
| `recognized_reward_balance_atomic` | `EpochClosed.recognized_reward_balance_atomic` (snapshot) or `RewardState.recognized_reward_balance_atomic` (live) |
| `total_ansem_liability_atomic` | `EpochClosed.total_ansem_liability_atomic` (snapshot) |

`RewardState` is the sole owner of `current_epoch`, `epoch_started_at`, and `last_closed_epoch_timestamp`; no other account duplicates them.

### `global_game_state`

| Field | Source |
| --- | --- |
| `total_completed_reveals` | `GlobalGameState.total_completed_reveals` |
| `live_position_count` | `GlobalGameState.live_position_count` |
| `active_cowboy_count` | `GlobalGameState.active_cowboy_count` |
| `active_bull_count` | `GlobalGameState.active_bull_count` |
| `total_active_cowboy_weight` | `GlobalGameState.total_active_cowboy_weight` |
| `total_active_bull_power` | `GlobalGameState.total_active_bull_power` |
| `current_epoch` | `RewardState.current_epoch` |
| `last_closed_epoch_timestamp` | `RewardState.last_closed_epoch_timestamp` |

### `suit_competitions`

| Field | Source |
| --- | --- |
| `competition_epoch` | `SuitCompetitionResultAttested.competition_epoch` |
| `winning_suits_mask` | `SuitCompetitionResultAttested.winning_suits_mask` |
| `merkle_root` | `SuitCompetitionResultAttested.merkle_root` |
| `content_hash` | `SuitCompetitionResultAttested.content_hash` |
| `total_amount` | `SuitCompetitionResultAttested.total_amount` |
| `total_reward_atomic` | `SuitRewardsDistributed.total_amount` |
| `eligible_positions` | `SuitRewardsDistributed.eligible_positions` |

### `external_revenue_batches`

| Field | Source |
| --- | --- |
| `batch_id` | `ExternalRevenueRouted.batch_id` |
| `source_token` | `ExternalRevenueRouted.source_token` |
| `total_source_atomic` | `ExternalRevenueRouted.total_source_atomic` |
| `ansem_purchased` | `ExternalRevenueRouted.ansem_purchased` |
| `rodeo_burned` | `ExternalRevenueRouted.rodeo_burned` |
| `team_amount` | `ExternalRevenueRouted.team_amount` |
| `security_amount` | `ExternalRevenueRouted.security_amount` |

### `randomness_requests`

| Field | Source |
| --- | --- |
| `position_pda` | `RandomnessRequested.position` |
| `action_type` | `RandomnessRequested.action_type` |
| `action_nonce` | `RandomnessRequested.action_nonce` |
| `committed_slot` | `RandomnessRequested.committed_slot` |
| `committed_protocol_epoch` | `RandomnessRequested.committed_protocol_epoch` |
| `timeout_timestamp` | `RandomnessRequested.timeout_timestamp` |
| `provider_program` | `RandomnessRequested.provider_program` |
| `provider_randomness_account` | `RandomnessRequested.provider_randomness_account` |
| `vrf_key` | `RandomnessRequested.vrf_key` |
| `callback_id` | `RandomnessRequested.callback_id` |
| `registry_root_snapshot` | `RandomnessRequested.registry_root_snapshot` |
| `registry_version_snapshot` | `RandomnessRequested.registry_version_snapshot` |
| `settled` | true after `RandomnessSettled` for the same `(position, action_type, action_nonce)` |

## Public dashboards

The following metrics must be publicly queryable or displayed:

| Metric | Definition |
| --- | --- |
| Total RODEO staked | `accounted_principal_atomic` (sum of `Position.principal_amount` for every live Position) |
| Actual principal-vault balance | `principal_vault_balance` (on-chain token balance of the `PrincipalVault`) |
| Principal vault surplus | `principal_vault_balance - accounted_principal_atomic` |
| Total live positions | `GlobalGameState.live_position_count` |
| Total active positions | count of `positions` with `status == Active` |
| Cowboy/Bull split | `GlobalGameState.active_cowboy_count` / `active_bull_count` |
| Total ANSEM emitted | `RewardState.ansem_emitted_atomic` |
| Total ANSEM claimed | `RewardState.ansem_claimed_atomic` |
| Total unclaimed ANSEM liability | `RewardState.total_ansem_liability_atomic` |
| Recognized reward balance | `RewardState.recognized_reward_balance_atomic` |
| Unrecognized reward surplus | computed dynamically as `reward_vault_balance - recognized_reward_balance_atomic` (not a stored field) |
| Free ANSEM | `min(reward_vault_balance, recognized_reward_balance) - total_ansem_liability_atomic` |
| Runway (epochs) | `covered_epochs` from runway formula in [emissions-and-rewards.md](./emissions-and-rewards.md) |
| Suit vault balance | `RewardState.suit_vault_liability_atomic` |
| Bull reward pool balance | `RewardState.bull_pool_liability_atomic + bull_pool_unallocated_liability_atomic` |
| Marketplace volume | sum of `PositionSold` sale prices |
| RODEO burned (unstake tax + buybacks) | `rodeoBurnedAtomic` from router and unstake events |
| Active mint-theft eligibility | `completed_reveals >= 50 && eligible_bulls >= 3` |
| Latest epoch | `RewardState.current_epoch` |
| Social competition leaderboard | off-chain scoring result file, indexed by `SuitCompetitionResultAttested.merkle_root` and `content_hash` |

## Keeper responsibilities

The `apps/keeper` boundary performs off-chain automation:

- Monitor randomness requests and submit settlement transactions once a valid proof is available.
- Trigger epoch closure after each `EPOCH_DURATION_SECONDS` interval.
- Monitor the treasury router pending batches and execute approved swaps when minimum-output and slippage conditions are met.
- Publish social-competition result files and Merkle roots for oracle attestation.
- Alert on invariant violations.

Keepers are permissionless; any party may run them. They do not hold special authority, but some operations (e.g., social oracle signatures) require multisignature approval.

## Oracle responsibilities

The social oracle:

- ingests X account links and post metadata;
- scores posts off-chain according to the approved algorithm;
- publishes a complete result file;
- computes and signs a Merkle root;
- coordinates multisignature attestation.

The randomness oracle/provider:

- receives on-chain randomness requests;
- returns verifiable random outputs;
- does not custody tokens or control protocol state.

## Public data availability

The protocol requires the following data to be publicly available:

- Complete event history via RPC/block explorer.
- Probability tables and economic constants in this repository.
- Social-competition result files via immutable storage (IPFS or Arweave) plus a public canonical reference.
- Merkle root and content hash published on-chain.
- Source code and build verification (reproducible builds where possible).

The recommended v1 stack is Helius for RPC/webhooks, PostgreSQL for indexed data, TypeScript for indexer/keeper, and IPFS/Arweave for immutable result files.

## Open questions (BLOCKED)

- Public API rate limits and caching strategy: **BLOCKED: OWNER DECISION REQUIRED**.
- Reproducible-build tooling and attestation service: **BLOCKED: OWNER DECISION REQUIRED**.
