// init_config — one-shot VaultConfig PDA initialization.
//
// Caller is the `payer` who also becomes the initial `admin`. Fee
// params are passed as args (sender chooses; typically 10 bps = 0.1%).
// fee_vault is the ATA that receives skim from claim outputs — owned
// by ultron.sui's Solana address in production.

use crate::state::{VaultConfig, VaultConfigInner};
use quasar_lang::prelude::*;

#[derive(Accounts)]
pub struct InitConfig {
    #[account(mut)]
    pub payer: Signer,
    #[account(init, payer = payer, seeds = VaultConfig::seeds(), bump)]
    pub config: Account<VaultConfig>,
    pub system_program: Program<System>,
}

impl InitConfig {
    #[inline(always)]
    pub fn init(
        &mut self,
        admin: Address,
        fee_bps: u16,
        fee_vault: Address,
        bumps: &InitConfigBumps,
    ) -> Result<(), ProgramError> {
        self.config.set_inner(VaultConfigInner {
            admin,
            fee_bps,
            fee_vault,
            bump: bumps.config,
        });
        Ok(())
    }
}
