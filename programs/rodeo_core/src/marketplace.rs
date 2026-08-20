use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use mpl_core::instructions::{TransferV1CpiBuilder, UpdatePluginV1CpiBuilder};
use mpl_core::types::Plugin;

use crate::{
    bull_registry::{add_bull_to_registry, remove_bull_from_registry, BullLeaf},
    borrowed_proof::{
        verify_bull_ref, verify_owner_ref, BullProofPayloadRef, BullProofRef,
        NativeTransferBullPayloadRef, OwnerProofRef,
    },
    constants::*,
    math,
    receipt::parse_core_asset_owner,
    state::*,
    transfer_proof_buffer::*,
    RewardPaid, RewardPaidReason, RodeoError,
};

// ---------------------------------------------------------------------------
// ClaimClass / ClaimPolicy helpers
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

/// Fixed V1 claim-policy version used for all ClaimCredit PDAs at launch.
const CLAIM_POLICY_VERSION_V1: [u8; 8] = 1u64.to_le_bytes();

/// Infallible variant used for PDA derivation where the Position role is
/// expected to be assigned.  This must not be used for state validation.
pub fn claim_class_of_position(position: &Position) -> ClaimClass {
    match position.role {
        Role::Bull => ClaimClass::Bull,
        Role::Cowboy => {
            if position.cowboy_kind == CowboyKind::Desperado {
                ClaimClass::Desperado
            } else {
                ClaimClass::NormalCowboy
            }
        }
        Role::Unassigned => ClaimClass::NormalCowboy,
    }
}

pub fn policy_bps(class: ClaimClass) -> (u64, u64) {
    match class {
        ClaimClass::NormalCowboy => (CLAIM_OWNER_BPS, CLAIM_BULL_POOL_BPS),
        ClaimClass::Desperado => (DESPERADO_CLAIM_OWNER_BPS, DESPERADO_CLAIM_BULL_POOL_BPS),
        ClaimClass::Bull => (BPS_DENOMINATOR, 0),
    }
}

pub fn market_authority_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_MARKET_AUTHORITY],
        &crate::constants::RODEO_MARKET_PROGRAM_ID,
    )
}

pub fn claim_credit_pda(
    wallet: &Pubkey,
    claim_policy_version: u64,
    claim_class: ClaimClass,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            SEED_CLAIM_CREDIT,
            wallet.as_ref(),
            &claim_policy_version.to_le_bytes(),
            &[claim_class as u8],
        ],
        &crate::ID,
    )
}

// ---------------------------------------------------------------------------
// Shared claim settlement
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct SettledClaim {
    pub gross_amount: u64,
    pub owner_amount: u64,
    pub bull_pool_amount: u64,
    pub reason: RewardPaidReason,
}

