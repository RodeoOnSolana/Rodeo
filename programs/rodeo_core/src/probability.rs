use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

use crate::constants::*;
use crate::math;
use crate::state;
use crate::RodeoError;

pub const ROLE_TABLE: ProbabilityTable = ProbabilityTable {
    denominator: 10_000_000,
    weights: &[9_000_000, 1_000_000],
};

pub const COWBOY_RANK_TABLE: ProbabilityTable = ProbabilityTable {
    denominator: 9_000_000,
    weights: &[
        4_047_750, 2_248_750, 1_169_350, 719_600, 449_750, 269_850, 89_950, 5_000,
    ],
};

pub const BULL_TIER_TABLE: ProbabilityTable = ProbabilityTable {
    denominator: 1_000_000,
    weights: &[600_000, 250_000, 100_000, 50_000],
};

pub const SUIT_TABLE: ProbabilityTable = ProbabilityTable {
    denominator: 10_000_000,
    weights: &[2_500_000, 2_500_000, 2_500_000, 2_500_000],
};

pub const THEFT_FLAG_TABLE: ProbabilityTable = ProbabilityTable {
    denominator: 10_000_000,
    weights: &[500_000, 9_500_000],
};

pub const UNSTAKE_THEFT_FLAG_TABLE: ProbabilityTable = THEFT_FLAG_TABLE;

pub struct ProbabilityTable {
    pub denominator: u64,
    pub weights: &'static [u64],
}

impl ProbabilityTable {
    pub fn validate(&self) -> Result<()> {
        require!(self.denominator > 0, RodeoError::InvalidProbabilityTable);
        require!(
            !self.weights.is_empty(),
            RodeoError::InvalidProbabilityTable
        );
        let sum = self
            .weights
            .iter()
            .try_fold(0u64, |acc, &w| math::checked_add_u64(acc, w))?;
        require_eq!(sum, self.denominator, RodeoError::InvalidProbabilityTable);
        Ok(())
    }

    pub fn outcome_index_for_draw(&self, draw: u64) -> Result<usize> {
        require!(
            draw < self.denominator,
            RodeoError::InvalidProbabilityOutcome
        );
        let mut cumulative = 0u64;
        for (i, &weight) in self.weights.iter().enumerate() {
            cumulative = math::checked_add_u64(cumulative, weight)?;
            if draw < cumulative {
                return Ok(i);
            }
        }
        err!(RodeoError::InvalidProbabilityTable)
    }
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize, Debug)]
pub enum RandomnessDomain {
    Reveal = 0,
    Unstake = 1,
    MintTheft = 2,
    UnstakeTheft = 3,
    Role = 4,
    CowboyKind = 5,
    BullTier = 6,
    Suit = 7,
}

#[derive(Clone, Copy)]
pub struct RandomnessSampleContext {
    pub random_output: [u8; 32],
    pub domain: RandomnessDomain,
    pub position: Pubkey,
    pub action_nonce: u64,
}

/// Deterministic rejection sampling that returns an exactly uniform integer in
/// [0, denominator - 1]. The preimage binds the random bytes to the domain,
/// position, action nonce, and a deterministic retry counter so the same output
/// cannot be reused across contexts.
///
/// Preimage layout (100 bytes total):
///   [0..19]    RANDOMNESS_DOMAIN_PREFIX (19 bytes)
///   [19]       domain discriminant (1 byte)
///   [20..52]   random_output (32 bytes)
///   [52..84]   position pubkey (32 bytes)
///   [84..92]   action_nonce as little-endian u64 (8 bytes)
///   [92..100]  retry_counter as little-endian u64 (8 bytes)
pub fn rejection_sample_draw(ctx: RandomnessSampleContext, denominator: u64) -> Result<u64> {
    require!(denominator > 0, RodeoError::InvalidProbabilityTable);

    const PREIMAGE_LEN: usize = RANDOMNESS_DOMAIN_PREFIX.len() + 1 + 32 + 32 + 8 + 8;
    let mut preimage = [0u8; PREIMAGE_LEN];
    let mut offset = 0;

    preimage[offset..offset + RANDOMNESS_DOMAIN_PREFIX.len()]
        .copy_from_slice(RANDOMNESS_DOMAIN_PREFIX);
    offset += RANDOMNESS_DOMAIN_PREFIX.len();

    preimage[offset] = ctx.domain as u8;
    offset += 1;

    preimage[offset..offset + 32].copy_from_slice(&ctx.random_output);
    offset += 32;

    preimage[offset..offset + 32].copy_from_slice(ctx.position.as_ref());
    offset += 32;

    preimage[offset..offset + 8].copy_from_slice(&ctx.action_nonce.to_le_bytes());
    offset += 8;

    let range_size = 1u128 << 64;
    let denominator_u128 = denominator as u128;
    let limit = range_size - (range_size % denominator_u128);

    for retry in 0..REJECTION_SAMPLING_MAX_RETRIES {
        preimage[offset..offset + 8].copy_from_slice(&retry.to_le_bytes());
        let digest = hash(&preimage).to_bytes();

        for chunk_index in 0..4 {
            let chunk = &digest[chunk_index * 8..(chunk_index + 1) * 8];
            let candidate = u64::from_le_bytes(chunk.try_into().unwrap()) as u128;
            if candidate < limit {
                return Ok((candidate % denominator_u128) as u64);
            }
        }
    }

    err!(RodeoError::RejectionSamplingExhausted)
}

