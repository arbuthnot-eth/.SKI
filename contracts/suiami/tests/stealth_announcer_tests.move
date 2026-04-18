// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

// Weavile Quick Attack (#198) — stealth_announcer entry-fn tests.
//
// Exercises `announce` happy paths for every scheme id plus each abort
// branch. Mirrors stealth_meta_tests.move / guest_stealth_tests.move in
// style. Run: `sui move test` from contracts/suiami/.

#[test_only]
module suiami::stealth_announcer_tests;

use sui::clock;
use sui::test_scenario as ts;
use suiami::stealth_announcer;

// Error codes (mirror stealth_announcer.move).
const EBadEphemeralPubkey: u64 = 0;
const EInvalidSchemeId: u64 = 1;
const EMetadataTooLarge: u64 = 2;

const SENDER: address = @0xA11CEA11CEA11CEA11CEA11CEA11CEA11CEA11CEA11CEA11CEA11CEA11CEA11C;
const STEALTH: address = @0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF;

const T0: u64 = 1_700_000_000_000;

// Placeholder compressed secp256k1 pubkey (33 bytes, 0x02 prefix).
const SECP_PUB_33: vector<u8> = x"02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// Placeholder ed25519 pubkey (32 bytes).
const ED25519_PUB_32: vector<u8> = x"ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccdd";
// Wrong-length pubkey (31 bytes) — rejected regardless of scheme.
const PUB_31: vector<u8> = x"ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccdd";

fun fresh_clock(scenario: &mut ts::Scenario): clock::Clock {
    let mut clk = clock::create_for_testing(ts::ctx(scenario));
    clock::set_for_testing(&mut clk, T0);
    clk
}

/// Build a metadata vector of length `n`, bytes = 0xAB.
fun make_metadata(n: u64): vector<u8> {
    let mut out = vector::empty<u8>();
    let mut i = 0u64;
    while (i < n) { out.push_back(0xABu8); i = i + 1; };
    out
}

// ─── 1. happy path — scheme 0 (secp256k1) ───────────────────────────

#[test]
fun announce_happy_path_secp256k1_scheme_0() {
    let mut scenario = ts::begin(SENDER);
    let clk = fresh_clock(&mut scenario);

    stealth_announcer::announce(
        SECP_PUB_33,
        STEALTH,
        7u8,
        make_metadata(64),
        stealth_announcer::scheme_secp256k1(),
        &clk,
        ts::ctx(&mut scenario),
    );

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 2. happy path — scheme 1 (ed25519 sui-native) ──────────────────

#[test]
fun announce_happy_path_ed25519_scheme_1() {
    let mut scenario = ts::begin(SENDER);
    let clk = fresh_clock(&mut scenario);

    stealth_announcer::announce(
        ED25519_PUB_32,
        STEALTH,
        0u8, // view_tag of 0 is legal
        vector::empty<u8>(), // empty metadata is legal
        stealth_announcer::scheme_sui_ed25519(),
        &clk,
        ts::ctx(&mut scenario),
    );

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 3. happy path — scheme 2 (ed25519 sol-native) ──────────────────

#[test]
fun announce_happy_path_ed25519_scheme_2_sol() {
    let mut scenario = ts::begin(SENDER);
    let clk = fresh_clock(&mut scenario);

    stealth_announcer::announce(
        ED25519_PUB_32,
        STEALTH,
        255u8, // max view_tag
        make_metadata(stealth_announcer::max_metadata_len()), // boundary
        stealth_announcer::scheme_sol_ed25519(),
        &clk,
        ts::ctx(&mut scenario),
    );

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 4. rejects bad ephemeral pubkey length ─────────────────────────
//
// 31 bytes under scheme 1 (ed25519 expects 32) aborts EBadEphemeralPubkey.

#[test]
#[expected_failure(abort_code = EBadEphemeralPubkey, location = suiami::stealth_announcer)]
fun rejects_bad_ephemeral_pubkey_length() {
    let mut scenario = ts::begin(SENDER);
    let clk = fresh_clock(&mut scenario);

    stealth_announcer::announce(
        PUB_31,
        STEALTH,
        0u8,
        vector::empty<u8>(),
        stealth_announcer::scheme_sui_ed25519(),
        &clk,
        ts::ctx(&mut scenario),
    );

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 4b. rejects 32-byte pubkey under secp256k1 scheme ──────────────
//
// Cross-scheme length mismatch — 32 bytes is legal for ed25519 but the
// caller declared scheme 0 (secp256k1, which wants 33). Must abort.

#[test]
#[expected_failure(abort_code = EBadEphemeralPubkey, location = suiami::stealth_announcer)]
fun rejects_32_byte_pubkey_under_secp256k1() {
    let mut scenario = ts::begin(SENDER);
    let clk = fresh_clock(&mut scenario);

    stealth_announcer::announce(
        ED25519_PUB_32,
        STEALTH,
        0u8,
        vector::empty<u8>(),
        stealth_announcer::scheme_secp256k1(),
        &clk,
        ts::ctx(&mut scenario),
    );

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 5. rejects invalid scheme id ───────────────────────────────────

#[test]
#[expected_failure(abort_code = EInvalidSchemeId, location = suiami::stealth_announcer)]
fun rejects_invalid_scheme_id() {
    let mut scenario = ts::begin(SENDER);
    let clk = fresh_clock(&mut scenario);

    stealth_announcer::announce(
        ED25519_PUB_32,
        STEALTH,
        0u8,
        vector::empty<u8>(),
        3u8, // 3 is not in {0,1,2}
        &clk,
        ts::ctx(&mut scenario),
    );

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 6. rejects oversized metadata ──────────────────────────────────

#[test]
#[expected_failure(abort_code = EMetadataTooLarge, location = suiami::stealth_announcer)]
fun rejects_oversized_metadata() {
    let mut scenario = ts::begin(SENDER);
    let clk = fresh_clock(&mut scenario);

    stealth_announcer::announce(
        ED25519_PUB_32,
        STEALTH,
        0u8,
        make_metadata(stealth_announcer::max_metadata_len() + 1),
        stealth_announcer::scheme_sui_ed25519(),
        &clk,
        ts::ctx(&mut scenario),
    );

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}
