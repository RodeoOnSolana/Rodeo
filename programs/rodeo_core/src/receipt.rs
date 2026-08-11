use crate::constants::*;
use crate::state::*;
use crate::RodeoError;
use anchor_lang::prelude::*;
use mpl_core::accounts::BaseAssetV1;
use mpl_core::types::{Key as MplCoreKey, PluginAuthority as MplCorePluginAuthority};
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
/// state.
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
pub fn format_plugin_authority(authority: Option<MplCorePluginAuthority>) -> String {
    match authority {
        None => "missing".to_string(),
        Some(MplCorePluginAuthority::None) => "none".to_string(),
        Some(MplCorePluginAuthority::Owner) => "owner".to_string(),
        Some(MplCorePluginAuthority::UpdateAuthority) => "update_authority".to_string(),
        Some(MplCorePluginAuthority::Address { address }) => format!("address:{}", address),
    }
}

/// Exhaustive conversion from the foreign MPL Core enum to the local mirror.
/// Deliberately has no `_` wildcard arm: if the pinned mpl-core dependency
/// ever changes `PluginAuthority`'s variants, this must fail to compile
/// rather than silently drop or misrepresent an authority kind.
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
            Pubkey::from_str("6AYZNE4bCRt2GtJ25o1XBitN2FEN5XCYLnQfLksQddRQ").unwrap(),
            "global_config PDA vector drifted; update this test's expectations only if the seeds intentionally changed"
        );

        let (receipt_authority, bump) = receipt_authority_pda(&global_config);
        assert_eq!(
            receipt_authority,
            Pubkey::from_str("79PJ9kijazYdkds7dmeJThJifPfuYdnYNbs9WTvVLmN3").unwrap()
        );
        assert_eq!(bump, 252);

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
            Pubkey::from_str("JDW5DEHYQtW9ydLqRHUY6X2FJqKZ6gB5VmTqMxLirR6i").unwrap()
        );
        assert_eq!(bump, 255);

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
    fn receipt_plugin_authority_mirrors_none_variant() {
        let converted: ReceiptPluginAuthority = MplCorePluginAuthority::None.into();
        assert_eq!(converted, ReceiptPluginAuthority::None);
    }

    #[test]
    fn receipt_plugin_authority_mirrors_owner_variant() {
        let converted: ReceiptPluginAuthority = MplCorePluginAuthority::Owner.into();
        assert_eq!(converted, ReceiptPluginAuthority::Owner);
    }

    #[test]
    fn receipt_plugin_authority_mirrors_update_authority_variant() {
        let converted: ReceiptPluginAuthority = MplCorePluginAuthority::UpdateAuthority.into();
        assert_eq!(converted, ReceiptPluginAuthority::UpdateAuthority);
    }

    #[test]
    fn receipt_plugin_authority_mirrors_address_variant() {
        let address = Pubkey::from_str("79PJ9kijazYdkds7dmeJThJifPfuYdnYNbs9WTvVLmN3").unwrap();
        let converted: ReceiptPluginAuthority = MplCorePluginAuthority::Address { address }.into();
        assert_eq!(converted, ReceiptPluginAuthority::Address { address });
    }
}
