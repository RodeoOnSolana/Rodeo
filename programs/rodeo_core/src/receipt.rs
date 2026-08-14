use crate::constants::*;
use crate::state::*;
use crate::RodeoError;
use anchor_lang::prelude::*;
use mpl_core::accounts::BaseAssetV1;
use mpl_core::types::Key as MplCoreKey;
#[cfg(feature = "test-fixtures")]
use mpl_core::types::PluginAuthority as MplCorePluginAuthority;
use mpl_core::{IndexableAsset, SolanaAccount};

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

/// Derive the official Rodeo receipt Collection PDA. The collection address
/// is the Core Collection address created by MPL Core; the stateless
/// ReceiptAuthority PDA is its update authority.
pub fn receipt_collection_pda(global_config: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_RECEIPT_COLLECTION, global_config.as_ref()],
        &crate::ID,
    )
}

/// Derive the ReceiptFunder PDA for a given Position. In the practical v1
/// funding architecture this PDA is owned by Rodeo and prefunded by the
/// Position owner; Rodeo signs for it to pay MPL Core `CreateV2`/`BurnV1`
/// and to refund/close it on reveal timeout or unstake. The seed is
/// `[b"receipt-funder", position]`.
pub fn receipt_funder_pda(position: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_RECEIPT_FUNDER, position.as_ref()], &crate::ID)
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
    IndexableAsset::fetch(MplCoreKey::AssetV1, &data)
        .map_err(|_| error!(RodeoError::CoreAssetDeserializationFailed))
}

/// Rodeo-owned, Anchor-IDL-compatible mirror of `mpl_core::types::PluginAuthority`
/// (pinned fork revision `e31f5de77a0bd23793ddf27bc887dc675ecaec75`, which matches
/// the upstream mpl-core 0.11.2 shape). This exists solely so the test-only
/// `PositionReceiptParsed` event can report the actual parsed Core plugin
/// authority kind without embedding a foreign, non-`IdlBuild` type in an
/// Anchor-visible struct (`mpl-core` is compiled with `default-features =
/// false`, so its own Anchor trait impls are not available). This type is
/// test/proof instrumentation only and is never used in production Rodeo
/// state. Gated behind `test-fixtures` so it never leaks into the default
/// production IDL alongside the fixture instructions that use it.
#[cfg(feature = "test-fixtures")]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum ReceiptPluginAuthority {
    None,
    Owner,
    UpdateAuthority,
    Address { address: Pubkey },
}

/// Renders a parsed plugin authority as a compact string for `msg!`
/// diagnostics, since the production IDL does not carry the `PositionReceiptParsed`
/// event and localnet tests cannot decode it client-side. Exhaustive over
/// the pinned 0.11.2 `PluginAuthority` shape for the same reason as the
/// `From` conversion below.
#[cfg(feature = "test-fixtures")]
pub fn format_plugin_authority(authority: Option<MplCorePluginAuthority>) -> String {
    match authority {
        None => "missing".to_string(),
        Some(MplCorePluginAuthority::None) => "none".to_string(),
        Some(MplCorePluginAuthority::Owner) => "owner".to_string(),
        Some(MplCorePluginAuthority::UpdateAuthority) => "update_authority".to_string(),
        Some(MplCorePluginAuthority::Address { address }) => format!("address:{}", address),
    }
}

/// Renders a parsed Core `UpdateAuthority` (base asset/collection update
/// authority, distinct from plugin authorities) as a compact string for
/// `msg!` diagnostics, for the same reason as `format_plugin_authority`.
/// Exhaustive over the pinned 0.11.2 `UpdateAuthority` shape (`None`,
/// `Address(Pubkey)`, `Collection(Pubkey)`).
#[cfg(feature = "test-fixtures")]
pub fn format_update_authority(authority: &mpl_core::types::UpdateAuthority) -> String {
    match authority {
        mpl_core::types::UpdateAuthority::None => "none".to_string(),
        mpl_core::types::UpdateAuthority::Address(address) => format!("address:{}", address),
        mpl_core::types::UpdateAuthority::Collection(collection) => {
            format!("collection:{}", collection)
        }
    }
}

