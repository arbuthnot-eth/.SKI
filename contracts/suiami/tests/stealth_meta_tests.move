// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

// Weavile Razor Claw (#198) — StealthMeta entry-fn tests.
//
// Exercises set_stealth_meta / clear_stealth_meta + the view-helper
// abort paths. Mirrors `guest_stealth_tests.move` in style.
// Run: `sui move test` from contracts/suiami/.

#[test_only]
module suiami::stealth_meta_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use suiami::roster::{Self, Roster};

// Error codes (mirror roster.move)
const ENoChains: u64 = 1;
const EChainNotInRecord: u64 = 8;
const ENoRecord: u64 = 9;

const OWNER: address = @0xB0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0;
const STRANGER: address = @0x5757575757575757575757575757575757575757575757575757575757575757;

const T0: u64 = 1_700_000_000_000;

// Dummy ID bytes — 32 bytes of repeated pattern. ID is `object::id_from_address`-ish
// so we construct via the address path.
const DWALLET_ADDR_A: address = @0xAA11AA11AA11AA11AA11AA11AA11AA11AA11AA11AA11AA11AA11AA11AA11AA11;
const DWALLET_ADDR_B: address = @0xBB22BB22BB22BB22BB22BB22BB22BB22BB22BB22BB22BB22BB22BB22BB22BB22;

// Placeholder secp256k1 compressed pubkey (33 bytes, 0x02 prefix + 32 bytes).
const ETH_VIEW_PUB: vector<u8> = x"02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ETH_VIEW_PUB_2: vector<u8> = x"02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// Placeholder ed25519 pubkey (32 bytes).
const SUI_VIEW_PUB: vector<u8> = x"ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccdd";
const SOL_VIEW_PUB: vector<u8> = x"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeff";

fun owner_name_hash(): vector<u8> {
    let mut h = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { h.push_back(0xBBu8); i = i + 1; };
    h
}

/// Init roster + register an OWNER identity so `set_stealth_meta`
/// finds a record at OWNER's address.
fun setup_owner(scenario: &mut ts::Scenario, clk: &clock::Clock) {
    roster::init_for_testing(ts::ctx(scenario));
    ts::next_tx(scenario, OWNER);

    let mut r = ts::take_shared<Roster>(scenario);
    let keys = vector[string::utf8(b"eth")];
    let values = vector[string::utf8(b"0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")];
    roster::set_identity(
        &mut r,
        string::utf8(b"alice"),
        owner_name_hash(),
        keys,
        values,
        vector::empty<address>(),
        string::utf8(b""),
        vector::empty<u8>(),
        clk,
        ts::ctx(scenario),
    );
    ts::return_shared(r);
    ts::next_tx(scenario, OWNER);
}

fun fresh_clock(scenario: &mut ts::Scenario): clock::Clock {
    let mut clk = clock::create_for_testing(ts::ctx(scenario));
    clock::set_for_testing(&mut clk, T0);
    clk
}

fun dwallet_id_a(): sui::object::ID { sui::object::id_from_address(DWALLET_ADDR_A) }
fun dwallet_id_b(): sui::object::ID { sui::object::id_from_address(DWALLET_ADDR_B) }

// ─── 1. set_meta happy path ─────────────────────────────────────────

#[test]
fun set_meta_happy_path() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_a(),
        vector[string::utf8(b"eth"), string::utf8(b"sui"), string::utf8(b"sol")],
        vector[ETH_VIEW_PUB, SUI_VIEW_PUB, SOL_VIEW_PUB],
        &clk,
        ts::ctx(&mut scenario),
    );

    assert!(roster::has_stealth_meta(&r, OWNER), 0);
    assert!(roster::stealth_meta_dwallet_id(&r, OWNER) == dwallet_id_a(), 1);
    assert!(roster::stealth_meta_updated_ms(&r, OWNER) == T0, 2);

    let eth_key = string::utf8(b"eth");
    let sui_key = string::utf8(b"sui");
    let sol_key = string::utf8(b"sol");
    assert!(roster::stealth_meta_has_chain(&r, OWNER, &eth_key), 3);
    assert!(roster::stealth_meta_has_chain(&r, OWNER, &sui_key), 4);
    assert!(roster::stealth_meta_has_chain(&r, OWNER, &sol_key), 5);

    let eth_pub = roster::stealth_meta_view_pubkey(&r, OWNER, &eth_key);
    assert!(eth_pub == ETH_VIEW_PUB, 6);
    let sui_pub = roster::stealth_meta_view_pubkey(&r, OWNER, &sui_key);
    assert!(sui_pub == SUI_VIEW_PUB, 7);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 2. set_meta overwrites existing ────────────────────────────────

