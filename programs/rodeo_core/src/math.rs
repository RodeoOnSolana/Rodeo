use anchor_lang::prelude::*;

use crate::constants::*;
use crate::RodeoError;

pub fn checked_add_u64(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(error!(RodeoError::ArithmeticOverflow))
}

pub fn checked_sub_u64(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or(error!(RodeoError::ArithmeticOverflow))
}

pub fn checked_mul_u64(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b).ok_or(error!(RodeoError::ArithmeticOverflow))
}

pub fn checked_mul_u128(a: u128, b: u128) -> Result<u128> {
    a.checked_mul(b).ok_or(error!(RodeoError::ArithmeticOverflow))
}

pub fn floor_mul_div_u128(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c != 0, RodeoError::ArithmeticOverflow);
    let product = checked_mul_u128(a, b)?;
    Ok(product / c)
}

pub fn ceil_mul_div_u128(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c != 0, RodeoError::ArithmeticOverflow);
    let product = checked_mul_u128(a, b)?;
    Ok((product + c - 1) / c)
}

pub fn floor_bps(amount: u64, bps: u64) -> Result<u64> {
    let numerator = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    Ok((numerator / BPS_DENOMINATOR as u128) as u64)
}

pub fn bps_remainder(amount: u64, bps: u64) -> Result<u64> {
    let owner_floor = floor_bps(amount, bps)?;
    checked_sub_u64(amount, owner_floor)
}

pub fn whole_to_atomic(whole: u64, decimals: u8) -> Result<u64> {
    require_gte!(RODEO_DECIMALS_MAX, decimals, RodeoError::InvalidDecimals);
    let multiplier = 10u64
        .checked_pow(decimals as u32)
        .ok_or(error!(RodeoError::InvalidDecimals))?;
    checked_mul_u64(whole, multiplier)
}

/// Increment a global Cowboy reward index and its exact rounding carry.
pub fn increment_cowboy_index(
    current_index: u128,
    remainder: u128,
    emission: u64,
    total_weight: u128,
    scale: u128,
) -> Result<(u128, u128)> {
    require!(total_weight != 0, RodeoError::ArithmeticOverflow);
    let emission_u128 = emission as u128;
    let numerator = checked_mul_u128(emission_u128, scale)?
        .checked_add(remainder)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    let increment = numerator / total_weight;
    let new_remainder = numerator % total_weight;
    let new_index = current_index
        .checked_add(increment)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    Ok((new_index, new_remainder))
}

/// Increment a global Bull reward-per-weight index and its exact carry.
pub fn increment_bull_index(
    current_index: u128,
    remainder: u128,
    contribution: u64,
    total_power: u128,
    scale: u128,
) -> Result<(u128, u128)> {
    require!(total_power != 0, RodeoError::ArithmeticOverflow);
    let contribution_u128 = contribution as u128;
    let numerator = checked_mul_u128(contribution_u128, scale)?
        .checked_add(remainder)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    let increment = numerator / total_power;
    let new_remainder = numerator % total_power;
    let new_index = current_index
        .checked_add(increment)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    Ok((new_index, new_remainder))
}

/// Compute per-position Cowboy accrual and updated per-position remainder.
pub fn accrue_cowboy(
    current_index: u128,
    last_index: u128,
    weight: u128,
    remainder: u128,
    scale: u128,
) -> Result<(u64, u128)> {
    let delta = current_index
        .checked_sub(last_index)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    let numerator = checked_mul_u128(delta, weight)?
        .checked_add(remainder)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    let accrued = numerator / scale;
    let new_remainder = numerator % scale;
    require!(accrued <= u64::MAX as u128, RodeoError::ArithmeticOverflow);
    Ok((accrued as u64, new_remainder))
}

/// Compute per-position Bull accrual and updated per-position remainder.
pub fn accrue_bull(
    current_index: u128,
    last_index: u128,
    power: u128,
    remainder: u128,
    scale: u128,
) -> Result<(u64, u128)> {
    let delta = current_index
        .checked_sub(last_index)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    let numerator = checked_mul_u128(delta, power)?
        .checked_add(remainder)
        .ok_or(error!(RodeoError::ArithmeticOverflow))?;
    let accrued = numerator / scale;
    let new_remainder = numerator % scale;
    require!(accrued <= u64::MAX as u128, RodeoError::ArithmeticOverflow);
    Ok((accrued as u64, new_remainder))
}
