# Rodeo Protocol v1 — Account Model

## PDA derivations

All program addresses are deterministic PDAs. Seed arrays use raw byte literals and fixed-width little-endian integers.

| Account | Seeds | Notes |
| --- | --- | --- |
| `GlobalConfig` | `[b"global-config"]` | Singleton. Immutable after initialization. |
| `PrincipalVault` (token account) | `[b"principal-vault"]` | Holds all staked RODEO principal. Authority is `GlobalConfig`. |
| `RewardVault` (token account) | `[b"reward-vault"]` | Holds ANSEM rewards. Authority is `GlobalConfig`. |
| `Position` | `[b"position", global_config.key().as_ref(), &position_id.to_le_bytes()]` | Identity does not depend on owner. |
| `PositionReceipt` (Metaplex Core Asset) | `[b"receipt", position.key().as_ref()]` | One per position; delegates controlled by Rodeo. Created at reveal settlement. |
| `Listing` | `[b"listing", position.key().as_ref(), &listing_nonce.to_le_bytes()]` | Non-custodial listing PDA. Invalidated by `state_version`/`listing_nonce`. |
| `WalletClaimCooldown` | `[b"claim_cooldown", global_config.key().as_ref(), wallet.key().as_ref()]` | Tracks last claim timestamp per wallet. |
| `RewardState` | `[b"reward-state", global_config.key().as_ref()]` | Epoch, emissions, and explicit ANSEM liability buckets. |
| `GlobalGameState` | `[b"global-game-state", global_config.key().as_ref()]` | Live protocol counters. |
| `BullAccumulator` | `[b"bull-accumulator", global_config.key().as_ref()]` | Global reward-per-buck-power accumulator. |
| `BullRegistry` | `[b"bull-registry", global_config.key().as_ref()]` | Root and metadata for the sortition tree. |
| `BullRegistryNode` | `[b"bull-node", registry.key().as_ref(), &node_id.to_le_bytes()]` | Pages of the two-level sum tree. |
| `PendingRandomness` | `[b"randomness", position.key().as_ref(), &[action_type as u8], &action_nonce.to_le_bytes()]` | One per outstanding randomness action. |
| `PendingBatch` (per source mint) | `[b"pending-batch", global_config.key().as_ref(), source_mint.key().as_ref()]` | Accumulated source-token revenue awaiting routing. |
| `SocialResult` (per suit epoch) | `[b"social-result", global_config.key().as_ref(), &suit_epoch.to_le_bytes()]` | Attested suit-competition result. |

## Account schemas

### `GlobalConfig`

```rust
pub struct GlobalConfig {
    pub version: u8,                 // ACCOUNT_VERSIONS.globalConfig
    pub rodeo_mint: Pubkey,
    pub ansem_mint: Pubkey,
    pub rodeo_decimals: u8,          // read from mint at init; immutable
    pub ansem_decimals: u8,          // read from mint at init; immutable
    pub stake_amount_atomic: u64,    // 100,000 * 10^rodeo_decimals
    pub expected_total_supply_atomic: u64, // 1,000,000,000 * 10^rodeo_decimals
    pub launch_timestamp: i64,
    pub principal_vault: Pubkey,
    pub reward_vault: Pubkey,
    // Governance-protected pause flags (Emergency Guardians only)
    pub pause_new_stakes: bool,
    pub pause_new_reveal_requests: bool,
    pub pause_new_marketplace_listings: bool,
    pub pause_router_swaps: bool,
    pub upgrade_council: Pubkey,       // 3-of-5 Squads multisig
    pub treasury_council: Pubkey,      // 3-of-5 Squads multisig
    pub emergency_guardians: Pubkey,   // 2-of-3 multisig
    pub bump: u8,
    pub principal_vault_bump: u8,
    pub reward_vault_bump: u8,
}
```

Token mint addresses, decimals, stake amount, and expected supply are supplied at production initialization and become immutable in this account. Economic constants are code-enforced; a program upgrade can change code constants, but only through the governance-protected upgrade process. Pause flags may be toggled by Emergency Guardians within their action-specific scope.

### `RewardState`

