//! Account layout constants and regression checks.  These assertions protect
//! against accidental account-size changes and provide a single place to verify
//! migration math when fields are added.

use anchor_lang::Space;
use crate::state::*;

pub const GLOBAL_CONFIG_BASE_SPACE: usize = 8 + GlobalConfig::INIT_SPACE;
pub const POSITION_BASE_SPACE: usize = 8 + Position::INIT_SPACE;
pub const CLAIM_CREDIT_BASE_SPACE: usize = 8 + ClaimCredit::INIT_SPACE;
pub const BULL_PROOF_BUFFER_BASE_SPACE: usize = 8 + BullProofBuffer::INIT_SPACE;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_config_size_is_expected() {
        // 8 discriminator + 266 bytes of state (pre-ClaimPolicy layout)
        assert_eq!(GLOBAL_CONFIG_BASE_SPACE, 8 + 266);
    }

    #[test]
    fn position_size_is_expected() {
        // 8 discriminator + 239 bytes of state (pre-ClaimPolicy layout)
        assert_eq!(POSITION_BASE_SPACE, 8 + 239);
    }

    #[test]
    fn claim_credit_size_is_expected() {
        // 8 discriminator + 51 bytes of state
        assert_eq!(CLAIM_CREDIT_BASE_SPACE, 8 + 51);
    }

    #[test]
    fn bull_proof_buffer_fixed_size_is_expected() {
        // 8 discriminator + fixed fields (182 bytes) + 4-byte Vec length prefix +
        // max payload bytes.  The account data is allocated up to the expected
        // payload length at init time, but the static INIT_SPACE includes the
        // configured maximum.
        let expected_fixed = 8 + 182 + 4;
        assert_eq!(8 + BullProofBuffer::INIT_SPACE, expected_fixed + crate::constants::BULL_PROOF_BUFFER_MAX_PAYLOAD);
    }

    #[test]
    fn claim_splits_sum_to_bps() {
        assert_eq!(crate::constants::CLAIM_OWNER_BPS + crate::constants::CLAIM_BULL_POOL_BPS, 10_000);
        assert_eq!(
            crate::constants::DESPERADO_CLAIM_OWNER_BPS + crate::constants::DESPERADO_CLAIM_BULL_POOL_BPS,
            10_000
        );
    }
}
