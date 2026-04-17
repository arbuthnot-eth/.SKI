// set_config — admin-only fee_bps update.
//
// Useful when we want to tune the fee skim without a redeploy. Admin
// holds the keys — in production that's an ultron.sui-controlled
// multisig or the keeper DO's signing agent.

use crate::state::{VaultConfig, VaultConfigInner};
use quasar_lang::prelude::*;

#[derive(Accounts)]
pub struct SetConfig {
    #[account(mut)]
    pub admin: Signer,
    #[account(mut, seeds = VaultConfig::seeds(), bump = config.bump, has_one = admin)]
    pub config: Account<VaultConfig>,
}

impl SetConfig {
    #[inline(always)]
    pub fn set(&mut self, fee_bps: u16) -> Result<(), ProgramError> {
        let admin = self.config.admin;
        let fee_vault = self.config.fee_vault;
        let bump = self.config.bump;
        self.config.set_inner(VaultConfigInner {
            admin,
            fee_bps,
            fee_vault,
            bump,
        });
        Ok(())
    }
}