/// Exhaustive conversion from the foreign MPL Core enum to the local mirror.
/// Deliberately has no `_` wildcard arm: if the pinned mpl-core dependency
/// ever changes `PluginAuthority`'s variants, this must fail to compile
/// rather than silently drop or misrepresent an authority kind.
#[cfg(feature = "test-fixtures")]
impl From<MplCorePluginAuthority> for ReceiptPluginAuthority {
    fn from(authority: MplCorePluginAuthority) -> Self {
        match authority {
            MplCorePluginAuthority::None => ReceiptPluginAuthority::None,
            MplCorePluginAuthority::Owner => ReceiptPluginAuthority::Owner,
            MplCorePluginAuthority::UpdateAuthority => ReceiptPluginAuthority::UpdateAuthority,
            MplCorePluginAuthority::Address { address } => {
                ReceiptPluginAuthority::Address { address }
            }
        }
    }
}

#[cfg(feature = "test-fixtures")]
#[event]
pub struct PositionReceiptParsed {
    pub receipt_asset: Pubkey,
    pub owner: Pubkey,
    pub has_permanent_transfer_delegate: bool,
    pub has_permanent_burn_delegate: bool,
    pub has_permanent_freeze_delegate: bool,
    pub frozen: bool,
    pub permanent_transfer_authority: Option<ReceiptPluginAuthority>,
    pub permanent_burn_authority: Option<ReceiptPluginAuthority>,
    pub permanent_freeze_authority: Option<ReceiptPluginAuthority>,
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

/// Same as `TestFixtureForceTransferPositionReceipt`, but for a receipt that
/// belongs to the official Rodeo receipt Collection: MPL Core's `TransferV1`
/// requires the collection account to be supplied when the asset has
/// `UpdateAuthority::Collection(...)` (otherwise it rejects with
/// `MissingCollection`), so this variant carries an extra `collection`
/// account. Kept separate from the standalone-receipt fixture above so the
/// already-proven 2D3A2 behavior is untouched.
#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(new_owner: Pubkey)]
pub struct TestFixtureForceTransferPositionReceiptInCollection<'info> {
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

    /// CHECK: The official Rodeo receipt Collection this asset belongs to.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub collection: UncheckedAccount<'info>,

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
#[instruction(name: String, uri: String)]
pub struct TestFixtureCreateReceiptCollection<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    /// CHECK: This is the new Core Collection account at the deterministic
    /// receipt-collection PDA. It does not exist before the CPI; MPL Core
    /// creates it. `CreateCollectionV2` requires this account to sign, which
    /// Rodeo provides via `invoke_signed` with this PDA's own seeds.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA, recorded as the collection's
    /// update authority. It does not need to be initialized or funded, and
    /// does not need to sign collection creation (only asset creation and
    /// updates require its signature).
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
#[instruction(name: String, uri: String)]
pub struct TestFixtureCreatePositionReceiptInCollection<'info> {
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

    /// CHECK: The official Rodeo receipt Collection this asset is created
    /// into. Must already exist (created by
    /// `test_fixture_create_receipt_collection`).
    #[account(
        mut,
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA used as the Core plugin
    /// authority and asset-creation authority (it also controls the
    /// collection, so it may add assets to it).
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
#[instruction(new_name: Option<String>, new_uri: Option<String>)]
pub struct TestFixtureUpdatePositionReceiptMetadata<'info> {
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

    /// CHECK: The official Rodeo receipt Collection this asset belongs to.
    #[account(
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA signing the metadata update. It
    /// is authorized because it is the collection's update authority, and
    /// the asset itself was created with no per-asset update authority
    /// override (so its `UpdateAuthority` resolves to `Collection(...)`).
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
#[instruction(funding_lamports: u64)]
pub struct TestFixtureCreateReceiptFunder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub position: Box<Account<'info, Position>>,

