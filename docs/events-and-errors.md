# Rodeo Protocol v1 — Events and Errors

## Events

Events are emitted by the on-chain programs and consumed by the indexer, keeper, and frontend. All events include the emitting program, slot, and signature as part of the off-chain envelope.

### `PositionStaked`

```rust
pub struct PositionStaked {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub position_id: u64,
    pub principal_amount: u64,
    pub commitment: [u8; 32],
    pub global_game_state: Pubkey,
}
```

Emitted when a new position is staked and the reveal `PendingRandomness` is opened. `GlobalGameState.live_position_count` and related counters are updated atomically.

### `PositionRevealed`

```rust
pub struct PositionRevealed {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub role: Role,
    pub rank_or_tier: u8,
    pub suit: Suit,
    pub stolen: bool,
    pub settlement_nonce: u64,
    pub receipt_asset: Pubkey,
    pub active_since: i64,
}
```

Emitted when a reveal settles. `stolen` is `true` if the position was transferred to an eligible Bull during the reveal. The `receipt_asset` is created directly for the final owner.

### `PositionOwnerChanged`

```rust
pub struct PositionOwnerChanged {
    pub position: Pubkey,
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
    pub reason: OwnershipChangeReason,
}

pub enum OwnershipChangeReason {
    Transfer,
    Sale,
    Gift,
    MintTheft,
}
```

Emitted whenever `Position.owner` changes, including through marketplace sale, gift, or mint theft.

### `PositionClaimed`

```rust
pub struct PositionClaimed {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub owner_amount: u64,
    pub bull_pool_amount: u64,
}
```

Emitted when a position's pending ANSEM is claimed. `bull_pool_amount` is the portion directed to the Bull reward pool.

### `PositionUnstaked`

```rust
pub struct PositionUnstaked {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub principal_returned: u64,
    pub principal_burned: u64,
    pub ansem_fate: AnsemUnstakeFate,
    pub settlement_nonce: u64,
}

pub enum AnsemUnstakeFate {
    ToOwner,
    ToBullPool,
    Immune, // Desperado
}
```

Emitted when a position is fully closed through unstake.

### `UnstakeRequested`

```rust
pub struct UnstakeRequested {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub action_nonce: u64,
    pub requested_at: i64,
}
```

Emitted when an owner commits an unstake randomness action.

### `UnstakeCancelled`

```rust
pub struct UnstakeCancelled {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub action_nonce: u64,
}
```

Emitted when an owner cancels an unstake request before settlement.

### `BullPoolContribution`

```rust
pub struct BullPoolContribution {
    pub epoch: u64,
    pub amount_atomic: u64,
    pub source: BullPoolSource,
}

pub enum BullPoolSource {
    CowboyClaimTax,
    DesperadoClaimTax,
    UnstakeTheft,
}
```

Emitted whenever ANSEM is added to the Bull reward pool from a claim or unstake theft.

### `BullRewardDistributed`

```rust
pub struct BullRewardDistributed {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub amount_atomic: u64,
    pub reward_per_weight_scaled: u128,
}
```

Emitted when a Bull position's Bull-pool reward is credited (lazy update on claim/transfer/unstake).

### `EpochsClosed`

```rust
pub struct EpochsClosed {
    pub start_epoch: u64,
    pub end_epoch: u64,                // exclusive
    pub epochs_processed: u64,
    pub last_closed_timestamp: i64,
}
```

Emitted when `close_epochs` advances one or more epoch boundaries. Per-epoch details (`EpochClosed`) are emitted for each individual epoch if needed for indexing.

### `EpochClosed`

```rust
pub struct EpochClosed {
    pub epoch: u64,
    pub cowboy_emission: u64,
    pub suit_vault_contribution: u64,
    pub free_ansem: u64,
    pub total_cowboy_weight: u128,
    pub total_bull_power: u64,
    pub snapshot_timestamp: i64,
}
```

Emitted at the end of each six-hour epoch, using the snapshot values at the epoch boundary.

### `SuitCompetitionResultAttested`

```rust
pub struct SuitCompetitionResultAttested {
    pub competition_epoch: u64,
    pub winning_suit: Suit,
    pub merkle_root: [u8; 32],
    pub oracle_threshold: u8,
    pub signers: Vec<Pubkey>,
}
```

Emitted when the social oracle attests a competition result.

### `SuitRewardsDistributed`

```rust
pub struct SuitRewardsDistributed {
    pub competition_epoch: u64,
    pub total_amount: u64,
    pub eligible_positions: u64,
}
```

Emitted when the suit-competition vault is fully distributed.

### `ExternalRevenueRouted`

```rust
pub struct ExternalRevenueRouted {
    pub batch_id: [u8; 32],
    pub source_token: Pubkey,
    pub total_source_atomic: u64,
    pub ansem_purchased: u64,
    pub rodeo_burned: u64,
    pub team_amount: u64,
    pub security_amount: u64,
}
```

Emitted when the treasury router processes a revenue batch.

### `RandomnessRequested`

```rust
pub struct RandomnessRequested {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub committed_slot: u64,
    pub provider_request_id: Option<[u8; 32]>, // provider-specific
}
```

