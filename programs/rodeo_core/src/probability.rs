use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

use crate::constants::*;
use crate::math;
use crate::state;
use crate::state::ProtocolConfig;
use crate::RodeoError;

pub const ROLE_TABLE: ProbabilityTable<'static> = ProbabilityTable {
    denominator: 10_000_000,
    weights: &[9_000_000, 1_000_000],
};

pub const COWBOY_RANK_TABLE: ProbabilityTable<'static> = ProbabilityTable {
    denominator: 9_000_000,
    weights: &[
        4_047_750, 2_248_750, 1_169_350, 719_600, 449_750, 269_850, 89_950, 5_000,
    ],
};

pub const BULL_TIER_TABLE: ProbabilityTable<'static> = ProbabilityTable {
    denominator: 1_000_000,
    weights: &[600_000, 250_000, 100_000, 50_000],
};

pub const SUIT_TABLE: ProbabilityTable<'static> = ProbabilityTable {
    denominator: 10_000_000,
    weights: &[2_500_000, 2_500_000, 2_500_000, 2_500_000],
};

pub const THEFT_FLAG_TABLE: ProbabilityTable<'static> = ProbabilityTable {
    denominator: 10_000_000,
    weights: &[500_000, 9_500_000],
};

pub const UNSTAKE_THEFT_FLAG_TABLE: ProbabilityTable<'static> = THEFT_FLAG_TABLE;

/// Accrual weights for Cowboy outcomes, in the same order as `COWBOY_RANK_TABLE`:
///   rank4, rank5, rank6, rank7, rank8, rank9, rank10, desperado.
pub const DEFAULT_COWBOY_ACCRUAL_WEIGHTS: [u32; 8] = [
    10_000, 10_500, 11_000, 11_800, 12_800, 14_000, 15_500, 10_000,
];

/// Buck powers for Bull tiers, in order: tier1, tier2, tier3, tier4.
pub const DEFAULT_BULL_BUCK_POWERS: [u8; 4] = [4, 6, 8, 10];

pub struct ProbabilityTable<'a> {
    pub denominator: u64,
    pub weights: &'a [u64],
}

impl<'a> ProbabilityTable<'a> {
    pub fn validate(&self) -> Result<()> {
        validate_probability_table(self.denominator, self.weights)
    }

    pub fn outcome_index_for_draw(&self, draw: u64) -> Result<usize> {
        outcome_index_for_draw(self.denominator, self.weights, draw)
    }
}

pub fn validate_probability_table(denominator: u64, weights: &[u64]) -> Result<()> {
    require!(denominator > 0, RodeoError::InvalidProbabilityTable);
    require!(!weights.is_empty(), RodeoError::InvalidProbabilityTable);

    for &w in weights.iter() {
        require!(w <= denominator, RodeoError::InvalidProbabilityTable);
    }

    let sum = weights
        .iter()
        .try_fold(0u64, |acc, &w| math::checked_add_u64(acc, w))?;
    require_eq!(sum, denominator, RodeoError::InvalidProbabilityTable);
    Ok(())
}

pub fn outcome_index_for_draw(denominator: u64, weights: &[u64], draw: u64) -> Result<usize> {
    require!(draw < denominator, RodeoError::InvalidProbabilityOutcome);
    let mut cumulative = 0u64;
    for (i, &weight) in weights.iter().enumerate() {
        cumulative = math::checked_add_u64(cumulative, weight)?;
        if draw < cumulative {
            return Ok(i);
        }
    }
    err!(RodeoError::InvalidProbabilityTable)
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
            let candidate = u64::from_be_bytes(chunk.try_into().unwrap()) as u128;
            if candidate < limit {
                return Ok((candidate % denominator_u128) as u64);
            }
        }
    }

    err!(RodeoError::RejectionSamplingExhausted)
}

pub fn map_role(ctx: RandomnessSampleContext, config: &ProtocolConfig) -> Result<state::Role> {
    let table = ProbabilityTable {
        denominator: PROBABILITY_DENOMINATOR,
        weights: &config.role_weights,
    };
    let draw = rejection_sample_draw(ctx, table.denominator)?;
    let idx = table.outcome_index_for_draw(draw)?;
    match idx {
        0 => Ok(state::Role::Cowboy),
        _ => Ok(state::Role::Bull),
    }
}

