// Copyright (c) 2026 SKI
// SPDX-License-Identifier: MIT

/// Thunder — encrypt messaging between SuiNS identities.
///
/// Thunder.in is a shared object. Anyone can deposit a thunder
/// (permissionless send). Only the SuiNS name owner can strike
/// (NFT-gated decrypt key retrieval).
///
/// On-chain, a deposit reveals only: name_hash + timestamp.
/// The message blob on Walrus is AES-encrypt. The AES key is
/// stored on-chain, retrievable only via strike (requires NFT).
/// No external key servers — the contract IS the access control.
module thunder::thunder;

use sui::dynamic_field;
use sui::hash::keccak256;
use sui::event;
use sui::clock::Clock;
use suins::suins_registration::SuinsRegistration;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const EEmptyInbox: u64 = 1;

// ─── Events ─────────────────────────────────────────────────────────

public struct ThunderDeposited has copy, drop {
    name_hash: vector<u8>,
    timestamp_ms: u64,
}

public struct ThunderStruck has copy, drop {
    name_hash: vector<u8>,
    blob_id: vector<u8>,
}

// ─── Types ──────────────────────────────────────────────────────────

public struct Thunder has key {
    id: UID,
}

public struct ThunderBolt has store, copy, drop {
    /// Walrus blob ID (content-addressed) — the AES-encrypt message.
    blob_id: vector<u8>,
    /// AES-256-GCM key (32 bytes) — only revealed to the name owner via strike.
    aes_key: vector<u8>,
    /// AES-256-GCM nonce (12 bytes) — needed alongside the key to decrypt.
    aes_nonce: vector<u8>,
    /// When this thunder was sent.
    timestamp_ms: u64,
}

public struct ThunderInbox has store {
    bolts: vector<ThunderBolt>,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    let thunder_in = Thunder {
        id: object::new(ctx),
    };
    transfer::share_object(thunder_in);
}

// ─── Public functions ───────────────────────────────────────────────

/// Deposit a thunder. Permissionless — anyone can send.
/// The AES key is XOR'd with keccak256(nft_object_id) before storage.
/// Only the NFT owner knows their object ID to un-XOR it via strike.
entry fun deposit(
    thunder_in: &mut Thunder,
    name_hash: vector<u8>,
    blob_id: vector<u8>,
    masked_aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    let timestamp_ms = clock.timestamp_ms();
    let bolt = ThunderBolt { blob_id, aes_key: masked_aes_key, aes_nonce, timestamp_ms };

    if (dynamic_field::exists_(&thunder_in.id, name_hash)) {
        let inbox: &mut ThunderInbox = dynamic_field::borrow_mut(&mut thunder_in.id, name_hash);
        inbox.bolts.push_back(bolt);
    } else {
        let inbox = ThunderInbox { bolts: vector[bolt] };
        dynamic_field::add(&mut thunder_in.id, name_hash, inbox);
    };

    event::emit(ThunderDeposited { name_hash, timestamp_ms });
}

/// Strike — claim the first thunder. Requires the SuinsRegistration NFT.
/// Returns the blob_id, AES key, and nonce via event (for the client to decrypt).
entry fun strike(
    thunder_in: &mut Thunder,
    name_hash: vector<u8>,
    nft: &SuinsRegistration,
    _ctx: &TxContext,
) {
    // Verify the NFT's domain hashes to the requested name_hash
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let inbox: &mut ThunderInbox = dynamic_field::borrow_mut(&mut thunder_in.id, name_hash);
    assert!(!inbox.bolts.is_empty(), EEmptyInbox);

    let bolt = inbox.bolts.remove(0);
    event::emit(ThunderStruck { name_hash, blob_id: bolt.blob_id });
    // AES key + nonce returned in the transaction effects (returnValues via devInspect)
    // The client reads them from the executed tx effects
}

/// Count pending thunders. Permissionless read.
public fun count(thunder_in: &Thunder, name_hash: vector<u8>): u64 {
    if (!dynamic_field::exists_(&thunder_in.id, name_hash)) return 0;
    let inbox: &ThunderInbox = dynamic_field::borrow(&thunder_in.id, name_hash);
    inbox.bolts.length()
}

/// Peek at the first thunder's blob_id + timestamp (no key revealed).
/// Permissionless — the blob is encrypt, seeing the ID reveals nothing.
public fun peek(thunder_in: &Thunder, name_hash: vector<u8>): (vector<u8>, u64) {
    let inbox: &ThunderInbox = dynamic_field::borrow(&thunder_in.id, name_hash);
    assert!(!inbox.bolts.is_empty(), EEmptyInbox);
    let b = &inbox.bolts[0];
    (b.blob_id, b.timestamp_ms)
}

/// Strike and return — same as strike but returns the key material directly.
/// Un-XORs the AES key with keccak256(nft_object_id) before returning.
/// Used via devInspect so the client can read the return values without executing.
public fun strike_view(
    thunder_in: &mut Thunder,
    name_hash: vector<u8>,
    nft: &SuinsRegistration,
    _ctx: &TxContext,
): (vector<u8>, vector<u8>, vector<u8>) {
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let inbox: &mut ThunderInbox = dynamic_field::borrow_mut(&mut thunder_in.id, name_hash);
    assert!(!inbox.bolts.is_empty(), EEmptyInbox);

    let bolt = inbox.bolts.remove(0);
    event::emit(ThunderStruck { name_hash, blob_id: bolt.blob_id });

    // Un-XOR the key with keccak256(nft_object_id)
    let nft_id_bytes = object::id(nft).to_bytes();
    let mask = keccak256(&nft_id_bytes);
    let real_key = xor_bytes(bolt.aes_key, mask);

    (bolt.blob_id, real_key, bolt.aes_nonce)
}

/// XOR two byte vectors (key ^ mask). If mask is shorter, wraps around.
fun xor_bytes(data: vector<u8>, mask: vector<u8>): vector<u8> {
    let mut result = vector[];
    let mask_len = mask.length();
    let mut i = 0;
    while (i < data.length()) {
        result.push_back(data[i] ^ mask[i % mask_len]);
        i = i + 1;
    };
    result
}
