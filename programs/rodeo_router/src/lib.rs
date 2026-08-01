use anchor_lang::prelude::*;

declare_id!("CFQUWHE88YWrtnu9yADgEAB1MrPAYvdAjUbRwbTLafxD");

#[program]
pub mod rodeo_router {
    use super::*;

    pub fn phase_zero(_ctx: Context<PhaseZero>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct PhaseZero {}
