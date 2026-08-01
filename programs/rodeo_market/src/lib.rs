use anchor_lang::prelude::*;

declare_id!("9vhrgTdridvE1uuxPenqDW9RVKdu3A5Dc2DzKVbaew8n");

#[program]
pub mod rodeo_market {
    use super::*;

    pub fn phase_zero(_ctx: Context<PhaseZero>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct PhaseZero {}