```rust
pub struct RewardState {
    pub version: u8,                 // ACCOUNT_VERSIONS.rewardState
    pub global_config: Pubkey,
    pub current_epoch: u64,
    pub epoch_started_at: i64,
    // ANSEM liability buckets (sum == total_ansem_liability_atomic)
    pub total_ansem_liability_atomic: u64,
    pub cowboy_unmaterialized_liability_atomic: u64,  // owed to active Cowboys, not yet synced
    pub position_claimable_liability_atomic: u64,      // owed to specific positions
    pub bull_pool_liability_atomic: u64,               // allocated to active Bulls
    pub bull_pool_unallocated_liability_atomic: u64,   // allocated to Bull pool while no eligible Bull set
    pub suit_vault_liability_atomic: u64,             // reserved for suit competitions; authoritative suit reservation
    // Vault accounting
    pub recognized_reward_balance_atomic: u64,      // ANSEM in RewardVault recognized for liability accounting
    pub unrecognized_reward_surplus_atomic: u64,    // ANSEM in RewardVault not yet recognized
    // ANSEM flows
    pub ansem_emitted_atomic: u64,
    pub ansem_claimed_atomic: u64,
    // Scaled global accumulators
    pub cowboy_reward_index: u128,                    // scaled by COWBOY_REWARD_INDEX_SCALE
    pub suit_epoch: u64,
    pub bump: u8,
}
```

`bull_reward_per_weight_scaled` is kept in `BullAccumulator`, not duplicated in `RewardState`. Scaled-accumulator rounding remainders stay in the global index value and are not tracked as separate liabilities.

### `Position`

```rust
pub struct Position {
    pub version: u8,                 // ACCOUNT_VERSIONS.position (3)
    pub owner: Pubkey,               // mutable
    pub position_id: u64,
    pub principal_amount: u64,       // always STAKE_AMOUNT_ATOMIC while active; 0 only transiently before close
    pub role: Role,                  // Unassigned | Cowboy | Bull
    pub status: PositionStatus,      // RevealPending | Active
    pub cowboy_kind: CowboyKind,     // Unassigned | Rank(u8) | Desperado
    pub suit: Suit,                  // 0 until revealed; Hearts | Diamonds | Clubs | Spades
    pub opened_at: i64,
    pub active_since: i64,           // reveal settlement timestamp; 0 until revealed
    pub unstake_eligible_at: i64,   // active_since + 24 hours; reset on sale/gift/theft
    pub accrual_weight: u32,         // Cowboy rank weight (ACCRUAL_WEIGHT_SCALE base)
    pub buck_power: u8,              // Bull tier power
    pub last_cowboy_reward_index: u128,
    pub last_bull_reward_per_weight: u128,
    pub claimable_ansem_atomic: u64, // accrued but unclaimed ANSEM
    pub settlement_nonce: u64,       // increments on every settled randomness action
    pub state_version: u64,          // increments on every ownership-changing event; invalidates stale listings
    pub listing_nonce: u64,          // current listing counter
    pub receipt_asset: Pubkey,       // Metaplex Core Asset address, created at reveal settlement
    pub pending_action_active: bool,
    pub pending_action_type: ActionType,
    pub pending_action_nonce: u64,
    pub next_action_nonce: u64,
    pub bump: u8,
}
```

`state_version` increments every time ownership or fundamental state changes (sale, gift, mint theft, unstake closure). Listings store the `state_version` and `listing_nonce` observed at listing time; a settlement instruction verifies the stored values match the live `Position` to prevent stale-listing settlement.

`receipt_asset` is empty until reveal settlement, when the Metaplex Core Asset is created directly for the final owner. The receipt is created frozen with:
- `PermanentTransferDelegate` controlled by the Rodeo receipt-authority PDA;
- `PermanentFreezeDelegate` controlled by the same PDA and `frozen=true`;
- `PermanentBurnDelegate` controlled by the same PDA.

The receipt remains frozen for its entire lifetime. Rodeo transfers or burns it through the permanent delegates.

Claim cooldown is enforced through the `WalletClaimCooldown` PDA, not by scanning positions.

### `WalletClaimCooldown`

```rust
pub struct WalletClaimCooldown {
    pub version: u8,              // ACCOUNT_VERSIONS.walletClaimCooldown
    pub global_config: Pubkey,
    pub wallet: Pubkey,
    pub last_claimed_at: i64,     // unix timestamp of last successful claim by this wallet
    pub bump: u8,
}
```

