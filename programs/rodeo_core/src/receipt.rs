use crate::constants::*;
use crate::state::*;
use crate::RodeoError;
use anchor_lang::prelude::*;
use mpl_core::{
    BaseAssetV1, BurnV1Builder, CreateV2Builder, DataState, IndexableAsset, Key, Plugin,
    PluginAuthority, PluginAuthorityPair, PluginType, SolanaAccount, TransferV1Builder,
};

/// Derive the stateless ReceiptAuthority PDA used to sign permanent-delegate
/// CPIs. The PDA is seeded by `"receipt-authority"` and the GlobalConfig PDA.
pub fn receipt_authority_pda(global_config: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_RECEIPT_AUTHORITY, global_config.as_ref()],
        &crate::ID,
    )
}

/// Derive the PositionReceipt PDA for a given Position account. The receipt
/// address is the Core Asset address created by MPL Core.
pub fn position_receipt_pda(position: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_POSITION_RECEIPT, position.as_ref()], &crate::ID)
}

/// Manual, non-Anchor parse of the Core asset embedded owner from a Solana
/// account owned by the MPL Core program. Uses `BaseAssetV1::load` / the
/// `SolanaAccount` trait so it works without the `mpl-core` `anchor` feature.
pub fn parse_core_asset_owner(account: &AccountInfo) -> Result<Pubkey> {
    require!(
        account.owner == &mpl_core::ID,
        RodeoError::InvalidCoreAssetProgramOwner
    );
    let asset = BaseAssetV1::load(account, 0)
        .map_err(|_| error!(RodeoError::CoreAssetDeserializationFailed))?;
    Ok(asset.owner)
}

/// Parse the full Core asset (base + plugins) using `IndexableAsset::fetch`.
/// This is the same non-Anchor path and returns enough information to prove
/// which permanent delegates are installed and what their authorities are.
pub fn parse_core_asset(account: &AccountInfo) -> Result<IndexableAsset> {
    require!(
        account.owner == &mpl_core::ID,
        RodeoError::InvalidCoreAssetProgramOwner
    );
    let data = account.try_borrow_data()?;
    IndexableAsset::fetch(Key::AssetV1, &data)
        .map_err(|_| error!(RodeoError::CoreAssetDeserializationFailed))
}

#[event]
pub struct PositionReceiptParsed {
    pub receipt_asset: Pubkey,
    pub owner: Pubkey,
    pub has_permanent_transfer_delegate: bool,
    pub has_permanent_burn_delegate: bool,
    pub has_permanent_freeze_delegate: bool,
    pub frozen: bool,
    pub permanent_transfer_authority: Option<PluginAuthority>,
    pub permanent_burn_authority: Option<PluginAuthority>,
    pub permanent_freeze_authority: Option<PluginAuthority>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(name: String, uri: String)]
pub struct TestFixtureCreatePositionReceipt<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    pub position: Box<Account<'info, Position>>,

    /// CHECK: This is the new Core Asset account at the PositionReceipt PDA.
    /// It does not exist before the CPI; MPL Core creates it.
    #[account(
        mut,
        seeds = [SEED_POSITION_RECEIPT, position.key().as_ref()],
        bump,
    )]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA used as the Core plugin authority.
    /// It does not need to be initialized or funded.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: The wallet that will own the Core asset (embedded owner).
    pub asset_owner: UncheckedAccount<'info>,

    /// CHECK: MPL Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(new_owner: Pubkey)]
pub struct TestFixtureForceTransferPositionReceipt<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    pub position: Box<Account<'info, Position>>,

    /// CHECK: The existing Core Asset account at the PositionReceipt PDA.
    #[account(
        mut,
        seeds = [SEED_POSITION_RECEIPT, position.key().as_ref()],
        bump,
    )]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA signing the transfer.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: The new embedded owner wallet. Only its public key is used.
    #[account(address = new_owner)]
    pub new_owner_account: UncheckedAccount<'info>,

    /// CHECK: MPL Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
pub struct TestFixtureForceBurnPositionReceipt<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    pub position: Box<Account<'info, Position>>,

    /// CHECK: The existing Core Asset account at the PositionReceipt PDA.
    #[account(
        mut,
        seeds = [SEED_POSITION_RECEIPT, position.key().as_ref()],
        bump,
    )]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA signing the burn.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: MPL Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
pub struct TestFixtureParsePositionReceipt<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub position: Box<Account<'info, Position>>,

    /// CHECK: The Core Asset account at the PositionReceipt PDA.
    #[account(
        seeds = [SEED_POSITION_RECEIPT, position.key().as_ref()],
        bump,
    )]
    pub receipt_asset: UncheckedAccount<'info>,
}
