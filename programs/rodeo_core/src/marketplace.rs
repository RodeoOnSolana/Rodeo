use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use mpl_core::instructions::{TransferV1CpiBuilder, UpdatePluginV1CpiBuilder};
use mpl_core::types::Plugin;

use crate::{
    bull_registry::{
        add_bull_to_registry, remove_bull_from_registry, BullLeaf, CompressedBullProof,
        CompressedOwnerProof,
    },
    constants::*,
    math,
    receipt::parse_core_asset_owner,
    state::*,
    RodeoError,
};

// ---------------------------------------------------------------------------
// Claim-class helpers
// ---------------------------------------------------------------------------

pub fn derive_claim_class(position: &Position) -> Result<ClaimClass> {
    match position.role {
        Role::Unassigned => err!(RodeoError::InvalidRole),
        Role::Bull => Ok(ClaimClass::Bull),
        Role::Cowboy => {
            if position.cowboy_kind == CowboyKind::Desperado {
                Ok(ClaimClass::Desperado)
            } else {
                Ok(ClaimClass::NormalCowboy)
            }
        }
    }
}

pub fn claim_class_bps(claim_class: ClaimClass) -> (u64, u64) {
    match claim_class {
        ClaimClass::NormalCowboy => (CLAIM_OWNER_BPS, CLAIM_BULL_POOL_BPS),
        ClaimClass::Desperado => (DESPERADO_CLAIM_OWNER_BPS, DESPERADO_CLAIM_BULL_POOL_BPS),
        ClaimClass::Bull => (BPS_DENOMINATOR, 0),
    }
}

// ---------------------------------------------------------------------------
// CPI helpers
// ---------------------------------------------------------------------------

fn set_receipt_frozen<'info>(
    receipt_asset: &UncheckedAccount<'info>,
    receipt_collection: &UncheckedAccount<'info>,
    payer: &Signer<'info>,
    receipt_authority: &UncheckedAccount<'info>,
    mpl_core_program: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    receipt_authority_seeds: &[&[u8]],
    frozen: bool,
) -> Result<()> {
    UpdatePluginV1CpiBuilder::new(&mpl_core_program.to_account_info())
        .asset(&receipt_asset.to_account_info())
        .collection(Some(&receipt_collection.to_account_info()))
        .payer(&payer.to_account_info())
        .authority(Some(&receipt_authority.to_account_info()))
        .system_program(&system_program.to_account_info())
        .plugin(Plugin::PermanentFreezeDelegate(
            mpl_core::types::PermanentFreezeDelegate { frozen },
        ))
        .invoke_signed(&[receipt_authority_seeds])?;
    Ok(())
}

fn transfer_receipt_via_delegate<'info>(
    receipt_asset: &UncheckedAccount<'info>,
    receipt_collection: &UncheckedAccount<'info>,
    payer: &Signer<'info>,
    receipt_authority: &UncheckedAccount<'info>,
    new_owner: &UncheckedAccount<'info>,
    mpl_core_program: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    receipt_authority_seeds: &[&[u8]],
) -> Result<()> {
    TransferV1CpiBuilder::new(&mpl_core_program.to_account_info())
        .asset(&receipt_asset.to_account_info())
        .collection(Some(&receipt_collection.to_account_info()))
        .payer(&payer.to_account_info())
        .authority(Some(&receipt_authority.to_account_info()))
        .new_owner(&new_owner.to_account_info())
        .system_program(Some(&system_program.to_account_info()))
        .invoke_signed(&[receipt_authority_seeds])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(
    owner_proof: Option<CompressedOwnerProof>,
    bull_proof: Option<CompressedBullProof>,
    claim_class: ClaimClass,
    claim_policy_version: u64
)]
pub struct PrepareTransfer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.owner == owner.key() @ RodeoError::InvalidOwner,
        constraint = position.status == PositionStatus::Active @ RodeoError::InvalidRole,
        constraint = !position.pending_action_active @ RodeoError::PendingActionConflict,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut)]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(mut)]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(mut)]
    pub bull_registry: Box<Account<'info, BullRegistry>>,

    #[account(mut)]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    /// CHECK: MPL Core PositionReceipt asset account.
    #[account(mut)]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: Official receipt collection.
    #[account(mut)]
    pub receipt_collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA that controls the freeze plugin.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + ClaimCredit::INIT_SPACE,
        seeds = [SEED_CLAIM_CREDIT, owner.key().as_ref(), &claim_policy_version.to_le_bytes(), &[claim_class as u8]],
        bump,
    )]
    pub claim_credit: Box<Account<'info, ClaimCredit>>,

    /// CHECK: The MPL Core program; the address is constrained to the canonical ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    owner_proof: Option<CompressedOwnerProof>,
    bull_proof: Option<CompressedBullProof>
)]
pub struct ActivatePosition<'info> {
    #[account(mut)]
    pub new_owner: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.status == PositionStatus::TransferReady @ RodeoError::InvalidRole,
        constraint = !position.pending_action_active @ RodeoError::PendingActionConflict,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut)]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(mut)]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(mut)]
    pub bull_registry: Box<Account<'info, BullRegistry>>,

    #[account(mut)]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    /// CHECK: MPL Core PositionReceipt asset account.
    #[account(mut)]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: Official receipt collection.
    #[account(mut)]
    pub receipt_collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: The MPL Core program; the address is constrained to the canonical ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(claim_class: ClaimClass, claim_policy_version: u64)]
