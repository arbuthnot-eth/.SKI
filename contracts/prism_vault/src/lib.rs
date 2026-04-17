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
//   Z1 Charge       — this scaffold (you are here)
//   Z2 Thunder Shock — VaultConfig + Nullifier state
//   Z3 Light Screen  — init_config
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

// Placeholder program ID — replaced in Z2 (Thunder Shock) with the
// address of a freshly-generated keypair at keys/prism_vault-keypair.json.
declare_id!("11111111111111111111111111111111");

#[program]
mod prism_vault {
    use super::*;

    /// Scaffold-only placeholder instruction. Replaced by real handlers
    /// in Z3 (init_config), Z6 (claim_transfer), Z7 (claim_swap).
    #[instruction(discriminator = 0)]
    pub fn ping(_ctx: Ctx<Ping>) -> Result<(), ProgramError> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
