# Rodeo Protocol v1 — Public Metrics and Indexing

## Indexer responsibilities

The `apps/indexer` boundary consumes on-chain events and account snapshots and produces a public, queryable view of protocol state. In Protocol v1 it does not implement a persistence backend; the document defines the schema and responsibilities that any backend must satisfy.

## Event sources

The indexer ingests:

- Anchor program event logs from `rodeo_core`, `rodeo_market`, and `rodeo_router`.
- Transaction metadata (signature, slot, timestamp, program IDs).
- Account snapshots for `Position`, `RewardState`, `BullAccumulator`, `RoleStatistics`, and token vault balances.

## Derived tables

### `positions`

| Field | Source |
| --- | --- |
| `position_pda` | on-chain account address |
| `position_id` | `Position.position_id` |
| `owner` | current `Position.owner` |
| `role` | `Position.role` |
| `rank_or_tier` | `Position.rank_or_tier` |
| `suit` | `Position.suit` |
| `principal_atomic` | `Position.principal_amount` |
| `claimable_ansem_atomic` | `Position.claimable_ansem_atomic` |
| `status` | `Position.status` |
| `opened_epoch` | `Position.opened_epoch` |
| `last_claimed_at` | `Position.last_claimed_at` |
| `pending_action_active` | `Position.pending_action_active` |
| `settlement_nonce` | `Position.settlement_nonce` |
| `created_at_slot` | first `PositionStaked` event slot |

### `epochs`

| Field | Source |
| --- | --- |
| `epoch` | `RewardState.current_epoch` or `EpochClosed` events |
| `started_at` | `RewardState.epoch_started_at` |
| `cowboy_emission` | `EpochClosed.cowboy_emission` |
| `suit_vault_contribution` | `EpochClosed.suit_vault_contribution` |
| `free_ansem` | `EpochClosed.free_ansem` |
| `total_cowboy_weight` | `EpochClosed.total_cowboy_weight` |

### `role_statistics`

| Field | Source |
| --- | --- |
| `epoch` | `RoleStatistics.epoch` |
| `cowboy_population` | `RoleStatistics.cowboy_population` |
| `bull_population` | `RoleStatistics.bull_population` |
| `cowboy_principal_atomic` | `RoleStatistics.cowboy_principal_atomic` |
| `bull_principal_atomic` | `RoleStatistics.bull_principal_atomic` |

### `suit_competitions`

| Field | Source |
| --- | --- |
| `competition_epoch` | `SuitCompetitionResultAttested.competition_epoch` |
| `winning_suit` | `SuitCompetitionResultAttested.winning_suit` |
| `merkle_root` | `SuitCompetitionResultAttested.merkle_root` |
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
| `settled` | true after `RandomnessSettled` for the same `(position, action_type, action_nonce)` |
| `provider_request_id` | `RandomnessRequested.provider_request_id` |

## Public dashboards

The following metrics must be publicly queryable or displayed:

| Metric | Definition |
| --- | --- |
| Total RODEO staked | `principal_vault_balance` |
| Total active positions | count of `positions` with `status == Active` |
| Cowboy/Bull split | `RoleStatistics.cowboy_population` / `bull_population` for the current epoch |
| Total ANSEM emitted | `RewardState.ansem_emitted_atomic` |
| Total ANSEM claimed | `RewardState.ansem_claimed_atomic` |
| Unclaimed ANSEM liability | `RewardState.ansem_liability_atomic` |
| Free ANSEM | `reward_vault_balance - ansem_liability_atomic` |
| Runway (epochs) | `covered_epochs` from runway formula in [emissions-and-rewards.md](./emissions-and-rewards.md) |
| Suit vault balance | suit-competition token account balance or derived from events |
| Bull reward pool balance | derived from Bull pool contributions minus Bull claims |
| Marketplace volume | sum of `PositionSold` sale prices |
| RODEO burned (unstake tax + buybacks) | `rodeoBurnedAtomic` from router and unstake events |
| Active mint-theft eligibility | `completed_reveals >= 50 && eligible_bulls >= 3` |
| Latest epoch | `RewardState.current_epoch` |
| Social competition leaderboard | off-chain scoring result file, indexed by `SuitCompetitionResultAttested.merkle_root` |

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
- Social-competition result files (IPFS/Arweea/public repository).
- Merkle root and attestation signatures on-chain.
- Source code and build verification (reproducible builds where possible).

The exact storage backend for off-chain result files is **BLOCKED: OWNER DECISION REQUIRED**.

## Open questions (BLOCKED)

- Indexer database and web framework: **BLOCKED: OWNER DECISION REQUIRED**.
- Off-chain storage for social result files: **BLOCKED: OWNER DECISION REQUIRED**.
- Public API rate limits and caching strategy: **BLOCKED: OWNER DECISION REQUIRED**.