pub struct ClaimCreditAccounts<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_CLAIM_CREDIT, owner.key().as_ref(), &claim_policy_version.to_le_bytes(), &[claim_class as u8]],
        bump = claim_credit.bump,
        constraint = claim_credit.wallet == owner.key() @ RodeoError::InvalidOwner,
        constraint = claim_credit.claim_policy_version == claim_policy_version @ RodeoError::InvalidConfigVersion,
        constraint = claim_credit.claim_class == claim_class @ RodeoError::InvalidRole,
    )]
    pub claim_credit: Box<Account<'info, ClaimCredit>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + WalletClaimCooldown::INIT_SPACE,
        seeds = [SEED_CLAIM_COOLDOWN, owner.key().as_ref()],
        bump,
    )]
    pub wallet_claim_cooldown: Box<Account<'info, WalletClaimCooldown>>,

    #[account(mut)]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(mut)]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(mut)]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    #[account(
        mut,
        constraint = reward_vault.key() == global_config.reward_vault @ RodeoError::InvalidRewardVault,
        constraint = reward_vault.mint == global_config.ansem_mint @ RodeoError::InvalidAnsemMint,
    )]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_ansem_account.mint == global_config.ansem_mint @ RodeoError::InvalidRewardDestination,
        constraint = owner_ansem_account.owner == owner.key() @ RodeoError::InvalidRewardDestination,
    )]
    pub owner_ansem_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    buyer: Pubkey,
    owner_proof_remove: Option<CompressedOwnerProof>,
    bull_proof_remove: Option<CompressedBullProof>,
    owner_proof_add: Option<CompressedOwnerProof>,
    bull_proof_add: Option<CompressedBullProof>,
    claim_class: ClaimClass,
    claim_policy_version: u64
)]
pub struct NativeTransferPosition<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    /// CHECK: The buyer address; the PermanentTransferDelegate CPI transfers the
    /// receipt to this account without requiring its signature.
    #[account()]
    pub buyer: UncheckedAccount<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [SEED_POSITION, global_config.key().as_ref(), &position.position_id.to_le_bytes()],
        bump = position.bump,
        constraint = position.owner == seller.key() @ RodeoError::InvalidOwner,
        constraint = position.status == PositionStatus::Active @ RodeoError::InvalidRole,
        constraint = !position.pending_action_active @ RodeoError::PendingActionConflict,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut)]
    pub reward_state: Box<Account<'info, RewardState>>,

    #[account(mut)]
    pub bull_accumulator: Box<Account<'info, BullAccumulator>>,

    #[account(mut)]
    pub bull_registry: Box<Account<'info, BullRegistry>>,

    #[account(mut)]
    pub global_game_state: Box<Account<'info, GlobalGameState>>,

    /// CHECK: MPL Core PositionReceipt asset account.
    #[account(mut)]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: Official receipt collection.
    #[account(mut)]
    pub receipt_collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = seller,
        space = 8 + ClaimCredit::INIT_SPACE,
        seeds = [SEED_CLAIM_CREDIT, seller.key().as_ref(), &claim_policy_version.to_le_bytes(), &[claim_class as u8]],
        bump,
    )]
    pub seller_claim_credit: Box<Account<'info, ClaimCredit>>,

    /// CHECK: The MPL Core program; the address is constrained to the canonical ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn sync_position_rewards<'info>(
    position: &mut Position,
    position_key: Pubkey,
    reward_state: &mut RewardState,
    bull_accumulator: &mut BullAccumulator,
) -> Result<()> {
    crate::sync_cowboy_rewards(position, reward_state)?;
    crate::sync_bull_rewards(position, position_key, bull_accumulator, reward_state)?;
    Ok(())
}

