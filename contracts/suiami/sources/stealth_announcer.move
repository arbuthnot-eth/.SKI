// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Weavile Quick Attack (#198) — Sui-native stealth announcement log.
///
/// Counterpart to the EIP-5564 Announcer (Ethereum) at 0x55649e01…5564.
/// For ETH/L2 chains a sender broadcasts a `(schemeId, stealthAddress,
/// ephemeralPubKey, metadata)` tuple via the EIP-5564 event so recipients
/// scanning the chain can find their own stealth payments without
/// revealing which ones are theirs on-chain. We replicate that surface
/// on Sui so a single Weavile scanner DO can treat Sui announcements
/// the same as ETH ones.
///
/// Scope: pure event emitter. No authorization, no state. Anyone may
/// announce for any address — EIP-5564 does not require sender-auth
/// either, because the `view_tag` + `ephemeral_pubkey` prevent the
/// scanner from even processing a false announcement that wasn't
/// ECDH'd against its view key.
///
/// Scheme ids mirror EIP-5564's registry where they overlap:
///   0 = secp256k1 (eth-compat, 33-byte compressed ephemeral pubkey)
///   1 = ed25519 sui-native (32-byte ephemeral pubkey)
///   2 = ed25519 sol-native (32-byte ephemeral pubkey)
///
/// Scanner subscribes to `StealthAnnouncement` via the Sui events API
/// (transport-agnostic — gRPC, GraphQL, or JSON-RPC all expose it) and
/// filters client-side on `view_tag` before attempting ECDH.
module suiami::stealth_announcer;

use sui::event;
use sui::clock::Clock;

// ─── Errors ──────────────────────────────────────────────────────────

const EBadEphemeralPubkey: u64 = 0;
const EInvalidSchemeId: u64 = 1;
const EMetadataTooLarge: u64 = 2;

// ─── Constants ──────────────────────────────────────────────────────

/// 1 KiB metadata cap. Keeps announcement bloat bounded on Sui storage
/// (scanners paginate events; giant payloads would stall scan loops).
/// Fits encrypted memo blobs, Walrus blob-id pointers, and tx-hint
/// structs comfortably. Attachments go on Walrus — reference the blob
/// id here, don't inline the bytes.
const MAX_METADATA_LEN: u64 = 1024;

/// secp256k1 compressed pubkey length (33 bytes: 0x02/0x03 prefix + x-coord).
const SECP256K1_COMPRESSED_LEN: u64 = 33;

/// ed25519 pubkey length (32 bytes).
const ED25519_PUBKEY_LEN: u64 = 32;

const SCHEME_SECP256K1: u8 = 0;
const SCHEME_SUI_ED25519: u8 = 1;
const SCHEME_SOL_ED25519: u8 = 2;

// ─── Events ─────────────────────────────────────────────────────────

/// The single observable of this module. Scanner DO reads these events
/// from the Sui events stream, filters by `view_tag`, then ECDHs
/// `ephemeral_pubkey` against its view privkey to decide whether
/// `stealth_addr` belongs to it.
public struct StealthAnnouncement has copy, drop {
    /// Tx sender — whoever posted the announcement. Usually the sender
    /// of the funds, but not required (relayers / aggregators can post
    /// on behalf of senders).
    announcer: address,
    /// Sender's one-shot ephemeral pubkey. 32 bytes (ed25519) or 33
    /// bytes (secp256k1 compressed) — validated in `announce`.
    ephemeral_pubkey: vector<u8>,
    /// The derived stealth address funds landed at (Sui address for
    /// this module's scope).
    stealth_addr: address,
    /// 1-byte view-tag hint. Scanner checks this first to skip ~255/256
    /// announcements without running ECDH.
    view_tag: u8,
    /// Optional encrypted payload. Memo, Walrus blob id, attachment
    /// reference — format is caller/scheme-defined.
    metadata: vector<u8>,
    /// 0 = secp256k1 eth-compat, 1 = ed25519 sui-native, 2 = ed25519 sol-native.
    scheme_id: u8,
    /// Sui clock timestamp in ms.
    announced_ms: u64,
}

// ─── Entry ──────────────────────────────────────────────────────────

/// Post a stealth-address announcement. Permissionless — anyone can call.
/// Validates pubkey length against the declared scheme, caps metadata
/// size, and requires a valid scheme id. No state is written; the only
/// observable is the emitted `StealthAnnouncement` event.
entry fun announce(
    ephemeral_pubkey: vector<u8>,
    stealth_addr: address,
    view_tag: u8,
    metadata: vector<u8>,
    scheme_id: u8,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(
        scheme_id == SCHEME_SECP256K1
            || scheme_id == SCHEME_SUI_ED25519
            || scheme_id == SCHEME_SOL_ED25519,
        EInvalidSchemeId,
    );

    let pk_len = ephemeral_pubkey.length();
    if (scheme_id == SCHEME_SECP256K1) {
        assert!(pk_len == SECP256K1_COMPRESSED_LEN, EBadEphemeralPubkey);
    } else {
        // Both ed25519 schemes — 32 bytes.
        assert!(pk_len == ED25519_PUBKEY_LEN, EBadEphemeralPubkey);
    };

    assert!(metadata.length() <= MAX_METADATA_LEN, EMetadataTooLarge);

    event::emit(StealthAnnouncement {
        announcer: ctx.sender(),
        ephemeral_pubkey,
        stealth_addr,
        view_tag,
        metadata,
        scheme_id,
        announced_ms: clock.timestamp_ms(),
    });
}

// ─── Test-only helpers ──────────────────────────────────────────────

#[test_only]
public fun max_metadata_len(): u64 { MAX_METADATA_LEN }

#[test_only]
public fun scheme_secp256k1(): u8 { SCHEME_SECP256K1 }

#[test_only]
public fun scheme_sui_ed25519(): u8 { SCHEME_SUI_ED25519 }

#[test_only]
public fun scheme_sol_ed25519(): u8 { SCHEME_SOL_ED25519 }
