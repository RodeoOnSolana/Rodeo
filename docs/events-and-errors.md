# Rodeo Protocol v1 — Events and Errors

## Events

Events are emitted by the on-chain programs and consumed by the indexer, keeper, and frontend. All events include the emitting program, slot, and signature as part of the off-chain envelope.

### `PositionStaked`

```rust
pub struct PositionStaked {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub principal_amount: u64,
    pub commitment: [u8; 32],
}
```

Emitted when a new position is staked and the reveal `PendingRandomness` is opened.

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
}
```

Emitted when a reveal settles. `stolen` is `true` if the position was transferred to an eligible Bull during the reveal.

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

### `EpochClosed`

```rust
pub struct EpochClosed {
    pub epoch: u64,
    pub cowboy_emission: u64,
    pub suit_vault_contribution: u64,
    pub free_ansem: u64,
    pub total_cowboy_weight: u128,
}
```

Emitted at the end of each six-hour epoch.

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

### `RandomnessTimeoutRecovered`

```rust
pub struct RandomnessTimeoutRecovered {
    pub position: Pubkey,
    pub action_type: ActionType,
    pub action_nonce: u64,
    pub recovery_action: TimeoutRecoveryAction,
}

pub enum TimeoutRecoveryAction {
    CloseAndRefundPrincipal,
    RetryNewNonce,
}
```

Emitted on timeout recovery. Exact recovery actions are **BLOCKED: OWNER DECISION REQUIRED**.

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
| `StakeAmountMismatch` | Stake amount must equal the configured requirement | `stake_and_commit` with `principal_amount != STAKE_AMOUNT_ATOMIC` |
| `MinimumStakePeriodNotMet` | Position has not been active long enough | unstake before `MIN_STAKE_SECONDS` elapsed |
| `ClaimCooldownNotMet` | Wallet claim cooldown has not elapsed | claim before one hour since last wallet claim |
| `NoClaimableRewards` | Position has no claimable ANSEM | claim with `claimable_ansem_atomic == 0` |
| `InvalidProbabilityOutcome` | Randomness outcome does not map to a valid role/rank/tier/suit | provider bug or malformed proof |
| `TheftEligibilityNotMet` | Mint theft requires 50 reveals and 3 eligible Bulls | reveal with theft flag true but criteria not met |
| `NoEligibleTheftRecipient` | No eligible external Bull exists for mint theft | all eligible Bulls owned by victim |
| `PendingActionBlocksTransfer` | Cannot transfer while a randomness action is pending | marketplace/gift/transfer checks |
| `ListingExpired` | Marketplace listing has expired | settlement of expired listing |
| `StaleListing` | Listing no longer matches the position state | ownership, unstake, or pending action changed |
| `InvalidMarketReceipt` | Receipt asset does not match the position | marketplace or gift validation |
| `InvalidSocialAttestation` | Social oracle attestation signatures are invalid | suit-competition distribution |
| `SuitCompetitionNotEnded` | Social competition epoch has not ended | premature distribution |
| `RunwayInsufficient` | Insufficient free ANSEM for requested emission | defensive check, should be handled by formula |
| `UnauthorizedSwapVenue` | Swap venue is not in the approved list | treasury router |
| `SlippageExceeded` | Swap output below minimum | treasury router |

## Event indexing rules

- Events are idempotent by `(transaction_signature, event_index)`.
- The indexer reconstructs `Position` and reward state from events and on-chain account snapshots.
- Duplicate events must not double-count balances or liabilities.
