# Rodeo Protocol v1 — Account Model

## PDA derivations

All program addresses are deterministic PDAs. Seed arrays use raw byte literals and fixed-width little-endian integers.

| Account | Seeds | Notes |
| --- | --- | --- |
| `GlobalConfig` | `[b"global-config"]` | Singleton. Immutable after initialization. |
| `PrincipalVault` (token account) | `[b"principal-vault"]` | Holds all staked RODEO principal. Authority is `GlobalConfig`. |
| `RewardVault` (token account) | `[b"reward-vault"]` | Holds ANSEM rewards. Authority is `GlobalConfig`. |
| `Position` | `[b"position", global_config.key().as_ref(), &position_id.to_le_bytes()]` | Identity does not depend on owner. |
| `RewardState` | `[b"reward-state", global_config.key().as_ref()]` | Tracks epoch, emissions, and liabilities. |
| `RoleStatistics` (per epoch) | `[b"role-stats", global_config.key().as_ref(), &epoch.to_le_bytes()]` | Population and principal aggregates. |
| `BullAccumulator` (per epoch) | `[b"bull-accumulator", global_config.key().as_ref(), &epoch.to_le_bytes()]` | Reward-per-buck-power accounting state. |
| `PendingRandomness` | `[b"randomness", position.key().as_ref(), &[action_type as u8], &action_nonce.to_le_bytes()]` | One per outstanding randomness action. |
| `MarketReceipt` | **BLOCKED: OWNER DECISION REQUIRED** — exact seed scheme depends on whether the receipt is a Metaplex NFT, a Rodeo-specific token mint, or a program-only position record. | Must be program-controlled and atomically linked to `Position`. |

## Account schemas

### `GlobalConfig`

```rust
pub struct GlobalConfig {
    pub version: u8,                 // ACCOUNT_VERSIONS.globalConfig
    pub rodeo_mint: Pubkey,
    pub ansem_mint: Pubkey,
    pub principal_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub bump: u8,
    pub principal_vault_bump: u8,
    pub reward_vault_bump: u8,
}
```

No admin pubkey, no mutable fee parameters, no pause flag. Economic constants are immutable code, not state.

### `RewardState`

```rust
pub struct RewardState {
    pub version: u8,                 // ACCOUNT_VERSIONS.rewardState
    pub global_config: Pubkey,
    pub current_epoch: u64,
    pub epoch_started_at: i64,
    pub fee_revenue_atomic: u64,     // external revenue awaiting swap
    pub ansem_emitted_atomic: u64,
    pub ansem_claimed_atomic: u64,
    pub ansem_liability_atomic: u64,
    pub bump: u8,
}
```

### `Position`

```rust
pub struct Position {
    pub version: u8,                 // ACCOUNT_VERSIONS.position (2)
    pub owner: Pubkey,               // mutable
    pub position_id: u64,
    pub principal_amount: u64,       // always STAKE_AMOUNT_ATOMIC while active
    pub role: Role,                  // Unassigned | Cowboy | Bull
    pub status: PositionStatus,      // RandomnessPending | Active | Closed
    pub rank_or_tier: u8,            // 0 until revealed; Cowboy rank 4-10 or Bull tier 1-4
    pub suit: Suit,                  // 0 until revealed; Hearts | Diamonds | Clubs | Spades
    pub opened_epoch: u64,
    pub settlement_nonce: u64,       // increments on every settled randomness action
    pub claimable_ansem_atomic: u64, // accrued but unclaimed ANSEM
    pub last_claimed_at: i64,        // wallet-level claim cooldown anchor
    pub pending_action_active: bool,
    pub pending_action_type: ActionType,
    pub pending_action_nonce: u64,
    pub next_action_nonce: u64,
    pub bump: u8,
}
```

`Position` does not contain `last_wallet_claim_at`; claim cooldown is enforced by inspecting all positions owned by the wallet or by a separate wallet-level account. The exact mechanism is a `BLOCKED: OWNER DECISION REQUIRED` implementation detail.

### `RoleStatistics`

```rust
pub struct RoleStatistics {
    pub version: u8,
    pub global_config: Pubkey,
    pub epoch: u64,
    pub cowboy_population: u64,
    pub bull_population: u64,
    pub cowboy_principal_atomic: u64,
    pub bull_principal_atomic: u64,
    pub bump: u8,
}
```

### `BullAccumulator`

```rust
pub struct BullAccumulator {
    pub version: u8,
    pub global_config: Pubkey,
    pub epoch: u64,
    pub total_weight: u128,              // sum of active Bull buck power
    pub reward_per_weight_scaled: u128,  // scaled by REWARD_PER_WEIGHT_SCALE
    pub division_remainder_atomic: u128, // carried forward at scale 1
    pub bump: u8,
}
```

`REWARD_PER_WEIGHT_SCALE` is chosen so that `u128` intermediates cannot overflow for the approved tokenomics. The exact scale is `BLOCKED: OWNER DECISION REQUIRED` pending token-decimal and max-supply analysis, but must be at least `1_000_000` and must be immutable.

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
pub enum PositionStatus { RandomnessPending, Active, Closed }
pub enum ActionType { Reveal = 0, Unstake = 1 } // append-only
pub enum Suit { Unassigned = 0, Hearts = 1, Diamonds = 2, Clubs = 3, Spades = 4 }
```

## Authority model

| Authority | Role |
| --- | --- |
| `Position.owner` | Signs claims, unstakes, listings, gifts, and any owner-initiated transfer. |
| `GlobalConfig` PDA | Token-account authority for principal and reward vaults. No upgrade authority. |
| Treasury multisig | Receives external revenue share; cannot move player principal or accrued liabilities. |
| Upgrade multisig + timelock | Program upgrades only. Cannot change immutable economic constants in state. |
| Emergency guardian | Pause risky new actions. Cannot withdraw principal or block safe claims/exits. |
| Permissionless settler | Any account may submit a valid randomness settlement proof and pay rent. |

## Version map

Current account versions (from `packages/protocol-definition/src/accounts.ts`):

| Account | Version | Reason |
| --- | --- | --- |
| globalConfig | 1 | Initial definition. |
| rewardState | 1 | Initial definition. |
| position | 2 | PDA moved to `[global_config, position_id]`; added pending-action lock fields. |
| roleStatistics | 1 | Initial definition. |
| bullAccumulator | 1 | Initial definition. |
| pendingRandomness | 2 | PDA moved to `[position, action_type, action_nonce]`; dropped owner field. |

## Open questions (BLOCKED)

- `MarketReceipt` asset type and PDA seeds: **BLOCKED: OWNER DECISION REQUIRED**.
- Wallet-level claim-cooldown account design: **BLOCKED: OWNER DECISION REQUIRED**.
- `REWARD_PER_WEIGHT_SCALE` exact value: **BLOCKED: OWNER DECISION REQUIRED** pending token decimal and max-epoch reward analysis.
