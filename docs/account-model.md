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
    pub suit_vault_liability_atomic: u64,             // reserved for suit competitions
    // ANSEM flows
    pub ansem_emitted_atomic: u64,
    pub ansem_claimed_atomic: u64,
    // Scaled global accumulators
    pub cowboy_reward_index: u128,                    // scaled by ACCRUAL_WEIGHT_SCALE
    pub bull_reward_per_weight_scaled: u128,           // scaled by REWARD_PER_WEIGHT_SCALE
    pub suit_vault_atomic: u64,
    pub suit_epoch: u64,
    // Accumulator dust carried forward at scale 1
    pub cowboy_index_remainder: u128,
    pub bull_index_remainder: u128,
    pub bump: u8,
}
```

Every division that produces a scaled index stores its remainder so the same ANSEM cannot be emitted, reserved, or counted twice. Dust from the scaled accumulators remains reserved and cannot become free ANSEM.

### `Position`

```rust
pub struct Position {
    pub version: u8,                 // ACCOUNT_VERSIONS.position (3)
    pub owner: Pubkey,               // mutable
    pub position_id: u64,
    pub principal_amount: u64,       // always STAKE_AMOUNT_ATOMIC while active; 0 only transiently before close
    pub role: Role,                  // Unassigned | Cowboy | Bull
    pub status: PositionStatus,      // RevealPending | Active
    pub rank_or_tier: u8,            // 0 until revealed; Cowboy rank 4-10 or Bull tier 1-4
    pub suit: Suit,                  // 0 until revealed; Hearts | Diamonds | Clubs | Spades
    pub opened_at: i64,
    pub active_since: i64,           // reveal settlement timestamp; 0 until revealed
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

`receipt_asset` is empty until reveal settlement, when the Metaplex Core Asset is created directly for the final owner.

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

### `BullAccumulator`

```rust
pub struct BullAccumulator {
    pub version: u8,                     // ACCOUNT_VERSIONS.bullAccumulator
    pub global_config: Pubkey,
    pub reward_per_weight_scaled: u128,  // scaled by REWARD_PER_WEIGHT_SCALE
    pub division_remainder: u128,        // carried forward at scale 1
    pub bump: u8,
}
```

`REWARD_PER_WEIGHT_SCALE` is `1_000_000_000_000_000_000` (`1e18`), chosen so that `u128` intermediates cannot overflow for the approved tokenomics. The accumulator is global, not per-epoch; epoch history belongs in events and the indexer.

### `BullRegistry` — two-level weighted sortition tree

Mint theft and any future Bull-weighted selection must not scan every Bull account. The protocol uses a persistent two-level sum tree:

```rust
pub struct BullRegistry {
    pub version: u8,
    pub global_config: Pubkey,
    pub root_owner_sum: u64,           // number of owner nodes
    pub total_buck_power: u64,
    pub tree_depth: u8,
    pub bump: u8,
}

pub struct BullRegistryNode {
    pub version: u8,
    pub registry: Pubkey,
    pub node_id: u64,                  // stable, sequentially assigned
    pub parent_node_id: u64,           // 0 for root owner nodes
    pub owner: Pubkey,                 // set for owner-level nodes; zero for internal nodes
    pub total_buck_power: u64,         // aggregate power of this subtree
    pub left_child: u64,               // 0 if leaf Bull position node
    pub right_child: u64,
    pub position_id: u64,              // set only for leaf Bull position nodes
    pub is_owner_node: bool,
    pub bump: u8,
}
```

Tree layout:

- **Level 1** — owner-sum nodes. Each node represents one owner and stores the owner's aggregate active `buck_power`. The root of Level 1 stores the sum over all owners and is used for O(log o) weighted owner selection.
- **Level 2** — per-owner sum tree nodes. For the selected owner, a small balanced tree (or sorted list of pages) stores that owner's individual Bull positions and their `buck_power`, used for O(log p) weighted position selection.

Operations:

- **Activate a Bull** (`reveal` → Bull): insert the owner into Level 1 if absent, or increment the owner's power; insert the position into the owner's Level 2 tree.
- **Deactivate a Bull** (`unstake`, `transfer` away, etc.): remove the position from Level 2 and decrement the owner's Level 1 power; if the owner's power reaches zero, remove the owner node.
- **Weighted owner draw**: draw `r` in `[0, total_buck_power - victim_owner_buck_power)`. Traverse Level 1 by cumulative power, skipping the victim owner's node, to select a recipient owner in O(log o).
- **Weighted position draw**: within the selected owner, draw `r` in `[0, owner_buck_power)` and traverse the owner's Level 2 tree in O(log p).
- **Proof**: the settlement transaction supplies the two page paths (owner node + position node) plus sibling hashes. The program verifies the cumulative sums and that the victim owner is excluded.

Page structure:

- Each `BullRegistryNode` is a fixed-size account (recommended 256–512 bytes).
- A page can hold multiple leaf entries or a small number of child pointers.
- Maximum population is bounded by account size and compute budget; the design document must specify the maximum supported number of Bull positions and the worst-case compute cost before implementation.

Reveal implementation for mint theft is **BLOCKED: OWNER DECISION REQUIRED** until this registry design is reviewed, account sizes and compute costs are modeled, and the exact proof format is finalized.

### `PendingRandomness`

```rust
pub struct PendingRandomness {
    pub version: u8,                 // ACCOUNT_VERSIONS.pendingRandomness (2)
    pub position: Pubkey,
    pub action_type: ActionType,     // stable, append-only enum
    pub action_nonce: u64,
    pub commitment: [u8; 32],
    pub committed_slot: u64,
    pub settled: bool,
    pub bump: u8,
}
```

## Enums

```rust
pub enum Role { Unassigned, Cowboy, Bull }
pub enum PositionStatus { RevealPending, Active }
pub enum ActionType { Reveal = 0, Unstake = 1 } // append-only
pub enum Suit { Unassigned = 0, Hearts = 1, Diamonds = 2, Clubs = 3, Spades = 4 }
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
| rewardState | 1 | Initial definition with explicit liability buckets. |
| position | 3 | Added `accrual_weight`, `buck_power`, reward checkpoints, `receipt_asset`, `active_since`, `opened_at`; removed `last_claimed_at`. |
| globalGameState | 1 | Initial definition. |
| bullAccumulator | 1 | Global accumulator (was per-epoch; now singleton). |
| bullRegistry | 1 | Initial definition for sortition tree. |
| pendingRandomness | 2 | PDA moved to `[position, action_type, action_nonce]`; dropped owner field. |
| pendingBatch | 1 | Per-source-mint router pending account. |
| walletClaimCooldown | 1 | Initial definition. |
| socialResult | 1 | Initial definition. |

## Open questions (BLOCKED)

- Exact `BullRegistryNode` account size, page capacity, and maximum supported Bull population: **BLOCKED: OWNER DECISION REQUIRED** (reveal implementation is blocked until reviewed).
- `PendingBatch` schema for each source mint (SOL, RODEO, etc.): **BLOCKED: OWNER DECISION REQUIRED**.
- Maximum balance/supply bounds for account sizing: **BLOCKED: OWNER DECISION REQUIRED**.