    /// CHECK: The new ReceiptFunder PDA owned by the System Program and
    /// derived by Rodeo. It is prefunded by the Position owner and Rodeo
    /// signs for it via `invoke_signed`.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_FUNDER, position.key().as_ref()],
        bump,
    )]
    pub funder: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
#[instruction(name: String, uri: String)]
pub struct TestFixtureCreatePositionReceiptInCollectionViaFunder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [SEED_GLOBAL_CONFIG],
        bump = global_config.bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    pub position: Box<Account<'info, Position>>,

    /// CHECK: This is the new Core Asset account at the PositionReceipt PDA.
    #[account(
        mut,
        seeds = [SEED_POSITION_RECEIPT, position.key().as_ref()],
        bump,
    )]
    pub receipt_asset: UncheckedAccount<'info>,

    /// CHECK: The official Rodeo receipt Collection this asset is created into.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA used as the Core plugin
    /// authority and asset-creation authority.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: The wallet that will own the Core asset (embedded owner).
    pub asset_owner: UncheckedAccount<'info>,

    /// CHECK: The ReceiptFunder PDA paying MPL Core `CreateV2` rent.
    /// It is owned by the System Program (but derived by Rodeo) and
    /// prefunded by the asset owner.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_FUNDER, position.key().as_ref()],
        bump,
    )]
    pub funder: UncheckedAccount<'info>,

    /// CHECK: MPL Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
pub struct TestFixtureForceBurnPositionReceiptInCollection<'info> {
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

    /// CHECK: The official Rodeo receipt Collection this asset belongs to.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA signing the burn.
    #[account(
        seeds = [SEED_RECEIPT_AUTHORITY, global_config.key().as_ref()],
        bump,
    )]
    pub receipt_authority: UncheckedAccount<'info>,

    /// CHECK: The System-Program-owned ReceiptFunder PDA paying MPL Core
    /// `BurnV1` and receiving the refund.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_FUNDER, position.key().as_ref()],
        bump,
    )]
    pub funder: UncheckedAccount<'info>,

    /// CHECK: MPL Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
pub struct TestFixtureCloseReceiptFunder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub position: Box<Account<'info, Position>>,

    /// CHECK: The existing System-Program-owned ReceiptFunder PDA. Its
    /// remaining lamports are transferred to the `beneficiary`.
    #[account(
        mut,
        seeds = [SEED_RECEIPT_FUNDER, position.key().as_ref()],
        bump,
    )]
    pub funder: UncheckedAccount<'info>,

    /// CHECK: The wallet that receives the funder's remaining lamports
    /// (typically the original Position owner).
    pub beneficiary: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "test-fixtures")]