fn checkpoint_position_claimable(
    position: &mut Position,
    claim_credit: &mut ClaimCredit,
    wallet: Pubkey,
    claim_policy_version: u64,
    claim_class: ClaimClass,
    bump: u8,
) -> Result<u64> {
    let amount = position.claimable_ansem_atomic;
    if amount > 0 {
        if claim_credit.version == 0 {
            claim_credit.version = ACCOUNT_VERSION_CLAIM_CREDIT;
            claim_credit.wallet = wallet;
            claim_credit.claim_policy_version = claim_policy_version;
            claim_credit.claim_class = claim_class;
            claim_credit.amount_atomic = 0;
            claim_credit.bump = bump;
        }
        claim_credit.amount_atomic = math::checked_add_u64(claim_credit.amount_atomic, amount)?;
        position.claimable_ansem_atomic = 0;
    }
    Ok(amount)
}

fn remove_role_from_active_counts(
    position: &Position,
    global_game_state: &mut GlobalGameState,
) -> Result<()> {
    match position.role {
        Role::Cowboy => {
            global_game_state.active_cowboy_count =
                math::checked_sub_u64(global_game_state.active_cowboy_count, 1)?;
            global_game_state.total_active_cowboy_weight = math::checked_sub_u128(
                global_game_state.total_active_cowboy_weight,
                position.accrual_weight as u128,
            )?;
        }
        Role::Bull => {
            global_game_state.active_bull_count =
                math::checked_sub_u64(global_game_state.active_bull_count, 1)?;
            global_game_state.total_active_bull_power =
                math::checked_sub_u64(global_game_state.total_active_bull_power, position.buck_power as u64)?;
        }
        Role::Unassigned => {}
    }
    Ok(())
}

fn add_role_to_active_counts(
    position: &Position,
    global_game_state: &mut GlobalGameState,
) -> Result<()> {
    match position.role {
        Role::Cowboy => {
            global_game_state.active_cowboy_count =
                math::checked_add_u64(global_game_state.active_cowboy_count, 1)?;
            global_game_state.total_active_cowboy_weight = math::checked_add_u128(
                global_game_state.total_active_cowboy_weight,
                position.accrual_weight as u128,
            )?;
        }
        Role::Bull => {
            global_game_state.active_bull_count =
                math::checked_add_u64(global_game_state.active_bull_count, 1)?;
            global_game_state.total_active_bull_power =
                math::checked_add_u64(global_game_state.total_active_bull_power, position.buck_power as u64)?;
        }
        Role::Unassigned => {}
    }
    Ok(())
}

fn remove_bull_from_current_registry(
    position: &Position,
    position_key: Pubkey,
    bull_registry: &mut BullRegistry,
    owner_proof: &CompressedOwnerProof,
    bull_proof: &CompressedBullProof,
) -> Result<()> {
    let bull_leaf = BullLeaf {
        position: position_key,
        position_id: position.position_id,
        owner: position.owner,
        buck_power: position.buck_power,
        reveal_config_version: position.reveal_config_version,
    };
    remove_bull_from_registry(bull_registry, &bull_leaf, owner_proof, bull_proof)?;
    Ok(())
}

