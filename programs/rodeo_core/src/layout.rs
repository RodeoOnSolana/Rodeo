//! Account layout constants and regression checks.  These assertions protect
//! against accidental account-size changes and provide a single place to verify
//! migration math when fields are added.

use crate::state::*;
use anchor_lang::Space;

pub const GLOBAL_CONFIG_BASE_SPACE: usize = 8 + GlobalConfig::INIT_SPACE;
pub const POSITION_BASE_SPACE: usize = 8 + Position::INIT_SPACE;
pub const CLAIM_POLICY_BASE_SPACE: usize = 8 + ClaimPolicy::INIT_SPACE;
pub const CLAIM_CREDIT_BASE_SPACE: usize = 8 + ClaimCredit::INIT_SPACE;
pub const BULL_PROOF_BUFFER_BASE_SPACE: usize = 8 + BullProofBuffer::INIT_SPACE;

// Size deltas relative to the pre-ClaimPolicy layout used in Phase 3.
// Adding `current_claim_policy_version: u64` to GlobalConfig: +8 bytes (266 -> 274).
// Adding `claim_policy_version: u64` to Position: +8 bytes (239 -> 247).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_config_size_is_expected() {
        // 8 discriminator + 274 bytes of state
        assert_eq!(GLOBAL_CONFIG_BASE_SPACE, 8 + 274);
    }

    #[test]
    fn position_size_is_expected() {
        // 8 discriminator + 247 bytes of state (was 239 before claim_policy_version)
        assert_eq!(POSITION_BASE_SPACE, 8 + 247);
    }

    #[test]
    fn claim_policy_size_is_expected() {
        // 8 discriminator + 58 bytes of state
        assert_eq!(CLAIM_POLICY_BASE_SPACE, 8 + 58);
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
        assert_eq!(
            8 + BullProofBuffer::INIT_SPACE,
            expected_fixed + crate::constants::BULL_PROOF_BUFFER_MAX_PAYLOAD
        );
    }

    #[test]
    fn claim_splits_sum_to_bps() {
        assert_eq!(
            crate::constants::CLAIM_OWNER_BPS + crate::constants::CLAIM_BULL_POOL_BPS,
            10_000
        );
        assert_eq!(
            crate::constants::DESPERADO_CLAIM_OWNER_BPS
                + crate::constants::DESPERADO_CLAIM_BULL_POOL_BPS,
            10_000
        );
    }
}
