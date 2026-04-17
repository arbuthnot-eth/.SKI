// Prism Vault — Solana-side consumer for cross-chain sealed manifests.
//
// A Prism is a Thunder attachment (Seal-encrypted JSON) carrying an
// IKA-derived ed25519 signature over a canonical manifest. This program
// verifies that signature via Solana's ed25519 precompile (inspected
// from the instructions sysvar), consumes a nullifier PDA to prevent
// replay, and dispatches the requested action via CPI — SPL transfer,
// SPL-2022 confidential transfer, or a Jupiter v6 swap.
//
// SUIAMI on Sui is the authoritative identity substrate. This program
// performs NO identity lookup — it trusts whatever ed25519 pubkey the
// client passes in. The client validates the pubkey against the SUIAMI
// roster on Sui before submitting.
//
// Moves tracked in GitHub issue #164 (Zapdos):
//   Z1 Charge        — scaffold
//   Z2 Thunder Shock — VaultConfig + Nullifier state
//   Z3 Light Screen  — init_config + set_config  (you are here)
//   Z4 Signal Beam   — ed25519 sig verify via ix sysvar
//   Z5 Double Team   — manifest parser + nullifier PDA
//   Z6 Thunderbolt   — claim_transfer
//   Z7 Drill Peck    — Jupiter v6 CPI in claim_swap
//   Z8 Agility       — ClaimedEvent emit
//   Z9 Roost         — devnet deploy
//   Z10 Sky Attack   — mainnet-beta deploy

#![no_std]
#![allow(dead_code)]

use quasar_lang::prelude::*;

mod ed25519;
mod instructions;
mod manifest;
mod state;
pub use ed25519::*;
pub use instructions::*;
pub use manifest::*;
pub use state::*;

// Program ID from keys/prism_vault-keypair.json. Replaceable pre-Z10.
declare_id!("wx2Q9nM8n1vamXpYeP7mwrEdzwzwNadZdKCHVTFPkjp");

#[program]
mod prism_vault {
    use super::*;

    /// One-shot config init. Payer becomes admin.
    #[instruction(discriminator = 0)]
    pub fn init_config(
        ctx: Ctx<InitConfig>,
        admin: Address,
        fee_bps: u16,
        fee_vault: Address,
    ) -> Result<(), ProgramError> {
        ctx.accounts.init(admin, fee_bps, fee_vault, &ctx.bumps)
    }

    /// Admin-only fee update.
    #[instruction(discriminator = 3)]
    pub fn set_config(ctx: Ctx<SetConfig>, fee_bps: u16) -> Result<(), ProgramError> {
        ctx.accounts.set(fee_bps)
    }

    /// Consume a Prism manifest (Z6 Thunderbolt).
    ///
    /// Validates the ed25519 precompile ix data binds the IKA pubkey to
    /// the manifest bytes, parses the manifest, asserts the caller's
    /// `prism_id` matches what's inside, and inits the Nullifier PDA.
    /// Init-or-fail on the Nullifier enforces single-claim semantics.
    #[instruction(discriminator = 1)]
    pub fn claim_transfer(
        ctx: Ctx<ClaimTransfer>,
        prism_id: u128,
        ika_sig: [u8; 64],
        ika_pubkey: [u8; 32],
        manifest_json: Vec<u8, 2048>,
        ed25519_ix_data: Vec<u8, 1024>,
    ) -> Result<(), ProgramError> {
        ctx.accounts.claim(
            prism_id,
            manifest_json.as_ref(),
            &ika_sig,
            &ika_pubkey,
            ed25519_ix_data.as_ref(),
            &ctx.bumps,
        )
    }

    // discriminator = 2 reserved for claim_swap (Z7 Drill Peck)
}
