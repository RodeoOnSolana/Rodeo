use anchor_lang::prelude::*;

declare_id!("4FT2cokb4yL9kdeiCN1zkG78zNZUYzaxrxdvWGWTcXY6");

#[program]
pub mod rodeo_router {
    use super::*;

    pub fn phase_zero(_ctx: Context<PhaseZero>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct PhaseZero {}