pub fn map_cowboy_kind(
    ctx: RandomnessSampleContext,
    config: &ProtocolConfig,
) -> Result<state::CowboyKind> {
    let table = ProbabilityTable {
        denominator: config
            .cowboy_rank_weights
            .iter()
            .try_fold(0u64, |acc, &w| math::checked_add_u64(acc, w))?,
        weights: &config.cowboy_rank_weights,
    };
    let draw = rejection_sample_draw(ctx, table.denominator)?;
    let idx = table.outcome_index_for_draw(draw)?;
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

pub fn map_bull_tier(ctx: RandomnessSampleContext, config: &ProtocolConfig) -> Result<u8> {
    let table = ProbabilityTable {
        denominator: config
            .bull_tier_weights
            .iter()
            .try_fold(0u64, |acc, &w| math::checked_add_u64(acc, w))?,
        weights: &config.bull_tier_weights,
    };
    let draw = rejection_sample_draw(ctx, table.denominator)?;
    let idx = table.outcome_index_for_draw(draw)?;
    Ok((idx as u8) + 1)
}

pub fn map_suit(ctx: RandomnessSampleContext, config: &ProtocolConfig) -> Result<state::Suit> {
    let table = ProbabilityTable {
        denominator: PROBABILITY_DENOMINATOR,
        weights: &config.suit_weights,
    };
    let draw = rejection_sample_draw(ctx, table.denominator)?;
    let idx = table.outcome_index_for_draw(draw)?;
    match idx {
        0 => Ok(state::Suit::Hearts),
        1 => Ok(state::Suit::Diamonds),
        2 => Ok(state::Suit::Clubs),
        _ => Ok(state::Suit::Spades),
    }
}

pub fn map_mint_theft_flag(ctx: RandomnessSampleContext, config: &ProtocolConfig) -> Result<bool> {
    let table = ProbabilityTable {
        denominator: PROBABILITY_DENOMINATOR,
        weights: &config.mint_theft_weights,
    };
    let draw = rejection_sample_draw(ctx, table.denominator)?;
    let idx = table.outcome_index_for_draw(draw)?;
    Ok(idx == 0)
}

pub fn map_unstake_theft_flag(
    ctx: RandomnessSampleContext,
    config: &ProtocolConfig,
) -> Result<bool> {
    let table = ProbabilityTable {
        denominator: PROBABILITY_DENOMINATOR,
        weights: &config.unstake_theft_weights,
    };
    let draw = rejection_sample_draw(ctx, table.denominator)?;
    let idx = table.outcome_index_for_draw(draw)?;
    Ok(idx == 0)
}

/// Returns the accrual weight for a Cowboy outcome index (0..7) as stored in
/// `ProtocolConfig.cowboy_accrual_weights`.
pub fn accrual_weight_for_cowboy_index(config: &ProtocolConfig, index: usize) -> u32 {
    config.cowboy_accrual_weights[index]
}

/// Returns the buck power for a Bull tier (1..4) using the values in
/// `ProtocolConfig.bull_buck_powers`.
pub fn buck_power_for_tier(config: &ProtocolConfig, tier: u8) -> u8 {
    if (1..=4).contains(&tier) {
        config.bull_buck_powers[(tier - 1) as usize]
    } else {
        0
    }
}

/// Validates all probability tables and mappings in a `ProtocolConfig`.
pub fn validate_protocol_config(config: &ProtocolConfig) -> Result<()> {
    validate_probability_table(PROBABILITY_DENOMINATOR, &config.role_weights)?;

    let cowboy_denominator = config
        .cowboy_rank_weights
        .iter()
        .try_fold(0u64, |acc, &w| math::checked_add_u64(acc, w))?;
    require_eq!(
        cowboy_denominator,
        config.role_weights[0],
        RodeoError::InvalidProbabilityTable
    );
    validate_probability_table(cowboy_denominator, &config.cowboy_rank_weights)?;

    let bull_denominator = config
        .bull_tier_weights
        .iter()
        .try_fold(0u64, |acc, &w| math::checked_add_u64(acc, w))?;
    require_eq!(
        bull_denominator,
        config.role_weights[1],
        RodeoError::InvalidProbabilityTable
    );
    validate_probability_table(bull_denominator, &config.bull_tier_weights)?;

    validate_probability_table(PROBABILITY_DENOMINATOR, &config.suit_weights)?;
    validate_probability_table(PROBABILITY_DENOMINATOR, &config.mint_theft_weights)?;
    validate_probability_table(PROBABILITY_DENOMINATOR, &config.unstake_theft_weights)?;

    require_gte!(
        config.min_bulls_for_theft,
        1,
        RodeoError::InvalidProbabilityTable
    );

    require_eq!(
        math::checked_add_u64(config.unstake_tax_bps, config.unstake_return_bps)?,
        BPS_DENOMINATOR,
        RodeoError::InvalidBps
    );

    require!(
        config.unstake_tax_bps <= BPS_DENOMINATOR,
        RodeoError::InvalidBps
    );
    require!(
        config.unstake_return_bps <= BPS_DENOMINATOR,
        RodeoError::InvalidBps
    );

    for &w in config.cowboy_accrual_weights.iter() {
        require!(w > 0, RodeoError::InvalidProbabilityTable);
    }

    for &p in config.bull_buck_powers.iter() {
        require!(p > 0, RodeoError::InvalidProbabilityTable);
    }

    Ok(())
}

/// Builds a V1 `ProtocolConfig` from the canonical hardcoded constants. This is
/// the only place the default constants are used; all settlement logic reads
/// from the versioned account.
pub fn protocol_config_v1(global_config: Pubkey, bump: u8) -> ProtocolConfig {
    ProtocolConfig {
        version: ACCOUNT_VERSION_PROTOCOL_CONFIG,
        global_config,
        config_version: 1,
        role_weights: [ROLE_TABLE.weights[0], ROLE_TABLE.weights[1]],
        cowboy_rank_weights: [
            COWBOY_RANK_TABLE.weights[0],
            COWBOY_RANK_TABLE.weights[1],
            COWBOY_RANK_TABLE.weights[2],
            COWBOY_RANK_TABLE.weights[3],
            COWBOY_RANK_TABLE.weights[4],
            COWBOY_RANK_TABLE.weights[5],
            COWBOY_RANK_TABLE.weights[6],
            COWBOY_RANK_TABLE.weights[7],
        ],
        bull_tier_weights: [
            BULL_TIER_TABLE.weights[0],
            BULL_TIER_TABLE.weights[1],
            BULL_TIER_TABLE.weights[2],
            BULL_TIER_TABLE.weights[3],
        ],
        suit_weights: [
            SUIT_TABLE.weights[0],
            SUIT_TABLE.weights[1],
            SUIT_TABLE.weights[2],
            SUIT_TABLE.weights[3],
        ],
        mint_theft_weights: [THEFT_FLAG_TABLE.weights[0], THEFT_FLAG_TABLE.weights[1]],
        unstake_theft_weights: [
            UNSTAKE_THEFT_FLAG_TABLE.weights[0],
            UNSTAKE_THEFT_FLAG_TABLE.weights[1],
        ],
        cowboy_accrual_weights: DEFAULT_COWBOY_ACCRUAL_WEIGHTS,
        bull_buck_powers: DEFAULT_BULL_BUCK_POWERS,
        min_reveals_for_theft: MIN_REVEALS_FOR_THEFT,
        min_bulls_for_theft: MIN_BULLS_FOR_THEFT,
        unstake_tax_bps: UNSTAKE_TAX_BPS,
        unstake_return_bps: UNSTAKE_RETURN_BPS,
        bump,
        _reserved: [0u8; 64],
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
        let config = protocol_config_v1(Pubkey::default(), 0);
        let first = map_role(ctx, &config).unwrap();
        let second = map_role(ctx, &config).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn v1_protocol_config_is_valid() {
        let config = protocol_config_v1(Pubkey::default(), 0);
        validate_protocol_config(&config).unwrap();
    }

    #[test]
    fn v1_protocol_config_matches_hardcoded_tables() {
        let config = protocol_config_v1(Pubkey::default(), 0);

        assert_eq!(config.role_weights, [9_000_000, 1_000_000]);
        assert_eq!(
            config.cowboy_rank_weights,
            [4_047_750, 2_248_750, 1_169_350, 719_600, 449_750, 269_850, 89_950, 5_000]
        );
        assert_eq!(
            config.bull_tier_weights,
            [600_000, 250_000, 100_000, 50_000]
        );
        assert_eq!(config.suit_weights, [2_500_000; 4]);
        assert_eq!(config.mint_theft_weights, [500_000, 9_500_000]);
        assert_eq!(config.unstake_theft_weights, [500_000, 9_500_000]);
        assert_eq!(
            config.cowboy_accrual_weights,
            [10_000, 10_500, 11_000, 11_800, 12_800, 14_000, 15_500, 10_000]
        );
        assert_eq!(config.bull_buck_powers, [4, 6, 8, 10]);
        assert_eq!(config.min_reveals_for_theft, MIN_REVEALS_FOR_THEFT);
        assert_eq!(config.min_bulls_for_theft, MIN_BULLS_FOR_THEFT);
        assert_eq!(config.unstake_tax_bps, UNSTAKE_TAX_BPS);
        assert_eq!(config.unstake_return_bps, UNSTAKE_RETURN_BPS);
    }
}