#[test]
fun set_meta_overwrites_existing() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    // First write: eth + sui under dwallet A.
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_a(),
        vector[string::utf8(b"eth"), string::utf8(b"sui")],
        vector[ETH_VIEW_PUB, SUI_VIEW_PUB],
        &clk,
        ts::ctx(&mut scenario),
    );

    // Rotate: eth only (new pubkey), dwallet B, later timestamp.
    clock::set_for_testing(&mut clk, T0 + 60_000);
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_b(),
        vector[string::utf8(b"eth")],
        vector[ETH_VIEW_PUB_2],
        &clk,
        ts::ctx(&mut scenario),
    );

    assert!(roster::stealth_meta_dwallet_id(&r, OWNER) == dwallet_id_b(), 0);
    assert!(roster::stealth_meta_updated_ms(&r, OWNER) == T0 + 60_000, 1);

    let eth_key = string::utf8(b"eth");
    let sui_key = string::utf8(b"sui");
    // eth pub rotated
    let eth_pub = roster::stealth_meta_view_pubkey(&r, OWNER, &eth_key);
    assert!(eth_pub == ETH_VIEW_PUB_2, 2);
    // sui dropped — overwrite is wholesale, not merge
    assert!(!roster::stealth_meta_has_chain(&r, OWNER, &sui_key), 3);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 3. set_meta emits event (smoke — no abort == pass) ────────────

#[test]
fun set_meta_emits_event() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_a(),
        vector[string::utf8(b"eth")],
        vector[ETH_VIEW_PUB],
        &clk,
        ts::ctx(&mut scenario),
    );
    // If the set succeeded the event was emitted in the same call — Sui
    // test_scenario doesn't expose event collection, but a successful
    // non-aborting call combined with has_stealth_meta confirms the
    // path was hit.
    assert!(roster::has_stealth_meta(&r, OWNER), 0);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 4. set_meta parallel-length mismatch → ENoChains ──────────────

#[test]
#[expected_failure(abort_code = ENoChains, location = suiami::roster)]
fun set_meta_mismatched_lengths_abort() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_a(),
        vector[string::utf8(b"eth"), string::utf8(b"sui")],
        vector[ETH_VIEW_PUB], // only one value, two keys
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 5. set_meta by non-record-holder → ENoRecord ──────────────────

#[test]
#[expected_failure(abort_code = ENoRecord, location = suiami::roster)]
fun set_meta_non_owner_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    // STRANGER has no IdentityRecord → set_stealth_meta must abort.
    ts::next_tx(&mut scenario, STRANGER);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_a(),
        vector[string::utf8(b"eth")],
        vector[ETH_VIEW_PUB],
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 6. clear_meta happy path ──────────────────────────────────────

#[test]
fun clear_meta_happy_path() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_a(),
        vector[string::utf8(b"eth")],
        vector[ETH_VIEW_PUB],
        &clk,
        ts::ctx(&mut scenario),
    );
    assert!(roster::has_stealth_meta(&r, OWNER), 0);

    roster::clear_stealth_meta(&mut r, ts::ctx(&mut scenario));
    assert!(!roster::has_stealth_meta(&r, OWNER), 1);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 7. clear_meta idempotent on no-existing ───────────────────────

#[test]
fun clear_meta_idempotent() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    // No set first → clear should be a no-op, not abort.
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::clear_stealth_meta(&mut r, ts::ctx(&mut scenario));
    assert!(!roster::has_stealth_meta(&r, OWNER), 0);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 8. clear_meta scoped to sender ────────────────────────────────
//
// STRANGER calling clear_stealth_meta must NOT drop OWNER's meta.
// (No explicit auth check needed — the key is per-sender, so stranger
// clearing only affects stranger's own (nonexistent) slot.)

#[test]
fun clear_meta_scoped_to_sender() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_a(),
        vector[string::utf8(b"eth")],
        vector[ETH_VIEW_PUB],
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    // Stranger clears — does nothing to OWNER's entry.
    ts::next_tx(&mut scenario, STRANGER);
    let mut r2 = ts::take_shared<Roster>(&mut scenario);
    roster::clear_stealth_meta(&mut r2, ts::ctx(&mut scenario));
    assert!(roster::has_stealth_meta(&r2, OWNER), 0);

    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 9. view_pubkey on missing chain → EChainNotInRecord ──────────

#[test]
#[expected_failure(abort_code = EChainNotInRecord, location = suiami::roster)]
fun view_pubkey_missing_chain_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::set_stealth_meta(
        &mut r,
        dwallet_id_a(),
        vector[string::utf8(b"eth")],
        vector[ETH_VIEW_PUB],
        &clk,
        ts::ctx(&mut scenario),
    );
    // Set only eth; asking for sui must abort.
    let sui_key = string::utf8(b"sui");
    let _ = roster::stealth_meta_view_pubkey(&r, OWNER, &sui_key);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 10. view_pubkey on address with no meta → ENoRecord ──────────

#[test]
#[expected_failure(abort_code = ENoRecord, location = suiami::roster)]
fun view_pubkey_no_meta_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    // OWNER has a record but never called set_stealth_meta — looking
    // up a view pubkey must abort ENoRecord (not EChainNotInRecord).
    let r = ts::take_shared<Roster>(&mut scenario);
    let eth_key = string::utf8(b"eth");
    let _ = roster::stealth_meta_view_pubkey(&r, OWNER, &eth_key);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 11. has_chain returns false when no meta (no abort) ──────────

#[test]
fun has_chain_false_when_no_meta() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let r = ts::take_shared<Roster>(&mut scenario);
    let eth_key = string::utf8(b"eth");
    assert!(!roster::stealth_meta_has_chain(&r, OWNER, &eth_key), 0);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}