Created lazily on first claim. The one-hour cooldown is enforced against `last_claimed_at`.

### `GlobalGameState`

```rust
pub struct GlobalGameState {
    pub version: u8,                  // ACCOUNT_VERSIONS.globalGameState
    pub global_config: Pubkey,
    pub total_completed_reveals: u64,
    pub live_position_count: u64,
    pub active_cowboy_count: u64,
    pub active_bull_count: u64,
    pub total_active_cowboy_weight: u128, // sum of accrual_weight for active Cowboys
    pub total_active_bull_power: u64,     // sum of buck_power for active Bulls
    pub accounted_principal_atomic: u64,  // sum of principal_amount for every live Position
    pub launch_timestamp: i64,
    pub current_epoch: u64,
    pub last_closed_epoch_timestamp: i64,
    pub bump: u8,
}
```

Counter update rules:

| Transition | `live_position_count` | `active_cowboy_count` | `active_bull_count` | `total_active_cowboy_weight` | `total_active_bull_power` | `total_completed_reveals` |
| --- | --- | --- | --- | --- | --- | --- |
| Stake | +1 | — | — | — | — | — |
| Reveal → Cowboy | — | +1 | — | +accrual_weight | — | +1 |
| Reveal → Bull | — | — | +1 | — | +buck_power | +1 |
| Unstake close Cowboy | -1 | -1 | — | -accrual_weight | — | — |
| Unstake close Bull | -1 | — | -1 | — | -buck_power | — |
| Transfer | — | — | — | — | — | — |

- `live_position_count` increments on stake and decrements on unstake closure.
- `total_completed_reveals` increments on every reveal settlement.
- `active_cowboy_count` and `total_active_cowboy_weight` increment on Cowboy reveal and decrement on Cowboy unstake.
- `active_bull_count` and `total_active_bull_power` increment on Bull reveal and decrement on Bull unstake.
- Ownership transfers do not change counters, but they update `state_version`, reset reward checkpoints, and set `unstake_eligible_at = transfer_timestamp + 24 hours`.

### `BullAccumulator`

```rust
pub struct BullAccumulator {
    pub version: u8,                     // ACCOUNT_VERSIONS.bullAccumulator
    pub global_config: Pubkey,
    pub cowboy_reward_index: u128,       // scaled by COWBOY_REWARD_INDEX_SCALE
    pub reward_per_weight_scaled: u128,  // scaled by REWARD_PER_WEIGHT_SCALE
    pub bump: u8,
}
```

`REWARD_PER_WEIGHT_SCALE` is `1_000_000_000_000_000_000` (`1e18`), chosen so that `u128` intermediates cannot overflow for the approved tokenomics. The accumulator is global, not per-epoch; epoch history belongs in events and the indexer.

### `BullRegistry` — design proposal

Mint theft and any future Bull-weighted selection must not scan every Bull account. The final registry design must be reviewed and verified before mint-theft reveal implementation proceeds. The account schemas below are a design proposal, not a finalized interface.

A finalized design must include:

- A Merkle-sum root hash and a monotonically increasing registry version.
- Immutable root/version snapshot stored in `PendingRandomness` at the time the randomness is requested.
- Exact unbiased victim-owner exclusion.
- Historical proof availability after the live registry changes, so a reveal settlement can still verify a snapshot that was current when the randomness was committed.
- Exact node/page format, account size, and page capacity.
- Maximum supported live positions, Bulls, and owners.
- Maximum transaction-size and compute-budget benchmarks.
- Registry update and proof tests.

The following schemas are placeholders for the design proposal:

```rust
pub struct BullRegistry {
    pub version: u8,
    pub global_config: Pubkey,
    pub merkle_root: [u8; 32],          // Merkle-sum root of owner/position tree
    pub registry_version: u64,          // monotonically increasing
    pub total_buck_power: u64,
    pub bump: u8,
}

pub struct BullRegistryNode {
    pub version: u8,
    pub registry: Pubkey,
    pub node_id: u64,
    // placeholder fields for a two-level weighted sortition tree
    pub owner: Pubkey,
    pub total_buck_power: u64,
    pub left_child: u64,
    pub right_child: u64,
    pub position_id: u64,
    pub bump: u8,
}
```

