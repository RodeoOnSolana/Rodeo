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
    pub role: Role,
    pub cowboy_kind: CowboyKind,
    pub bull_tier: u8,
    pub suit: Suit,
    pub final_owner: Pubkey,
    pub previous_owner: Option<Pubkey>, // present only when stolen == true
    pub stolen: bool,
    pub receipt_asset: Pubkey,
    pub active_since: i64,
    pub unstake_eligible_at: i64,
    pub settlement_nonce: u64,
}
```

Emitted when a reveal settles. `stolen` is `true` if the position was transferred to an eligible Bull during the reveal, in which case `previous_owner` carries the victim's wallet; `previous_owner` is omitted (`None`) otherwise. `final_owner` is the position owner after resolution (the original staker unless stolen). The `receipt_asset` is created directly for `final_owner`.

### `PositionOwnerChanged`

```rust
pub struct PositionOwnerChanged {
    pub position: Pubkey,
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
    pub reason: OwnershipChangeReason,
}

pub enum OwnershipChangeReason {
    Sale,
    Gift,
    MintTheft,
}
```

Emitted whenever `Position.owner` changes. There is no public, generic `transfer_position` instruction. Sale and gift call the same internal ownership-mutation helper, which synchronizes/force-settles seller rewards (a zero resulting claimable amount is a successful no-op, never `NoClaimableRewards`), sets buyer checkpoints to the current global indices, resets `claimable_ansem_atomic`, preserves the seller's role-appropriate sub-atomic accrual remainder on the `Position`, transfers the frozen Core receipt atomically, updates `Position.owner`, and resets `unstake_eligible_at`. Mint theft instead uses a separate internal initial-owner path at reveal settlement: it sets `Position.owner` directly, initializes reward checkpoints, and creates the receipt directly for the final owner, without transferring an existing receipt or settling any rewards.

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

### `ListingCreated`

```rust
pub struct ListingCreated {
    pub listing: Pubkey,
    pub position: Pubkey,
    pub seller: Pubkey,
    pub price_lamports: u64,
    pub listing_nonce: u64,
    pub state_version_at_listing: u64,
}
```

Emitted when a seller creates a non-custodial fixed-price `Listing`. Marketplace v1 supports only fixed-price direct listings; there are no bids, auctions, or private offers, and listings never expire automatically.

### `ListingCancelled`

```rust
pub struct ListingCancelled {
    pub listing: Pubkey,
    pub position: Pubkey,
    pub seller: Pubkey,
}
```

Emitted when a listing is explicitly cancelled by the seller or closed as stale by a permissionless cleanup instruction.

### `PositionSold`

```rust
pub struct PositionSold {
    pub position: Pubkey,
    pub listing: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price_lamports: u64,
    pub marketplace_fee_lamports: u64,
    pub seller_proceeds_lamports: u64,
    pub settlement_nonce: u64,
}
```

Emitted when a marketplace sale settles atomically. Seller rewards are synchronized/force-settled and `Position.unstake_eligible_at` is reset before this event is emitted.

### `PositionGifted`

```rust
pub struct PositionGifted {
    pub position: Pubkey,
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
    pub settlement_nonce: u64,
}
```

Emitted when a zero-price gift transfer settles. Giver rewards are synchronized/force-settled and `Position.unstake_eligible_at` is reset before this event is emitted.

### `ReceiptCreated`

```rust
pub struct ReceiptCreated {
    pub position: Pubkey,
    pub receipt_asset: Pubkey,
    pub owner: Pubkey,
}
```

Emitted when the frozen Metaplex Core `PositionReceipt` is created at reveal settlement, directly for the final owner.

### `ReceiptBurned`

```rust
pub struct ReceiptBurned {
    pub position: Pubkey,
    pub receipt_asset: Pubkey,
}
```

Emitted when the receipt is burned through the Rodeo-controlled permanent burn delegate on unstake closure.

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

Emitted whenever ANSEM is added to the Bull reward pool from a claim or unstake theft. `CowboyClaimTax` and `DesperadoClaimTax` route to `bull_pool_liability_atomic` (with accumulator update) when `total_active_bull_power > 0`, or to `bull_pool_unallocated_liability_atomic` otherwise.

### `RewardFundingRecognized`

```rust
pub struct RewardFundingRecognized {
    pub amount_atomic: u64,
    pub recognized_reward_balance_atomic: u64, // balance after recognition
    pub actual_reward_vault_balance: u64,
}
```

Emitted when the permissionless recognition instruction moves ANSEM from the unrecognized surplus (`reward_vault_balance - recognized_reward_balance_atomic`) into `recognized_reward_balance_atomic` after epoch catch-up.

### `RewardPaid`

```rust
pub struct RewardPaid {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub amount_atomic: u64,
    pub recognized_reward_balance_atomic: u64, // balance after payment
    pub reason: RewardPaidReason,
}

pub enum RewardPaidReason {
    CowboyClaim,
    DesperadoClaim,
    BullClaim,
    UnstakeSettlement,
    SuitReward,
}
```

Emitted on every ANSEM transfer out of the reward vault. `recognized_reward_balance_atomic` decreases by `amount_atomic` for every occurrence of this event.

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
    pub recognized_reward_balance_atomic: u64,   // snapshot at epoch boundary
    pub total_ansem_liability_atomic: u64,       // snapshot at epoch boundary
    pub snapshot_timestamp: i64,
}
```