fn add_bull_to_current_registry(
    position: &Position,
    position_key: Pubkey,
    bull_registry: &mut BullRegistry,
    owner_proof: &CompressedOwnerProof,
    bull_proof: &CompressedBullProof,
) -> Result<()> {
    let bull_leaf = BullLeaf {
        position: position_key,
        position_id: position.position_id,
        owner: position.owner,
        buck_power: position.buck_power,
        reveal_config_version: position.reveal_config_version,
    };
    add_bull_to_registry(bull_registry, &bull_leaf, owner_proof, bull_proof)?;
    Ok(())
}

fn distribute_unallocated_bull_pool(
    bull_accumulator: &mut BullAccumulator,
    reward_state: &mut RewardState,
    game_state: &GlobalGameState,
) -> Result<()> {
    let unallocated = reward_state.bull_pool_unallocated_liability_atomic;
    if unallocated > 0 && game_state.active_bull_count > 0 {
        let (new_index, new_remainder) = math::distribute_bull_unallocated_liability(
            bull_accumulator.reward_per_weight_scaled,
            bull_accumulator.bull_index_remainder_scaled,
            unallocated,
            game_state.total_active_bull_power as u128,
            REWARD_PER_WEIGHT_SCALE,
        )?;
        bull_accumulator.reward_per_weight_scaled = new_index;
        bull_accumulator.bull_index_remainder_scaled = new_remainder;
        reward_state.bull_pool_liability_atomic =
            math::checked_add_u64(reward_state.bull_pool_liability_atomic, unallocated)?;
        reward_state.bull_pool_unallocated_liability_atomic = 0;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

pub fn prepare_transfer(
    ctx: Context<PrepareTransfer>,
    owner_proof: Option<CompressedOwnerProof>,
    bull_proof: Option<CompressedBullProof>,
    claim_class: ClaimClass,
    claim_policy_version: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    // Authenticate against the live MPL Core receipt owner.
    let live_owner = parse_core_asset_owner(&ctx.accounts.receipt_asset.to_account_info())?;
    require_keys_eq!(live_owner, ctx.accounts.owner.key(), RodeoError::InvalidCoreAssetOwner);

    let position = &mut ctx.accounts.position;
    let position_key = position.key();

    // Verify caller-supplied claim metadata matches the Position.
    let expected_class = derive_claim_class(position)?;
    require!(claim_class == expected_class, RodeoError::InvalidRole);
    require!(claim_policy_version == ctx.accounts.global_config.current_config_version, RodeoError::InvalidConfigVersion);

    // 1. Synchronize rewards up to the current index.
    sync_position_rewards(
        position,
        position_key,
        &mut ctx.accounts.reward_state,
        &mut ctx.accounts.bull_accumulator,
    )?;

    // 2. Checkpoint accrued ANSEM into the outgoing wallet's ClaimCredit.
    let credit_amount = checkpoint_position_claimable(
        position,
        &mut ctx.accounts.claim_credit,
        ctx.accounts.owner.key(),
        claim_policy_version,
        claim_class,
        ctx.bumps.claim_credit,
    )?;

    // 3. Remove active participation from the economy and registry.
    if position.role == Role::Bull {
        let owner_proof = owner_proof.ok_or(RodeoError::BullProofBufferIncomplete)?;
        let bull_proof = bull_proof.ok_or(RodeoError::BullProofBufferIncomplete)?;
        remove_bull_from_current_registry(position, position_key, &mut ctx.accounts.bull_registry, &owner_proof, &bull_proof)?;
    }
    remove_role_from_active_counts(position, &mut ctx.accounts.global_game_state)?;

    // 4. Freeze further accrual while TransferReady.
    position.last_cowboy_reward_index = ctx.accounts.reward_state.cowboy_reward_index;
    position.last_bull_reward_per_weight = ctx.accounts.bull_accumulator.reward_per_weight_scaled;
    position.cowboy_accrual_remainder_scaled = 0;
    position.bull_accrual_remainder_scaled = 0;

    // 5. Transition to TransferReady and thaw the receipt.
    position.status = PositionStatus::TransferReady;

    set_receipt_frozen(
        &ctx.accounts.receipt_asset,
        &ctx.accounts.receipt_collection,
        &ctx.accounts.owner,
        &ctx.accounts.receipt_authority,
        &ctx.accounts.mpl_core_program,
        &ctx.accounts.system_program,
        &[
            SEED_RECEIPT_AUTHORITY,
            ctx.accounts.global_config.key().as_ref(),
            &[ctx.bumps.receipt_authority],
        ],
        false,
    )?;

    emit!(PositionPreparedForTransfer {
        position: position_key,
        owner: ctx.accounts.owner.key(),
        claim_policy_version,
        claim_class,
        credit_amount,
    });

    Ok(())
}

pub fn activate_position(
    ctx: Context<ActivatePosition>,
    owner_proof: Option<CompressedOwnerProof>,
    bull_proof: Option<CompressedBullProof>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    // Authority is the live receipt owner.
    let live_owner = parse_core_asset_owner(&ctx.accounts.receipt_asset.to_account_info())?;
    require_keys_eq!(live_owner, ctx.accounts.new_owner.key(), RodeoError::InvalidCoreAssetOwner);
    require_keys_eq!(ctx.accounts.position.owner, ctx.accounts.new_owner.key(), RodeoError::InvalidOwner);

    let position = &mut ctx.accounts.position;
    let position_key = position.key();

    // Any residual claimable from the TransferReady window (should be zero) is
    // checkpointed to the prior stored owner before ownership is overwritten.
    if position.claimable_ansem_atomic > 0 {
        // This path should not normally be reachable, but it prevents leakage
        // if the protocol economics are later changed.
        let prior_class = derive_claim_class(position)?;
        let prior_version = ctx.accounts.global_config.current_config_version;
        // We cannot create a new account without passing it, so this branch is a
        // no-op in the prototype.  A production version would accept an optional
        // prior-owner claim-credit account.
    }

    // Reset baseline for the incoming owner.
    position.last_cowboy_reward_index = ctx.accounts.reward_state.cowboy_reward_index;
    position.last_bull_reward_per_weight = ctx.accounts.bull_accumulator.reward_per_weight_scaled;
    position.cowboy_accrual_remainder_scaled = 0;
    position.bull_accrual_remainder_scaled = 0;

    // Re-register active participation.
    if position.role == Role::Bull {
        distribute_unallocated_bull_pool(
            &mut ctx.accounts.bull_accumulator,
            &mut ctx.accounts.reward_state,
            &ctx.accounts.global_game_state,
        )?;
        let owner_proof = owner_proof.ok_or(RodeoError::BullProofBufferIncomplete)?;
        let bull_proof = bull_proof.ok_or(RodeoError::BullProofBufferIncomplete)?;
        add_bull_to_current_registry(position, position_key, &mut ctx.accounts.bull_registry, &owner_proof, &bull_proof)?;
    }
    add_role_to_active_counts(position, &mut ctx.accounts.global_game_state)?;

    position.status = PositionStatus::Active;

    // Refreeze so ordinary Core transfers are rejected again.
    set_receipt_frozen(
        &ctx.accounts.receipt_asset,
        &ctx.accounts.receipt_collection,
        &ctx.accounts.new_owner,
        &ctx.accounts.receipt_authority,
        &ctx.accounts.mpl_core_program,
        &ctx.accounts.system_program,
        &[
            SEED_RECEIPT_AUTHORITY,
            ctx.accounts.global_config.key().as_ref(),
            &[ctx.bumps.receipt_authority],
        ],
        true,
    )?;

    emit!(PositionActivated {
        position: position_key,
        owner: ctx.accounts.new_owner.key(),
    });

    Ok(())
}

pub fn claim_credit(
    ctx: Context<ClaimCreditAccounts>,
    _claim_class: ClaimClass,
    _claim_policy_version: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    let owner = ctx.accounts.owner.key();
    let amount = ctx.accounts.claim_credit.amount_atomic;
    require!(amount > 0, RodeoError::NoClaimableRewards);

    // Wallet-level claim cooldown applies to the actual claim, not to checkpointing.
    let cooldown = &mut ctx.accounts.wallet_claim_cooldown;
    if cooldown.version == 0 {
        cooldown.version = ACCOUNT_VERSION_WALLET_CLAIM_COOLDOWN;
        cooldown.global_config = ctx.accounts.global_config.key();
        cooldown.wallet = owner;
        cooldown.last_claimed_at = 0;
        cooldown.bump = ctx.bumps.wallet_claim_cooldown;
    }
    require!(
        now >= cooldown
            .last_claimed_at
            .checked_add(CLAIM_COOLDOWN_SECONDS)
            .ok_or(RodeoError::ArithmeticOverflow)?,
        RodeoError::ClaimCooldownNotMet
    );

    let (owner_bps, bull_pool_bps) = claim_class_bps(ctx.accounts.claim_credit.claim_class);
    let owner_amount = math::floor_bps(amount, owner_bps)?;
    let bull_pool_amount = math::checked_sub_u64(amount, owner_amount)?;

    let reward_state = &mut ctx.accounts.reward_state;
    let game_state = &ctx.accounts.global_game_state;
    let bull_accumulator = &mut ctx.accounts.bull_accumulator;

    require_gte!(
        reward_state.position_claimable_liability_atomic,
        amount,
        RodeoError::LiabilityUnderflow
    );
    require_gte!(
        reward_state.recognized_reward_balance_atomic,
        owner_amount,
        RodeoError::InsufficientRecognizedRewards
    );
    require_gte!(
        reward_state.total_ansem_liability_atomic,
        owner_amount,
        RodeoError::LiabilityUnderflow
    );

    reward_state.position_claimable_liability_atomic =
        math::checked_sub_u64(reward_state.position_claimable_liability_atomic, amount)?;
    reward_state.total_ansem_liability_atomic =
        math::checked_sub_u64(reward_state.total_ansem_liability_atomic, owner_amount)?;
    reward_state.recognized_reward_balance_atomic =
        math::checked_sub_u64(reward_state.recognized_reward_balance_atomic, owner_amount)?;
    reward_state.ansem_claimed_atomic =
        math::checked_add_u64(reward_state.ansem_claimed_atomic, owner_amount)?;

    crate::transfer_ansem_from_vault(
        owner_amount,
        &*ctx.accounts.global_config,
        ctx.accounts.reward_vault.to_account_info(),
        ctx.accounts.owner_ansem_account.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
    )?;

    if bull_pool_amount > 0 {
        let source = match ctx.accounts.claim_credit.claim_class {
            ClaimClass::Desperado => crate::BullPoolSource::DesperadoClaimTax,
            _ => crate::BullPoolSource::CowboyClaimTax,
        };
        crate::distribute_bull_pool_contribution(
            source,
            bull_pool_amount,
            reward_state,
            bull_accumulator,
            game_state,
        )?;
    }

    ctx.accounts.claim_credit.amount_atomic = 0;
    cooldown.last_claimed_at = now;

    emit!(ClaimCreditClaimed {
        wallet: owner,
        claim_policy_version: ctx.accounts.claim_credit.claim_policy_version,
        claim_class: ctx.accounts.claim_credit.claim_class,
        gross_amount: amount,
        owner_amount,
        bull_pool_amount,
    });

    Ok(())
}

pub fn native_transfer_position(
    ctx: Context<NativeTransferPosition>,
    _buyer: Pubkey,
    owner_proof_remove: Option<CompressedOwnerProof>,
    bull_proof_remove: Option<CompressedBullProof>,
    owner_proof_add: Option<CompressedOwnerProof>,
    bull_proof_add: Option<CompressedBullProof>,
    claim_class: ClaimClass,
    claim_policy_version: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    // Verify live receipt owner is the seller.
    let live_owner = parse_core_asset_owner(&ctx.accounts.receipt_asset.to_account_info())?;
    require_keys_eq!(live_owner, ctx.accounts.seller.key(), RodeoError::InvalidCoreAssetOwner);
    require_keys_eq!(live_owner, ctx.accounts.position.owner, RodeoError::InvalidOwner);

    let position = &mut ctx.accounts.position;
    let position_key = position.key();

    let expected_class = derive_claim_class(position)?;
    require!(claim_class == expected_class, RodeoError::InvalidRole);
    require!(claim_policy_version == ctx.accounts.global_config.current_config_version, RodeoError::InvalidConfigVersion);

    // 1. Checkpoint seller rewards.
    sync_position_rewards(
        position,
        position_key,
        &mut ctx.accounts.reward_state,
        &mut ctx.accounts.bull_accumulator,
    )?;
    checkpoint_position_claimable(
        position,
        &mut ctx.accounts.seller_claim_credit,
        ctx.accounts.seller.key(),
        claim_policy_version,
        claim_class,
        ctx.bumps.seller_claim_credit,
    )?;

    // 2. Remove from current owner / registry.
    if position.role == Role::Bull {
        let owner_proof = owner_proof_remove.ok_or(RodeoError::BullProofBufferIncomplete)?;
        let bull_proof = bull_proof_remove.ok_or(RodeoError::BullProofBufferIncomplete)?;
        remove_bull_from_current_registry(position, position_key, &mut ctx.accounts.bull_registry, &owner_proof, &bull_proof)?;
    }
    remove_role_from_active_counts(position, &mut ctx.accounts.global_game_state)?;

    // 3. Transfer the frozen receipt to the buyer.
    transfer_receipt_via_delegate(
        &ctx.accounts.receipt_asset,
        &ctx.accounts.receipt_collection,
        &ctx.accounts.seller,
        &ctx.accounts.receipt_authority,
        &ctx.accounts.buyer,
        &ctx.accounts.mpl_core_program,
        &ctx.accounts.system_program,
        &[
            SEED_RECEIPT_AUTHORITY,
            ctx.accounts.global_config.key().as_ref(),
            &[ctx.bumps.receipt_authority],
        ],
    )?;

    // 4. Re-register under buyer.
    position.owner = ctx.accounts.buyer.key();
    position.last_cowboy_reward_index = ctx.accounts.reward_state.cowboy_reward_index;
    position.last_bull_reward_per_weight = ctx.accounts.bull_accumulator.reward_per_weight_scaled;
    position.cowboy_accrual_remainder_scaled = 0;
    position.bull_accrual_remainder_scaled = 0;

    if position.role == Role::Bull {
        distribute_unallocated_bull_pool(
            &mut ctx.accounts.bull_accumulator,
            &mut ctx.accounts.reward_state,
            &ctx.accounts.global_game_state,
        )?;
        let owner_proof = owner_proof_add.ok_or(RodeoError::BullProofBufferIncomplete)?;
        let bull_proof = bull_proof_add.ok_or(RodeoError::BullProofBufferIncomplete)?;
        add_bull_to_current_registry(position, position_key, &mut ctx.accounts.bull_registry, &owner_proof, &bull_proof)?;
    }
    add_role_to_active_counts(position, &mut ctx.accounts.global_game_state)?;

    emit!(PositionNativeTransferred {
        position: position_key,
        seller: ctx.accounts.seller.key(),
        buyer: ctx.accounts.buyer.key(),
        claim_class,
        claim_policy_version,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct PositionPreparedForTransfer {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub claim_policy_version: u64,
    pub claim_class: ClaimClass,
    pub credit_amount: u64,
}

#[event]
pub struct PositionActivated {
    pub position: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct ClaimCreditClaimed {
    pub wallet: Pubkey,
    pub claim_policy_version: u64,
    pub claim_class: ClaimClass,
    pub gross_amount: u64,
    pub owner_amount: u64,
    pub bull_pool_amount: u64,
}

#[event]
pub struct PositionNativeTransferred {
    pub position: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub claim_class: ClaimClass,
    pub claim_policy_version: u64,
}