/// Settle a gross claim amount according to the immutable V1 claim splits.
/// This is the single canonical implementation used by both `claim_position`
/// and `claim_credit`.
pub fn settle_claim_amount<'info>(
    amount: u64,
    claim_class: ClaimClass,
    reward_state: &mut RewardState,
    bull_accumulator: &mut BullAccumulator,
    game_state: &GlobalGameState,
    global_config: &Account<'info, GlobalConfig>,
    reward_vault: &Account<'info, TokenAccount>,
    owner_ansem_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
) -> Result<SettledClaim> {
    require!(amount > 0, RodeoError::NoClaimableRewards);

    let (owner_bps, _bull_pool_bps) = policy_bps(claim_class);
    let owner_amount = math::floor_bps(amount, owner_bps)?;
    let bull_pool_amount = math::checked_sub_u64(amount, owner_amount)?;

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
        global_config,
        reward_vault.to_account_info(),
        owner_ansem_account.to_account_info(),
        token_program.to_account_info(),
    )?;

    let reason = match claim_class {
        ClaimClass::NormalCowboy => RewardPaidReason::CowboyClaim,
        ClaimClass::Desperado => RewardPaidReason::DesperadoClaim,
        ClaimClass::Bull => RewardPaidReason::BullClaim,
    };

    if bull_pool_amount > 0 {
        let source = match claim_class {
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

    Ok(SettledClaim {
        gross_amount: amount,
        owner_amount,
        bull_pool_amount,
        reason,
    })
}

// ---------------------------------------------------------------------------
// CPI helpers
// ---------------------------------------------------------------------------

fn set_receipt_frozen<'info>(
    receipt_asset: &UncheckedAccount<'info>,
    receipt_collection: &UncheckedAccount<'info>,
    payer: &AccountInfo<'info>,
    receipt_authority: &UncheckedAccount<'info>,
    mpl_core_program: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    receipt_authority_seeds: &[&[u8]],
    frozen: bool,
) -> Result<()> {
    UpdatePluginV1CpiBuilder::new(&mpl_core_program.to_account_info())
        .asset(&receipt_asset.to_account_info())
        .collection(Some(&receipt_collection.to_account_info()))
        .payer(payer)
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
    payer: &AccountInfo<'info>,
    receipt_authority: &UncheckedAccount<'info>,
    new_owner: &AccountInfo<'info>,
    mpl_core_program: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    receipt_authority_seeds: &[&[u8]],
) -> Result<()> {
    TransferV1CpiBuilder::new(&mpl_core_program.to_account_info())
        .asset(&receipt_asset.to_account_info())
        .collection(Some(&receipt_collection.to_account_info()))
        .payer(payer)
        .authority(Some(&receipt_authority.to_account_info()))
        .new_owner(new_owner)
        .system_program(Some(&system_program.to_account_info()))
        .invoke_signed(&[receipt_authority_seeds])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
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

    /// CHECK: Optional transfer BullProofBuffer (required when Position.role == Bull).
    #[account(mut)]
    pub bull_proof_buffer: Option<UncheckedAccount<'info>>,

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
        seeds = [SEED_CLAIM_CREDIT, owner.key().as_ref(), &CLAIM_POLICY_VERSION_V1, &[claim_class_of_position(&position) as u8]],
        bump,
    )]
    pub claim_credit: Box<Account<'info, ClaimCredit>>,

    /// CHECK: MPL Core program; constrained to canonical ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
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

    /// CHECK: Optional transfer BullProofBuffer (required when Position.role == Bull).
    #[account(mut)]
    pub bull_proof_buffer: Option<UncheckedAccount<'info>>,

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

    /// CHECK: MPL Core program; constrained to canonical ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
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
        seeds = [SEED_CLAIM_CREDIT, owner.key().as_ref(), &CLAIM_POLICY_VERSION_V1, &[claim_credit.claim_class as u8]],
        bump = claim_credit.bump,
        constraint = claim_credit.wallet == owner.key() @ RodeoError::InvalidOwner,
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

    /// CHECK: Optional composite transfer BullProofBuffer (required when Position.role == Bull).
    #[account(mut)]
    pub bull_proof_buffer: Option<UncheckedAccount<'info>>,

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
        seeds = [SEED_CLAIM_CREDIT, seller.key().as_ref(), &CLAIM_POLICY_VERSION_V1, &[claim_class_of_position(&position) as u8]],
        bump,
    )]
    pub seller_claim_credit: Box<Account<'info, ClaimCredit>>,

    /// CHECK: MPL Core program; constrained to canonical ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarketTransferPosition<'info> {
    /// CHECK: The current Position owner.  Does NOT sign this instruction; the
    /// seller has already authorized the sale through a Rodeo Listing, and the
    /// Rodeo market_authority PDA signs on her behalf.
    pub seller: UncheckedAccount<'info>,

    /// CHECK: The buyer address; the PermanentTransferDelegate CPI transfers the
    /// receipt to this account without requiring its signature.
    pub buyer: UncheckedAccount<'info>,

    /// The canonical Rodeo marketplace authority PDA.  It can only sign through
    /// the rodeo_market program after validating the seller-signed Listing.
    #[account(
        seeds = [SEED_MARKET_AUTHORITY],
        bump,
        seeds::program = crate::constants::RODEO_MARKET_PROGRAM_ID,
    )]
    pub market_authority: Signer<'info>,

    /// Pays rent for the seller ClaimCredit when it is created.  Has no
    /// economic authority over the credit: wallet, bump, and claim class are
    /// bound to the seller.
    #[account(mut)]
    pub payer: Signer<'info>,

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

    /// CHECK: Optional composite transfer BullProofBuffer (required when Position.role == Bull).
    #[account(mut)]
    pub bull_proof_buffer: Option<UncheckedAccount<'info>>,

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
        payer = payer,
        space = 8 + ClaimCredit::INIT_SPACE,
        seeds = [SEED_CLAIM_CREDIT, seller.key().as_ref(), &CLAIM_POLICY_VERSION_V1, &[claim_class_of_position(&position) as u8]],
        bump,
    )]
    pub seller_claim_credit: Box<Account<'info, ClaimCredit>>,

    /// CHECK: MPL Core program; constrained to canonical ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GiftPosition<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    /// CHECK: The recipient address.
    #[account()]
    pub recipient: UncheckedAccount<'info>,

    /// Pays rent for the seller ClaimCredit if it needs to be created.
    /// Has no economic authority over the credit.
    #[account(mut)]
    pub payer: Signer<'info>,

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

    /// CHECK: Optional composite transfer BullProofBuffer (required when Position.role == Bull).
    #[account(mut)]
    pub bull_proof_buffer: Option<UncheckedAccount<'info>>,

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
        payer = payer,
        space = 8 + ClaimCredit::INIT_SPACE,
        seeds = [SEED_CLAIM_CREDIT, seller.key().as_ref(), &CLAIM_POLICY_VERSION_V1, &[claim_class_of_position(&position) as u8]],
        bump,
    )]
    pub seller_claim_credit: Box<Account<'info, ClaimCredit>>,

    /// CHECK: MPL Core program; constrained to canonical ID.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn sync_position_rewards(
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
    bump: u8,
) -> Result<u64> {
    let amount = position.claimable_ansem_atomic;
    if amount > 0 {
        if claim_credit.version == 0 {
            claim_credit.version = ACCOUNT_VERSION_CLAIM_CREDIT;
            claim_credit.wallet = wallet;
            claim_credit.claim_policy_version = 1;
            claim_credit.claim_class = claim_class_of_position(position);
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

fn remove_bull_from_current_registry_with_payload(
    position: &Position,
    position_key: Pubkey,
    bull_registry: &mut BullRegistry,
    payload: &BullProofPayloadRef<'_>,
) -> Result<()> {
    let current_owner = payload.current_owner()?.ok_or(RodeoError::BullProofBufferIncomplete)?;
    let remove_bull = payload.remove_bull()?.ok_or(RodeoError::BullProofBufferIncomplete)?;

    require_keys_eq!(
        current_owner.leaf.owner,
        position.owner,
        RodeoError::BullRegistryOwnerMismatch
    );
    require_keys_eq!(
        remove_bull.leaf.position,
        position_key,
        RodeoError::BullRegistryMalformedProof
    );
    require_keys_eq!(
        remove_bull.leaf.owner,
        position.owner,
        RodeoError::BullRegistryOwnerMismatch
    );

    let bull_leaf = BullLeaf {
        position: position_key,
        position_id: position.position_id,
        owner: position.owner,
        buck_power: position.buck_power,
        reveal_config_version: position.reveal_config_version,
    };
    require!(
        remove_bull.leaf == bull_leaf,
        RodeoError::BullRegistryMalformedProof
    );

    verify_owner_ref(
        &bull_registry.owner_tree_root,
        &position.owner,
        current_owner,
    )?;
    verify_bull_ref(
        &current_owner.leaf.bull_tree_root,
        &position_key,
        remove_bull,
    )?;

    remove_bull_from_registry(
        bull_registry,
        &bull_leaf,
        &current_owner.to_owned()?,
        &remove_bull.to_owned()?,
    )?;
    Ok(())
}

fn add_bull_to_current_registry_with_payload(
    position: &Position,
    position_key: Pubkey,
    bull_registry: &mut BullRegistry,
    payload: &BullProofPayloadRef<'_>,
) -> Result<()> {
    let current_owner = payload.current_owner()?.ok_or(RodeoError::BullProofBufferIncomplete)?;
    let current_bull = payload.current_bull()?.ok_or(RodeoError::BullProofBufferIncomplete)?;

    let bull_leaf = BullLeaf {
        position: position_key,
        position_id: position.position_id,
        owner: position.owner,
        buck_power: position.buck_power,
        reveal_config_version: position.reveal_config_version,
    };

    verify_owner_ref(
        &bull_registry.owner_tree_root,
        &position.owner,
        current_owner,
    )?;
    verify_bull_ref(
        &current_owner.leaf.bull_tree_root,
        &position_key,
        current_bull,
    )?;

    add_bull_to_registry(
        bull_registry,
        &bull_leaf,
        &current_owner.to_owned()?,
        &current_bull.to_owned()?,
    )?;
    Ok(())
}

fn execute_native_transfer_composite(
    position: &Position,
    position_key: Pubkey,
    bull_registry: &mut BullRegistry,
    payload: &NativeTransferBullPayloadRef<'_>,
    seller: &Pubkey,
    buyer: &Pubkey,
) -> Result<()> {
    let seller_owner = payload.seller_owner()?.ok_or(RodeoError::BullProofBufferIncomplete)?;
    let remove_bull = payload.remove_bull()?.ok_or(RodeoError::BullProofBufferIncomplete)?;
    let buyer_owner = payload.buyer_owner()?.ok_or(RodeoError::BullProofBufferIncomplete)?;
    let add_bull = payload.add_bull()?.ok_or(RodeoError::BullProofBufferIncomplete)?;

    require_keys_eq!(
        seller_owner.leaf.owner,
        position.owner,
        RodeoError::BullRegistryOwnerMismatch
    );
    require_keys_eq!(
        seller_owner.leaf.owner,
        *seller,
        RodeoError::BullRegistryOwnerMismatch
    );
    require_keys_eq!(
        remove_bull.leaf.position,
        position_key,
        RodeoError::BullRegistryMalformedProof
    );
    require_keys_eq!(
        remove_bull.leaf.owner,
        position.owner,
        RodeoError::BullRegistryOwnerMismatch
    );
    require_keys_eq!(
        buyer_owner.leaf.owner,
        *buyer,
        RodeoError::BullRegistryOwnerMismatch
    );

    let bull_leaf = BullLeaf {
        position: position_key,
        position_id: position.position_id,
        owner: position.owner,
        buck_power: position.buck_power,
        reveal_config_version: position.reveal_config_version,
    };
    require!(
        remove_bull.leaf == bull_leaf,
        RodeoError::BullRegistryMalformedProof
    );

    // 1. Verify and apply removal against starting R0/V.
    verify_owner_ref(&bull_registry.owner_tree_root, seller, seller_owner)?;
    verify_bull_ref(&seller_owner.leaf.bull_tree_root, &position_key, remove_bull)?;

    remove_bull_from_registry(
        bull_registry,
        &bull_leaf,
        &seller_owner.to_owned()?,
        &remove_bull.to_owned()?,
    )?;

    // 2. The registry now holds authenticated intermediate root R1/V+1.
    //    Verify the buyer owner proof against the intermediate state.
    verify_owner_ref(&bull_registry.owner_tree_root, buyer, buyer_owner)?;
    verify_bull_ref(&buyer_owner.leaf.bull_tree_root, &position_key, add_bull)?;

    // 3. Add the Bull under the buyer and produce final root R2/V+2.
    add_bull_to_registry(
        bull_registry,
        &BullLeaf {
            position: position_key,
            position_id: position.position_id,
            owner: *buyer,
            buck_power: position.buck_power,
            reveal_config_version: position.reveal_config_version,
        },
        &buyer_owner.to_owned()?,
        &add_bull.to_owned()?,
    )?;

    Ok(())
}

fn reset_reward_baseline(position: &mut Position, reward_state: &RewardState, bull_accumulator: &BullAccumulator) {
    position.last_cowboy_reward_index = reward_state.cowboy_reward_index;
    position.last_bull_reward_per_weight = bull_accumulator.reward_per_weight_scaled;
    position.cowboy_accrual_remainder_scaled = 0;
    position.bull_accrual_remainder_scaled = 0;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

pub fn prepare_transfer(ctx: Context<PrepareTransfer>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    let live_owner = parse_core_asset_owner(&ctx.accounts.receipt_asset.to_account_info())?;
    require_keys_eq!(live_owner, ctx.accounts.owner.key(), RodeoError::InvalidCoreAssetOwner);

    let position = &mut ctx.accounts.position;
    let position_key = position.key();

    sync_position_rewards(
        position,
        position_key,
        &mut ctx.accounts.reward_state,
        &mut ctx.accounts.bull_accumulator,
    )?;

    let credit_amount = checkpoint_position_claimable(
        position,
        &mut ctx.accounts.claim_credit,
        ctx.accounts.owner.key(),
        ctx.bumps.claim_credit,
    )?;

    if position.role == Role::Bull {
        let buffer_info = ctx
            .accounts
            .bull_proof_buffer
            .as_ref()
            .ok_or(RodeoError::BullProofBufferIncomplete)?
            .to_account_info();
        let buffer_data = buffer_info.try_borrow_data()?;
        let payload = validate_prepare_transfer_bull_proof_buffer(
            &buffer_info,
            &buffer_data,
            &position_key,
            &ctx.accounts.owner.key(),
            &ctx.accounts.bull_registry,
            now,
        )?;
        remove_bull_from_current_registry_with_payload(position, position_key, &mut ctx.accounts.bull_registry, &payload)?;
        drop(buffer_data);
        mark_transfer_buffer_consumed(&buffer_info)?;
    }
    remove_role_from_active_counts(position, &mut ctx.accounts.global_game_state)?;

    reset_reward_baseline(position, &ctx.accounts.reward_state, &ctx.accounts.bull_accumulator);
    position.status = PositionStatus::TransferReady;
    position.state_version = math::checked_add_u64(position.state_version, 1)?;

    set_receipt_frozen(
        &ctx.accounts.receipt_asset,
        &ctx.accounts.receipt_collection,
        &ctx.accounts.owner.to_account_info(),
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

    let claim_class = claim_class_of_position(&ctx.accounts.position);

    emit!(PositionTransferPrepared {
        position: position_key,
        owner: ctx.accounts.owner.key(),
        claim_policy_version: 1,
        claim_class,
        credit_amount,
    });

    emit!(ClaimCreditCheckpointed {
        position: position_key,
        wallet: ctx.accounts.owner.key(),
        claim_policy_version: 1,
        claim_class,
        amount_atomic: credit_amount,
    });

    Ok(())
}

pub fn activate_position(ctx: Context<ActivatePosition>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    let live_owner = parse_core_asset_owner(&ctx.accounts.receipt_asset.to_account_info())?;
    require_keys_eq!(live_owner, ctx.accounts.new_owner.key(), RodeoError::InvalidCoreAssetOwner);

    let position = &mut ctx.accounts.position;
    let position_key = position.key();

    position.owner = ctx.accounts.new_owner.key();
    reset_reward_baseline(position, &ctx.accounts.reward_state, &ctx.accounts.bull_accumulator);

    if position.role == Role::Bull {
        let buffer_info = ctx
            .accounts
            .bull_proof_buffer
            .as_ref()
            .ok_or(RodeoError::BullProofBufferIncomplete)?
            .to_account_info();
        let buffer_data = buffer_info.try_borrow_data()?;
        let payload = validate_activate_position_bull_proof_buffer(
            &buffer_info,
            &buffer_data,
            &position_key,
            &ctx.accounts.new_owner.key(),
            &ctx.accounts.bull_registry,
            now,
        )?;
        distribute_unallocated_bull_pool(
            &mut ctx.accounts.bull_accumulator,
            &mut ctx.accounts.reward_state,
            &ctx.accounts.global_game_state,
        )?;
        add_bull_to_current_registry_with_payload(position, position_key, &mut ctx.accounts.bull_registry, &payload)?;
        drop(buffer_data);
        mark_transfer_buffer_consumed(&buffer_info)?;
    }
    add_role_to_active_counts(position, &mut ctx.accounts.global_game_state)?;

    position.status = PositionStatus::Active;

    set_receipt_frozen(
        &ctx.accounts.receipt_asset,
        &ctx.accounts.receipt_collection,
        &ctx.accounts.new_owner.to_account_info(),
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

pub fn claim_credit(ctx: Context<ClaimCreditAccounts>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    let amount = ctx.accounts.claim_credit.amount_atomic;
    require!(amount > 0, RodeoError::NoClaimableRewards);

    let cooldown = &mut ctx.accounts.wallet_claim_cooldown;
    if cooldown.version == 0 {
        cooldown.version = ACCOUNT_VERSION_WALLET_CLAIM_COOLDOWN;
        cooldown.global_config = ctx.accounts.global_config.key();
        cooldown.wallet = ctx.accounts.owner.key();
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

    let settled = settle_claim_amount(
        amount,
        ctx.accounts.claim_credit.claim_class,
        &mut ctx.accounts.reward_state,
        &mut ctx.accounts.bull_accumulator,
        &ctx.accounts.global_game_state,
        &ctx.accounts.global_config,
        &ctx.accounts.reward_vault,
        &ctx.accounts.owner_ansem_account,
        &ctx.accounts.token_program,
    )?;

    ctx.accounts.claim_credit.amount_atomic = 0;
    cooldown.last_claimed_at = now;

    emit!(RewardPaid {
        position: ctx.accounts.claim_credit.key(),
        owner: ctx.accounts.owner.key(),
        amount_atomic: settled.owner_amount,
        recognized_reward_balance_atomic: ctx.accounts.reward_state.recognized_reward_balance_atomic,
        reason: settled.reason,
    });

    emit!(ClaimCreditClaimed {
        wallet: ctx.accounts.owner.key(),
        claim_policy_version: ctx.accounts.claim_credit.claim_policy_version,
        claim_class: ctx.accounts.claim_credit.claim_class,
        gross_amount: settled.gross_amount,
        owner_amount: settled.owner_amount,
        bull_pool_amount: settled.bull_pool_amount,
    });

    Ok(())
}

fn perform_native_transfer<'info>(
    position: &mut Account<'info, Position>,
    seller_account: &AccountInfo<'info>,
    new_owner_account: &AccountInfo<'info>,
    receipt_asset: &UncheckedAccount<'info>,
    receipt_collection: &UncheckedAccount<'info>,
    receipt_authority: &UncheckedAccount<'info>,
    mpl_core_program: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    global_config: &Account<'info, GlobalConfig>,
    reward_state: &mut Account<'info, RewardState>,
    bull_accumulator: &mut Account<'info, BullAccumulator>,
    bull_registry: &mut Account<'info, BullRegistry>,
    global_game_state: &mut Account<'info, GlobalGameState>,
    bull_proof_buffer: Option<&UncheckedAccount<'info>>,
    seller_claim_credit: &mut Account<'info, ClaimCredit>,
    payer: &AccountInfo<'info>,
    receipt_authority_bump: u8,
    seller_claim_credit_bump: u8,
) -> Result<u64> {
    let position_key = position.key();
    let seller = seller_account.key();
    let new_owner = new_owner_account.key();
    let now = Clock::get()?.unix_timestamp;

    require!(position.owner == seller, RodeoError::InvalidOwner);
    require!(position.status == PositionStatus::Active, RodeoError::InvalidRole);
    require!(!position.pending_action_active, RodeoError::PendingActionConflict);

    sync_position_rewards(
        position,
        position_key,
        reward_state,
        bull_accumulator,
    )?;
    let credit_amount = checkpoint_position_claimable(
        position,
        seller_claim_credit,
        seller,
        seller_claim_credit_bump,
    )?;

    if position.role == Role::Bull {
        let buffer_info = bull_proof_buffer
            .ok_or(RodeoError::BullProofBufferIncomplete)?
            .to_account_info();
        let buffer_data = buffer_info.try_borrow_data()?;
        let payload = validate_native_transfer_composite_bull_proof_buffer(
            &buffer_info,
            &buffer_data,
            &position_key,
            &seller,
            bull_registry,
            now,
        )?;
        execute_native_transfer_composite(
            position,
            position_key,
            bull_registry,
            &payload,
            &seller,
            &new_owner,
        )?;
        drop(buffer_data);
        mark_transfer_buffer_consumed(&buffer_info)?;
    }
    remove_role_from_active_counts(position, global_game_state)?;

    transfer_receipt_via_delegate(
        receipt_asset,
        receipt_collection,
        payer,
        receipt_authority,
        new_owner_account,
        mpl_core_program,
        system_program,
        &[
            SEED_RECEIPT_AUTHORITY,
            global_config.key().as_ref(),
            &[receipt_authority_bump],
        ],
    )?;

    position.owner = new_owner;
    reset_reward_baseline(position, reward_state, bull_accumulator);

    if position.role == Role::Bull {
        distribute_unallocated_bull_pool(
            bull_accumulator,
            reward_state,
            global_game_state,
        )?;
    }
    add_role_to_active_counts(position, global_game_state)?;
    position.state_version = math::checked_add_u64(position.state_version, 1)?;

    Ok(credit_amount)
}

pub fn native_transfer_position(ctx: Context<NativeTransferPosition>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    let live_owner = parse_core_asset_owner(&ctx.accounts.receipt_asset.to_account_info())?;
    require_keys_eq!(live_owner, ctx.accounts.seller.key(), RodeoError::InvalidCoreAssetOwner);

    let seller = ctx.accounts.seller.key();
    let buyer = ctx.accounts.buyer.key();

    let credit_amount = perform_native_transfer(
        &mut ctx.accounts.position,
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.receipt_asset,
        &ctx.accounts.receipt_collection,
        &ctx.accounts.receipt_authority,
        &ctx.accounts.mpl_core_program,
        &ctx.accounts.system_program,
        &ctx.accounts.global_config,
        &mut ctx.accounts.reward_state,
        &mut ctx.accounts.bull_accumulator,
        &mut ctx.accounts.bull_registry,
        &mut ctx.accounts.global_game_state,
        ctx.accounts.bull_proof_buffer.as_ref(),
        &mut ctx.accounts.seller_claim_credit,
        &ctx.accounts.seller.to_account_info(),
        ctx.bumps.receipt_authority,
        ctx.bumps.seller_claim_credit,
    )?;

    emit!(PositionOwnershipTransferred {
        position: ctx.accounts.position.key(),
        seller,
        buyer,
        claim_policy_version: 1,
        claim_class: claim_class_of_position(&ctx.accounts.position),
    });

    emit!(ClaimCreditCheckpointed {
        position: ctx.accounts.position.key(),
        wallet: seller,
        claim_policy_version: 1,
        claim_class: claim_class_of_position(&ctx.accounts.position),
        amount_atomic: credit_amount,
    });

    Ok(())
}

pub fn market_transfer_position(ctx: Context<MarketTransferPosition>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    let live_owner = parse_core_asset_owner(&ctx.accounts.receipt_asset.to_account_info())?;
    require_keys_eq!(live_owner, ctx.accounts.seller.key(), RodeoError::InvalidCoreAssetOwner);

    let seller = ctx.accounts.seller.key();
    let buyer = ctx.accounts.buyer.key();

    let credit_amount = perform_native_transfer(
        &mut ctx.accounts.position,
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.receipt_asset,
        &ctx.accounts.receipt_collection,
        &ctx.accounts.receipt_authority,
        &ctx.accounts.mpl_core_program,
        &ctx.accounts.system_program,
        &ctx.accounts.global_config,
        &mut ctx.accounts.reward_state,
        &mut ctx.accounts.bull_accumulator,
        &mut ctx.accounts.bull_registry,
        &mut ctx.accounts.global_game_state,
        ctx.accounts.bull_proof_buffer.as_ref(),
        &mut ctx.accounts.seller_claim_credit,
        &ctx.accounts.market_authority.to_account_info(),
        ctx.bumps.receipt_authority,
        ctx.bumps.seller_claim_credit,
    )?;

    emit!(PositionOwnershipTransferred {
        position: ctx.accounts.position.key(),
        seller,
        buyer,
        claim_policy_version: 1,
        claim_class: claim_class_of_position(&ctx.accounts.position),
    });

    emit!(ClaimCreditCheckpointed {
        position: ctx.accounts.position.key(),
        wallet: seller,
        claim_policy_version: 1,
        claim_class: claim_class_of_position(&ctx.accounts.position),
        amount_atomic: credit_amount,
    });

    Ok(())
}

pub fn gift_position(ctx: Context<GiftPosition>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    crate::require_elapsed_epochs_closed(&ctx.accounts.reward_state, now)?;

    let live_owner = parse_core_asset_owner(&ctx.accounts.receipt_asset.to_account_info())?;
    require_keys_eq!(live_owner, ctx.accounts.seller.key(), RodeoError::InvalidCoreAssetOwner);

    let position = &mut ctx.accounts.position;
    let position_key = position.key();
    let seller = ctx.accounts.seller.key();
    let recipient = ctx.accounts.recipient.key();

    require!(position.owner == seller, RodeoError::InvalidOwner);
    require!(position.status == PositionStatus::Active, RodeoError::InvalidRole);
    require!(!position.pending_action_active, RodeoError::PendingActionConflict);

    sync_position_rewards(
        position,
        position_key,
        &mut ctx.accounts.reward_state,
        &mut ctx.accounts.bull_accumulator,
    )?;
    let credit_amount = checkpoint_position_claimable(
        position,
        &mut ctx.accounts.seller_claim_credit,
        seller,
        ctx.bumps.seller_claim_credit,
    )?;

    if position.role == Role::Bull {
        let buffer_info = ctx
            .accounts
            .bull_proof_buffer
            .as_ref()
            .ok_or(RodeoError::BullProofBufferIncomplete)?
            .to_account_info();
        let buffer_data = buffer_info.try_borrow_data()?;
        let payload = validate_native_transfer_composite_bull_proof_buffer(
            &buffer_info,
            &buffer_data,
            &position_key,
            &seller,
            &ctx.accounts.bull_registry,
            now,
        )?;
        execute_native_transfer_composite(
            position,
            position_key,
            &mut ctx.accounts.bull_registry,
            &payload,
            &seller,
            &recipient,
        )?;
        drop(buffer_data);
        mark_transfer_buffer_consumed(&buffer_info)?;
    }
    remove_role_from_active_counts(position, &mut ctx.accounts.global_game_state)?;

    transfer_receipt_via_delegate(
        &ctx.accounts.receipt_asset,
        &ctx.accounts.receipt_collection,
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.receipt_authority,
        &ctx.accounts.recipient,
        &ctx.accounts.mpl_core_program,
        &ctx.accounts.system_program,
        &[
            SEED_RECEIPT_AUTHORITY,
            ctx.accounts.global_config.key().as_ref(),
            &[ctx.bumps.receipt_authority],
        ],
    )?;

    position.owner = recipient;
    reset_reward_baseline(position, &ctx.accounts.reward_state, &ctx.accounts.bull_accumulator);

    if position.role == Role::Bull {
        distribute_unallocated_bull_pool(
            &mut ctx.accounts.bull_accumulator,
            &mut ctx.accounts.reward_state,
            &ctx.accounts.global_game_state,
        )?;
    }
    add_role_to_active_counts(position, &mut ctx.accounts.global_game_state)?;

    let claim_class = claim_class_of_position(position);
    position.state_version = math::checked_add_u64(position.state_version, 1)?;

    emit!(PositionGifted {
        position: position_key,
        seller,
        recipient,
        claim_policy_version: 1,
        claim_class,
    });

    emit!(ClaimCreditCheckpointed {
        position: position_key,
        wallet: seller,
        claim_policy_version: 1,
        claim_class,
        amount_atomic: credit_amount,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct PositionTransferPrepared {
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
pub struct PositionOwnershipTransferred {
    pub position: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub claim_policy_version: u64,
    pub claim_class: ClaimClass,
}

#[event]
pub struct PositionGifted {
    position: Pubkey,
    seller: Pubkey,
    recipient: Pubkey,
    claim_policy_version: u64,
    claim_class: ClaimClass,
}

#[event]
pub struct ClaimCreditCheckpointed {
    pub position: Pubkey,
    pub wallet: Pubkey,
    pub claim_policy_version: u64,
    pub claim_class: ClaimClass,
    pub amount_atomic: u64,
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

// ---------------------------------------------------------------------------
// Liability reconciliation tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math;
    use crate::state::{BullAccumulator, GlobalGameState, RewardState};

    fn reward_state_with(recognized: u64, claimable_liability: u64) -> RewardState {
        RewardState {
            version: ACCOUNT_VERSION_REWARD_STATE,
            global_config: Pubkey::default(),
            current_epoch: 0,
            epoch_started_at: 0,
            last_closed_epoch_timestamp: 0,
            total_ansem_liability_atomic: recognized,
            cowboy_unmaterialized_liability_atomic: 0,
            position_claimable_liability_atomic: claimable_liability,
            bull_pool_liability_atomic: 0,
            bull_pool_unallocated_liability_atomic: 0,
            suit_vault_liability_atomic: 0,
            recognized_reward_balance_atomic: recognized,
            ansem_emitted_atomic: 0,
            ansem_claimed_atomic: 0,
            orphaned_reward_released_atomic: 0,
            cowboy_reward_index: 0,
            cowboy_index_remainder_scaled: 0,
            cowboy_orphaned_accrual_remainder_scaled: 0,
            suit_epoch: 0,
            bump: 0,
        }
    }

    fn bull_accumulator() -> BullAccumulator {
        BullAccumulator {
            version: ACCOUNT_VERSION_BULL_ACCUMULATOR,
            global_config: Pubkey::default(),
            reward_per_weight_scaled: 0,
            bull_index_remainder_scaled: 0,
            bull_orphaned_accrual_remainder_scaled: 0,
            bump: 0,
        }
    }

    fn game_state() -> GlobalGameState {
        GlobalGameState {
            version: ACCOUNT_VERSION_GLOBAL_GAME_STATE,
            global_config: Pubkey::default(),
            next_position_id: 0,
            total_completed_reveals: 0,
            live_position_count: 0,
            active_cowboy_count: 1,
            active_bull_count: 0,
            total_active_cowboy_weight: 10_000,
            total_active_bull_power: 0,
            accounted_principal_atomic: 0,
            bump: 0,
        }
    }

    fn apply_claim_split(
        reward_state: &mut RewardState,
        gross: u64,
        class: ClaimClass,
    ) -> (u64, u64) {
        let (owner_bps, _) = policy_bps(class);
        let owner_amount = math::floor_bps(gross, owner_bps).unwrap();
        let bull_pool_amount = gross - owner_amount;

        reward_state.position_claimable_liability_atomic -= gross;
        reward_state.total_ansem_liability_atomic -= owner_amount;
        reward_state.recognized_reward_balance_atomic -= owner_amount;
        reward_state.ansem_claimed_atomic += owner_amount;

        if bull_pool_amount > 0 {
            reward_state.bull_pool_unallocated_liability_atomic += bull_pool_amount;
        }

        (owner_amount, bull_pool_amount)
    }

    #[test]
    fn normal_cowboy_10k_split_and_liability() {
        let mut rs = reward_state_with(10_000, 10_000);
        let (owner, bull) = apply_claim_split(&mut rs, 10_000, ClaimClass::NormalCowboy);
        assert_eq!(owner, 8_000);
        assert_eq!(bull, 2_000);
        assert_eq!(rs.position_claimable_liability_atomic, 0);
        assert_eq!(rs.total_ansem_liability_atomic, 2_000);
        assert_eq!(rs.recognized_reward_balance_atomic, 2_000);
        assert_eq!(rs.ansem_claimed_atomic, 8_000);
        assert_eq!(rs.bull_pool_unallocated_liability_atomic, 2_000);
        assert_eq!(rs.bull_pool_liability_atomic, 0);
    }

    #[test]
    fn desperado_10k_split_and_liability() {
        let mut rs = reward_state_with(10_000, 10_000);
        let (owner, bull) = apply_claim_split(&mut rs, 10_000, ClaimClass::Desperado);
        assert_eq!(owner, 9_800);
        assert_eq!(bull, 200);
        assert_eq!(rs.position_claimable_liability_atomic, 0);
        assert_eq!(rs.total_ansem_liability_atomic, 200);
        assert_eq!(rs.recognized_reward_balance_atomic, 200);
        assert_eq!(rs.ansem_claimed_atomic, 9_800);
        assert_eq!(rs.bull_pool_unallocated_liability_atomic, 200);
    }

    #[test]
    fn bull_10k_split_and_liability() {
        let mut rs = reward_state_with(10_000, 10_000);
        let (owner, bull) = apply_claim_split(&mut rs, 10_000, ClaimClass::Bull);
        assert_eq!(owner, 10_000);
        assert_eq!(bull, 0);
        assert_eq!(rs.position_claimable_liability_atomic, 0);
        assert_eq!(rs.total_ansem_liability_atomic, 0);
        assert_eq!(rs.recognized_reward_balance_atomic, 0);
        assert_eq!(rs.ansem_claimed_atomic, 10_000);
        assert_eq!(rs.bull_pool_unallocated_liability_atomic, 0);
    }

    #[test]
    fn multiple_claim_credits_aggregate() {
        let mut rs = reward_state_with(15_000, 15_000);
        let (o1, b1) = apply_claim_split(&mut rs, 10_000, ClaimClass::NormalCowboy);
        let (o2, b2) = apply_claim_split(&mut rs, 5_000, ClaimClass::NormalCowboy);
        assert_eq!(o1 + o2, 12_000);
        assert_eq!(b1 + b2, 3_000);
        assert_eq!(rs.position_claimable_liability_atomic, 0);
        assert_eq!(rs.total_ansem_liability_atomic, 3_000);
        assert_eq!(rs.recognized_reward_balance_atomic, 3_000);
        assert_eq!(rs.ansem_claimed_atomic, 12_000);
        assert_eq!(rs.bull_pool_unallocated_liability_atomic, 3_000);
    }

    #[test]
    fn zero_gross_claim_split_is_zero() {
        let (owner, bull) = policy_bps(ClaimClass::NormalCowboy);
        assert_eq!(math::floor_bps(0, owner).unwrap(), 0);
        assert_eq!(0u64.checked_sub(0).unwrap(), 0);
    }
}
