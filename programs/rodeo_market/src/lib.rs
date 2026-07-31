use anchor_lang::prelude::*;

declare_id!("Dai9iNJRoNVh3iFVrzaWy4n731iuM7tHaSHvMEfUdj5k");

#[program]
pub mod rodeo_market {
    use super::*;

    pub fn phase_zero(_ctx: Context<PhaseZero>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct PhaseZero {}