pub fn map_role(ctx: RandomnessSampleContext) -> Result<state::Role> {
    let draw = rejection_sample_draw(ctx, ROLE_TABLE.denominator)?;
    let idx = ROLE_TABLE.outcome_index_for_draw(draw)?;
    match idx {
        0 => Ok(state::Role::Cowboy),
        _ => Ok(state::Role::Bull),
    }
}

pub fn map_cowboy_kind(ctx: RandomnessSampleContext) -> Result<state::CowboyKind> {
    let draw = rejection_sample_draw(ctx, COWBOY_RANK_TABLE.denominator)?;
    let idx = COWBOY_RANK_TABLE.outcome_index_for_draw(draw)?;
    match idx {
        0 => Ok(state::CowboyKind::Rank(4)),
        1 => Ok(state::CowboyKind::Rank(5)),
        2 => Ok(state::CowboyKind::Rank(6)),
        3 => Ok(state::CowboyKind::Rank(7)),
        4 => Ok(state::CowboyKind::Rank(8)),
        5 => Ok(state::CowboyKind::Rank(9)),
        6 => Ok(state::CowboyKind::Rank(10)),
        _ => Ok(state::CowboyKind::Desperado),
    }
}

pub fn map_bull_tier(ctx: RandomnessSampleContext) -> Result<u8> {
    let draw = rejection_sample_draw(ctx, BULL_TIER_TABLE.denominator)?;
    let idx = BULL_TIER_TABLE.outcome_index_for_draw(draw)?;
    Ok((idx as u8) + 1)
}

pub fn map_suit(ctx: RandomnessSampleContext) -> Result<state::Suit> {
    let draw = rejection_sample_draw(ctx, SUIT_TABLE.denominator)?;
    let idx = SUIT_TABLE.outcome_index_for_draw(draw)?;
    match idx {
        0 => Ok(state::Suit::Hearts),
        1 => Ok(state::Suit::Diamonds),
        2 => Ok(state::Suit::Clubs),
        _ => Ok(state::Suit::Spades),
    }
}

pub fn map_mint_theft_flag(ctx: RandomnessSampleContext) -> Result<bool> {
    let draw = rejection_sample_draw(ctx, THEFT_FLAG_TABLE.denominator)?;
    let idx = THEFT_FLAG_TABLE.outcome_index_for_draw(draw)?;
    Ok(idx == 0)
}

pub fn map_unstake_theft_flag(ctx: RandomnessSampleContext) -> Result<bool> {
    let draw = rejection_sample_draw(ctx, UNSTAKE_THEFT_FLAG_TABLE.denominator)?;
    let idx = UNSTAKE_THEFT_FLAG_TABLE.outcome_index_for_draw(draw)?;
    Ok(idx == 0)
}

pub fn accrual_weight_for_rank(rank: u8) -> u32 {
    match rank {
        4 => 10_000,
        5 => 10_500,
        6 => 11_000,
        7 => 11_800,
        8 => 12_800,
        9 => 14_000,
        10 => 15_500,
        _ => 10_000,
    }
}

pub fn buck_power_for_tier(tier: u8) -> u8 {
    match tier {
        1 => 4,
        2 => 6,
        3 => 8,
        4 => 10,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position_from_u64(n: u64) -> Pubkey {
        let mut bytes = [0u8; 32];
        bytes[0..8].copy_from_slice(&n.to_le_bytes());
        Pubkey::new_from_array(bytes)
    }

    #[test]
    fn tables_are_valid() {
        for table in [
            ROLE_TABLE,
            COWBOY_RANK_TABLE,
            BULL_TIER_TABLE,
            SUIT_TABLE,
            THEFT_FLAG_TABLE,
            UNSTAKE_THEFT_FLAG_TABLE,
        ] {
            table.validate().unwrap();
        }
    }

    #[test]
    fn outcome_index_respects_boundaries() {
        let idx = ROLE_TABLE.outcome_index_for_draw(0).unwrap();
        assert_eq!(idx, 0);
        let idx = ROLE_TABLE
            .outcome_index_for_draw(ROLE_TABLE.denominator - 1)
            .unwrap();
        assert_eq!(idx, 1);
    }

    #[test]
    fn rejection_sampling_produces_valid_draws() {
        let ctx = RandomnessSampleContext {
            random_output: [1u8; 32],
            domain: RandomnessDomain::Role,
            position: position_from_u64(42),
            action_nonce: 7,
        };
        let draw = rejection_sample_draw(ctx, ROLE_TABLE.denominator).unwrap();
        assert!(draw < ROLE_TABLE.denominator);
    }

    #[test]
    fn role_mapping_is_stable() {
        let ctx = RandomnessSampleContext {
            random_output: [7u8; 32],
            domain: RandomnessDomain::Role,
            position: position_from_u64(123),
            action_nonce: 0,
        };
        let first = map_role(ctx).unwrap();
        let second = map_role(ctx).unwrap();
        assert_eq!(first, second);
    }
}