Emitted when a randomness action is committed. The `provider_request_id` format depends on the chosen production randomness provider.

### `RandomnessSettled`

```rust
pub struct RandomnessSettled {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub settlement_nonce: u64,
}
```

Emitted when a randomness action settles successfully.

### `RandomnessVerified`

```rust
pub struct RandomnessVerified {
    pub pending_randomness: Pubkey,
    pub random_output: [u8; 32],
    pub provider: Pubkey,
}
```

Emitted by the provider adapter after verifying an oracle proof. The core program consumes this output to map outcomes.

### `BullRegistryUpdated`

```rust
pub struct BullRegistryUpdated {
    pub registry: Pubkey,
    pub owner: Pubkey,
    pub position: Pubkey,
    pub delta_power: i64,       // signed; positive on activate, negative on deactivate
    pub total_buck_power: u64,
}
```

Emitted when the sortition tree changes (Bull activated, deactivated, or transferred).

### `PauseToggled`

```rust
pub struct PauseToggled {
    pub guardian: Pubkey,
    pub pause_flag: String,     // "new_stakes", "new_reveal_requests", "new_marketplace_listings", "router_swaps"
    pub paused: bool,           // true = paused, false = unpaused
    pub effective_at: i64,
}
```

Emitted when an Emergency Guardian toggles an action-specific pause flag.

### `RandomnessTimeoutRecovered`

```rust
pub struct RandomnessTimeoutRecovered {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub recovery_action: TimeoutRecoveryAction,
}

pub enum TimeoutRecoveryAction {
    CloseAndRefundPrincipal,   // reveal timeout before role assignment
    CancelUnstake,             // unstake timeout
}
```

Emitted on timeout recovery.

## Error codes

### Existing Phase 0 errors

| Error | Message | Trigger |
| --- | --- | --- |
| `ZeroPrincipal` | Principal must be greater than zero | `stake_and_commit` with `principal_amount == 0` |
| `AlreadySettled` | Randomness has already been settled | settling an already settled `PendingRandomness` |
| `InvalidReveal` | Reveal does not match the commitment | secret/commitment mismatch |
| `InvalidOwner` | Position owner does not match the signer | owner-gated instruction with wrong signer |
| `ArithmeticOverflow` | Integer arithmetic overflow | any checked math failure |
| `NoPendingRevealAction` | No reveal action is pending for this position | reveal settle without pending reveal |
| `PositionLocked` | Position has a pending action and cannot be transferred | `transfer_position` while pending action active |

### New errors required for Protocol v1

| Error | Message | Trigger |
| --- | --- | --- |
| `StakeAmountMismatch` | Stake amount must equal the configured requirement | stake with `principal_amount != STAKE_AMOUNT_ATOMIC` |
| `MinimumStakePeriodNotMet` | Position has not been active long enough | unstake before `MIN_STAKE_SECONDS` elapsed |
| `ClaimCooldownNotMet` | Wallet claim cooldown has not elapsed | claim before one hour since last wallet claim |
| `NoClaimableRewards` | Position has no claimable ANSEM | claim with `claimable_ansem_atomic == 0` |
| `EpochsNotClosed` | All elapsed epochs must be closed before this operation | state change crossing an epoch boundary |
| `InvalidProbabilityOutcome` | Randomness outcome does not map to a valid role/rank/tier/suit | provider bug or malformed proof |
| `TheftEligibilityNotMet` | Mint theft requires 50 reveals and 3 eligible Bulls | reveal with theft flag true but criteria not met |
| `NoEligibleTheftRecipient` | No eligible external Bull exists for mint theft | all eligible Bulls owned by victim |
| `PendingActionBlocksTransfer` | Cannot transfer while a randomness action is pending | marketplace/gift/transfer checks |
| `PendingActionBlocksClaim` | Cannot claim while a randomness action is pending | claim while unstake/reveal pending |
| `ListingExpired` | Marketplace listing has expired | settlement of expired listing |
| `StaleListing` | Listing no longer matches the position state | ownership, unstake, or pending action changed |
| `InvalidMarketReceipt` | Receipt asset does not match the position | marketplace or gift validation |
| `InvalidSocialAttestation` | Social oracle attestation signatures are invalid | suit-competition distribution |
| `SuitCompetitionNotEnded` | Social competition epoch has not ended | premature distribution |
| `RunwayInsufficient` | Insufficient free ANSEM for requested emission | defensive check, should be handled by formula |
| `UnauthorizedSwapVenue` | Swap venue is not in the approved list | treasury router |
| `SlippageExceeded` | Swap output below minimum | treasury router |
| `PausedNewStakes` | New stakes are paused | Emergency Guardian pause |
| `PausedNewRevealRequests` | New reveal requests are paused | Emergency Guardian pause |
| `PausedNewMarketplaceListings` | New marketplace listings are paused | Emergency Guardian pause |
| `PausedRouterSwaps` | Router swaps are paused | Emergency Guardian pause |

## Event indexing rules

- Events are idempotent by `(transaction_signature, event_index)`.
- The indexer reconstructs `Position` and reward state from events and on-chain account snapshots.
- Duplicate events must not double-count balances or liabilities.
