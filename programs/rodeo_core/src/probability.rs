use anchor_lang::prelude::*;

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
        4_047_750,
        2_248_750,
        1_169_350,
        719_600,
        449_750,
        269_850,
        89_950,
        5_000,
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

pub struct ProbabilityTable {
    pub denominator: u64,
    pub weights: &'static [u64],
}

impl ProbabilityTable {
    pub fn validate(&self) -> Result<()> {
        let sum = self
            .weights
            .iter()
            .try_fold(0u64, |acc, &w| math::checked_add_u64(acc, w))?;
        require_eq!(sum, self.denominator, RodeoError::InvalidProbabilityTable);
        Ok(())
    }

    pub fn outcome_index(&self, randomness: [u8; 32]) -> usize {
        let draw = uniform_draw(randomness, self.denominator);
        let mut cumulative = 0u64;
        for (i, &weight) in self.weights.iter().enumerate() {
            cumulative = cumulative.checked_add(weight).expect("validated table");
            if draw < cumulative {
                return i;
            }
        }
        // Guard for the astronomically rare uniform-draw fallback.
        self.weights.len().saturating_sub(1)
    }
}

fn uniform_draw(randomness: [u8; 32], denominator: u64) -> u64 {
    let limit = u64::MAX - (u64::MAX % denominator);
    for i in 0..4 {
        let chunk = &randomness[i * 8..(i + 1) * 8];
        let r = u64::from_le_bytes(chunk.try_into().unwrap());
        if r < limit {
            return r % denominator;
        }
    }
    let last = u64::from_le_bytes(randomness[24..32].try_into().unwrap());
    last % denominator
}

pub fn map_role(randomness: [u8; 32]) -> state::Role {
    match ROLE_TABLE.outcome_index(randomness) {
        0 => state::Role::Cowboy,
        _ => state::Role::Bull,
    }
}

pub fn map_cowboy_kind(randomness: [u8; 32]) -> state::CowboyKind {
    match COWBOY_RANK_TABLE.outcome_index(randomness) {
        0 => state::CowboyKind::Rank(4),
        1 => state::CowboyKind::Rank(5),
        2 => state::CowboyKind::Rank(6),
        3 => state::CowboyKind::Rank(7),
        4 => state::CowboyKind::Rank(8),
        5 => state::CowboyKind::Rank(9),
        6 => state::CowboyKind::Rank(10),
        _ => state::CowboyKind::Desperado,
    }
}

pub fn map_bull_tier(randomness: [u8; 32]) -> u8 {
    (BULL_TIER_TABLE.outcome_index(randomness) as u8) + 1
}

pub fn map_suit(randomness: [u8; 32]) -> state::Suit {
    match SUIT_TABLE.outcome_index(randomness) {
        0 => state::Suit::Hearts,
        1 => state::Suit::Diamonds,
        2 => state::Suit::Clubs,
        _ => state::Suit::Spades,
    }
}

pub fn map_theft_flag(randomness: [u8; 32]) -> bool {
    THEFT_FLAG_TABLE.outcome_index(randomness) == 0
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