#[derive(Accounts)]
pub struct TestFixtureRelinquishUpdateAuthority<'info> {
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

    /// CHECK: The official Rodeo receipt Collection this asset belongs to.
    #[account(
        seeds = [SEED_RECEIPT_COLLECTION, global_config.key().as_ref()],
        bump,
    )]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: Stateless ReceiptAuthority PDA signing the update to `None`.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// Deterministic vector: GlobalConfig PDA for the deployed rodeo_core
    /// program id, seeded by `[b"global-config"]`.
    fn sample_global_config() -> Pubkey {
        Pubkey::find_program_address(&[SEED_GLOBAL_CONFIG], &crate::ID).0
    }

    #[test]
    fn receipt_authority_pda_matches_known_vector() {
        let global_config = sample_global_config();
        assert_eq!(
            global_config,
            Pubkey::from_str("3475hq7chmBk1J2EPLErFoqMNyV8BgPrHgbyVQe2Csbb").unwrap(),
            "global_config PDA vector drifted; update this test's expectations only if the seeds intentionally changed"
        );

        let (receipt_authority, bump) = receipt_authority_pda(&global_config);
        assert_eq!(
            receipt_authority,
            Pubkey::from_str("EXnvfnDL8wuyEVDaqej2YgEBH4Uqm7d7uwo9wbEQrMmn").unwrap()
        );
        assert_eq!(bump, 254);

        // Re-derivation must be deterministic.
        let (receipt_authority_again, bump_again) = receipt_authority_pda(&global_config);
        assert_eq!(receipt_authority, receipt_authority_again);
        assert_eq!(bump, bump_again);
    }

    #[test]
    fn position_receipt_pda_matches_known_vector() {
        let sample_position = Pubkey::from_str("11111111111111111111111111111112").unwrap();

        let (receipt, bump) = position_receipt_pda(&sample_position);
        assert_eq!(
            receipt,
            Pubkey::from_str("8C61ujku6iXMuTjPcsiiRyyHPbrqwnzxJLfv143oTxES").unwrap()
        );
        assert_eq!(bump, 254);

        // Re-derivation must be deterministic.
        let (receipt_again, bump_again) = position_receipt_pda(&sample_position);
        assert_eq!(receipt, receipt_again);
        assert_eq!(bump, bump_again);
    }

    #[test]
    fn receipt_authority_and_position_receipt_pdas_are_distinct() {
        let global_config = sample_global_config();
        let sample_position = Pubkey::from_str("11111111111111111111111111111112").unwrap();

        let (receipt_authority, _) = receipt_authority_pda(&global_config);
        let (receipt, _) = position_receipt_pda(&sample_position);

        assert_ne!(receipt_authority, receipt);
    }

    #[test]
    fn receipt_collection_pda_matches_known_vector() {
        let global_config = sample_global_config();

        let (collection, bump) = receipt_collection_pda(&global_config);
        assert_eq!(
            collection,
            Pubkey::from_str("BmAhBkoQxovBbH9mBrf9vQwHr2Xyo4BTdZt6QozBRcY9").unwrap()
        );
        assert_eq!(bump, 254);

        // Re-derivation must be deterministic, and distinct from the
        // ReceiptAuthority PDA and any PositionReceipt PDA.
        let (collection_again, bump_again) = receipt_collection_pda(&global_config);
        assert_eq!(collection, collection_again);
        assert_eq!(bump, bump_again);

        let (receipt_authority, _) = receipt_authority_pda(&global_config);
        assert_ne!(collection, receipt_authority);
    }

    #[test]
    fn receipt_funder_pda_matches_known_vector() {
        let sample_position = Pubkey::from_str("11111111111111111111111111111112").unwrap();

        let (funder, bump) = receipt_funder_pda(&sample_position);
        assert_eq!(
            funder,
            Pubkey::from_str("DAHSFB2aGqgv37TPiZGHttJazqazVBqBRfa7zXdkfC1X").unwrap()
        );
        assert_eq!(bump, 254);

        // Re-derivation must be deterministic and distinct from the
        // PositionReceipt PDA.
        let (funder_again, bump_again) = receipt_funder_pda(&sample_position);
        assert_eq!(funder, funder_again);
        assert_eq!(bump, bump_again);

        let (receipt, _) = position_receipt_pda(&sample_position);
        assert_ne!(funder, receipt);
    }

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn receipt_plugin_authority_mirrors_none_variant() {
        let converted: ReceiptPluginAuthority = MplCorePluginAuthority::None.into();
        assert_eq!(converted, ReceiptPluginAuthority::None);
    }

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn receipt_plugin_authority_mirrors_owner_variant() {
        let converted: ReceiptPluginAuthority = MplCorePluginAuthority::Owner.into();
        assert_eq!(converted, ReceiptPluginAuthority::Owner);
    }

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn receipt_plugin_authority_mirrors_update_authority_variant() {
        let converted: ReceiptPluginAuthority = MplCorePluginAuthority::UpdateAuthority.into();
        assert_eq!(converted, ReceiptPluginAuthority::UpdateAuthority);
    }

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn receipt_plugin_authority_mirrors_address_variant() {
        let address = Pubkey::from_str("79PJ9kijazYdkds7dmeJThJifPfuYdnYNbs9WTvVLmN3").unwrap();
        let converted: ReceiptPluginAuthority = MplCorePluginAuthority::Address { address }.into();
        assert_eq!(converted, ReceiptPluginAuthority::Address { address });
    }
}