Reveal implementation for mint theft is **BLOCKED: OWNER DECISION REQUIRED** until the final design satisfies every item in the checklist above and is reviewed for bounded account sizes, compute cost, and verifiable proof availability.

### `PendingRandomness`

```rust
pub struct PendingRandomness {
    pub version: u8,                 // ACCOUNT_VERSIONS.pendingRandomness (2)
    pub position: Pubkey,
    pub action_type: ActionType,     // stable, append-only enum
    pub action_nonce: u64,
    pub provider_program: Pubkey,    // e.g. Switchboard randomness program
    pub provider_randomness_account: Pubkey, // randomness/request account stored at commit time
    pub commitment: [u8; 32],
    pub committed_slot: u64,         // also verified at settlement
    pub committed_protocol_epoch: u64,
    pub timeout_timestamp: i64,
    pub registry_root_snapshot: [u8; 32], // registry root/version for mint theft if applicable
    pub settled: bool,
    pub bump: u8,
}
```

The provider adapter must either return normalized randomness through CPI return data in the same transaction, or write a `VerifiedRandomness` PDA that is consumed exactly once by `rodeo_core`. `RandomnessVerified` is an observability event only and is not an on-chain data channel.

## Enums

```rust
pub enum Role { Unassigned, Cowboy, Bull }
pub enum PositionStatus { RevealPending, Active }
pub enum ActionType { Reveal = 0, Unstake = 1 } // append-only
pub enum Suit { Unassigned = 0, Hearts = 1, Diamonds = 2, Clubs = 3, Spades = 4 }
pub enum CowboyKind { Unassigned, Rank(u8), Desperado }
```

## Authority model

| Authority | Role |
| --- | --- |
| `Position.owner` | Signs claims, unstakes, listings, gifts, and any owner-initiated transfer. |
| `GlobalConfig` PDA | Token-account authority for principal and reward vaults. No direct upgrade authority. |
| Treasury Council (3-of-5 Squads) | Receives external revenue share; cannot move player principal or accrued liabilities. |
| Upgrade Council (3-of-5 Squads) | Program upgrades through a 72-hour timelock. Cannot change state in `GlobalConfig` without a proposal. |
| Emergency Guardians (2-of-3) | Toggle action-specific pause flags. Cannot withdraw principal or block safe claims/exits. |
| Permissionless settler | Any account may submit a valid randomness settlement proof and pay rent. |

## Version map

Current account versions (from `packages/protocol-definition/src/accounts.ts`):

| Account | Version | Reason |
| --- | --- | --- |
| globalConfig | 1 | Initial definition. |
| rewardState | 2 | Added `recognized_reward_balance_atomic`, `unrecognized_reward_surplus_atomic`; removed `suit_vault_atomic`, `cowboy_index_remainder`, `bull_index_remainder`, and duplicated Bull accumulator fields. |
| position | 4 | Added `cowboy_kind`, `unstake_eligible_at`; removed `rank_or_tier` sentinel. |
| globalGameState | 2 | Added `accounted_principal_atomic`. |
| bullAccumulator | 2 | Added `cowboy_reward_index`; removed `division_remainder`. |
| bullRegistry | 1 | Design-proposal placeholder; version will bump when finalized. |
| pendingRandomness | 3 | Added `provider_program`, `provider_randomness_account`, `committed_protocol_epoch`, `timeout_timestamp`, `registry_root_snapshot`. |
| pendingBatch | 1 | Per-source-mint router pending account. |
| walletClaimCooldown | 1 | Initial definition. |
| socialResult | 1 | Initial definition. |

## Open questions (BLOCKED)

- Final `BullRegistry` design, account sizes, page capacity, Merkle-sum proof format, historical snapshot availability, and maximum supported Bull population: **BLOCKED: OWNER DECISION REQUIRED** (mint-theft reveal implementation is blocked until reviewed).
- `PendingBatch` schema for each source mint (SOL, RODEO, etc.): **BLOCKED: OWNER DECISION REQUIRED**.
- Maximum balance/supply bounds for account sizing: **BLOCKED: OWNER DECISION REQUIRED**.
- Exact Metaplex Core plugin configuration and delegate authority program address: **BLOCKED: OWNER DECISION REQUIRED**.