Emitted at the end of each six-hour epoch, using the snapshot values at the epoch boundary, including the recognized reward balance and total liability snapshot used to compute that epoch's emission.

### `SuitCompetitionResultAttested`

```rust
pub struct SuitCompetitionResultAttested {
    pub competition_epoch: u64,
    pub winning_suits_mask: u8,    // bitmask over Suit; more than one bit set means a tie
    pub total_amount: u64,         // distributable suit vault for this competition_epoch
    pub merkle_root: [u8; 32],
    pub content_hash: [u8; 32],    // hash of the off-chain result file
    pub oracle_threshold: u8,
    pub signers: Vec<Pubkey>,
}
```

Emitted when the social oracle attests a competition result. `winning_suits_mask` replaces the earlier singular `winning_suit` field; when `N > 1` bits are set, the tied suits split `total_amount` equally (`total_amount / N`, floor) and each applies the 50/50 equal/proportional split independently, with integer-division remainder rolling into the next competition epoch.

### `SuitRewardsDistributed`

```rust
pub struct SuitRewardsDistributed {
    pub competition_epoch: u64,
    pub total_amount: u64,
    pub eligible_positions: u64,
}
```

Emitted when the suit-competition vault is fully distributed.

### `SuitRewardClaimed`

```rust
pub struct SuitRewardClaimed {
    pub competition_epoch: u64,
    pub position: Pubkey,
    pub owner_at_snapshot: Pubkey,
    pub amount_atomic: u64,
    pub leaf_nonce: u64,
}
```

Emitted when a suit-competition Merkle leaf is claimed. The reward belongs permanently to `owner_at_snapshot`; the claim does not require the `Position` to remain open/active, and does not require the current `Position.owner` to match `owner_at_snapshot`. A claim receipt/bitmap prevents replay of the same leaf.

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
    pub committed_protocol_epoch: u64,
    pub timeout_timestamp: i64,
    pub provider_program: Pubkey,
    pub provider_randomness_account: Pubkey,
    pub vrf_key: Option<Pubkey>,            // provider VRF/oracle key, if applicable
    pub callback_id: Option<[u8; 32]>,      // provider callback/task id, if applicable
    pub registry_root_snapshot: [u8; 32],   // BullRegistry root at request time, if applicable
    pub registry_version_snapshot: u64,     // BullRegistry version at request time, if applicable
    pub commitment: [u8; 32],
}
```

Emitted when a randomness action is committed. The provider-specific fields (`vrf_key`, `callback_id`) depend on the chosen production randomness provider's adapter; unused fields are `None`. This schema mirrors `PendingRandomness` exactly (`position`, `action_type`, `action_nonce`, `committed_protocol_epoch`, `timeout_timestamp`, `provider_program`, `provider_randomness_account`, `vrf_key`, `callback_id`, `registry_root_snapshot`, `registry_version_snapshot`, `commitment`) so the indexer's `randomness_requests` table can be populated directly from the event without a separate account fetch.

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

Emitted by the provider adapter after verifying an oracle proof. This event is for observability only; the core program receives randomness through CPI return data or a consumed `VerifiedRandomness` PDA, not through this event.

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
    pub pause_flag: PauseFlag,
    pub paused: bool,           // true = paused, false = unpaused
    pub effective_at: i64,
}

pub enum PauseFlag {
    NewStakes,
    NewRevealRequests,
    NewMarketplaceListings,
    RouterSwaps,
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
| `PositionLocked` | Position has a pending action and cannot change owner | internal ownership-mutation helper (sale/gift/mint theft) while pending action active |

### New errors required for Protocol v1

| Error | Message | Trigger |
| --- | --- | --- |
| `StakeAmountMismatch` | Stake amount must equal the configured requirement | stake with `principal_amount != STAKE_AMOUNT_ATOMIC` |
| `MinimumStakePeriodNotMet` | Position has not been active long enough | unstake before `MIN_STAKE_SECONDS` elapsed |
| `ClaimCooldownNotMet` | Wallet claim cooldown has not elapsed | non-forced claim before one hour since last wallet claim (forced settlements bypass this cooldown but still update `WalletClaimCooldown.last_claimed_at`) |
| `NoClaimableRewards` | Position has no claimable ANSEM after synchronization | claim or forced settlement where the resulting claimable amount is zero after closing elapsed epochs and synchronizing indices |
| `EpochsNotClosed` | All elapsed epochs must be closed before this operation | state change crossing an epoch boundary |
| `InvalidProbabilityOutcome` | Randomness outcome does not map to a valid role/cowboy_kind/bull_tier/suit | provider bug or malformed proof |
| `PendingActionBlocksTransfer` | Cannot change owner while a randomness action is pending | marketplace/gift/mint-theft ownership checks |
| `PendingActionBlocksClaim` | Cannot claim while a randomness action is pending | claim while unstake/reveal pending |
| `StaleListing` | Listing no longer matches the position state | ownership, unstake, or pending action changed |
| `InvalidMarketReceipt` | Receipt asset does not match the position | marketplace or gift validation |
| `InvalidSocialAttestation` | Social oracle attestation signatures are invalid | suit-competition distribution |
| `SuitCompetitionNotEnded` | Social competition epoch has not ended | premature distribution |
| `UnrecognizedRewardFunding` | ANSEM in the vault is not yet recognized for liability accounting | operation that requires recognized balance before catch-up |
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
