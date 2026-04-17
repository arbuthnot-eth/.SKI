// claim_transfer — Z6 Thunderbolt.
//
// Consumes a Prism manifest: verifies the IKA ed25519 signature (by
// validating the ix data blob the client passes through), parses the
// canonical manifest, asserts the client-supplied prism_id matches
// what's inside the manifest, and inits a Nullifier PDA keyed on that
// prism_id. Single-claim semantics: the Nullifier init fails if one
// already exists.
//
// This move lands the nullifier-consumption primitive. Jupiter v6 CPI
// for the actual swap leg is Z7 (Drill Peck). A plain SPL transfer
// leg is Z8-ish; for now the handler just records the claim.
//
// Accounts:
//   payer      — Signer, pays rent for the Nullifier PDA
//   nullifier  — init, seeds = [b"nullifier", prism_id.to_le_bytes()]
//   system_program
//
// Args:
//   prism_id         — u128, lifted from manifest, used as PDA seed
//   manifest_json    — Vec<u8, 2048>, canonical JSON bytes the IKA
//                      signature was computed over
//   ika_sig          — [u8; 64], the IKA-derived ed25519 signature
//   ika_pubkey       — [u8; 32], the IKA dWallet's solana ed25519 pubkey
//   ed25519_ix_data  — Vec<u8, 1024>, the ix data of the ed25519
//                      precompile invocation the client placed earlier
//                      in the same tx (we validate it here)
//
// A future move (Z4.5-ish) will pull `ed25519_ix_data` out of args and
// instead read it from the Instructions sysvar directly, removing the
// trust placed on the client to self-report the precompile's ix data.

use crate::{
    ed25519::validate_ed25519_ix_data,
    manifest::parse_manifest,
    state::{Nullifier, NullifierInner},
};
use quasar_lang::{prelude::*, sysvars::Sysvar as _};

/// Custom errors raised by claim_transfer.
#[derive(Copy, Clone, Debug)]
pub enum ClaimTransferError {
    /// Arg `prism_id` doesn't equal the prismId encoded in the manifest.
    PrismIdArgMismatch,
}

impl From<ClaimTransferError> for ProgramError {
    fn from(e: ClaimTransferError) -> Self {
        ProgramError::Custom(match e {
            ClaimTransferError::PrismIdArgMismatch => 3000,
        })
    }
}

#[derive(Accounts)]
#[instruction(prism_id: u128)]
pub struct ClaimTransfer {
    #[account(mut)]
    pub payer: Signer,
    #[account(
        init,
        payer = payer,
        seeds = Nullifier::seeds(prism_id),
        bump,
    )]
    pub nullifier: Account<Nullifier>,
    pub system_program: Program<System>,
}

impl ClaimTransfer {
    #[inline(always)]
    pub fn claim(
        &mut self,
        prism_id: u128,
        manifest_json: &[u8],
        ika_sig: &[u8; 64],
        ika_pubkey: &[u8; 32],
        ed25519_ix_data: &[u8],
        bumps: &ClaimTransferBumps,
    ) -> Result<(), ProgramError> {
        // Verify the ed25519 precompile ix data binds (pubkey, msg, sig).
        validate_ed25519_ix_data(ed25519_ix_data, ika_pubkey, manifest_json, ika_sig)?;

        // Parse the canonical manifest — validates schema + targetChain
        // and extracts prism_id.
        let parsed = parse_manifest(manifest_json)?;

        // Arg must match manifest, otherwise a caller could init a
        // nullifier for one Prism while claiming a different one.
        if parsed.prism_id != prism_id {
            return Err(ClaimTransferError::PrismIdArgMismatch.into());
        }

        let clock = Clock::get()?;

        self.nullifier.set_inner(NullifierInner {
            prism_id,
            claimed_at: clock.unix_timestamp.into(),
            bump: bumps.nullifier,
        });

        Ok(())
    }
}
