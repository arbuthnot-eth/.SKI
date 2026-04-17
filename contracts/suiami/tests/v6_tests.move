// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

// v6 tests — PublicChains whitelist + Guest Protocol.
//
// Run: `sui move test`

#[test_only]
module suiami::v6_tests;

use std::string;
use std::option;
use sui::clock;
use sui::test_scenario as ts;
use sui::vec_map;
use suiami::roster::{Self, Roster};

const OWNER: address = @0x0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B;
const STRANGER: address = @0x5757575757575757575757575757575757575757575757575757575757575757;
const DELEGATE: address = @0xD1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1;

fun owner_name_hash(): vector<u8> {
    let mut h = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { h.push_back(0xBBu8); i = i + 1; };
    h
}

// ─── Setup: register an identity for OWNER with eth/btc/sol chains ─

fun setup_owner(scenario: &mut ts::Scenario, clk: &clock::Clock) {
    roster::init_for_testing(ts::ctx(scenario));
    ts::next_tx(scenario, OWNER);

    let mut r = ts::take_shared<Roster>(scenario);
    let keys = vector[
        string::utf8(b"eth"),
        string::utf8(b"btc"),
        string::utf8(b"sol"),
    ];
    let values = vector[
        string::utf8(b"0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"),
        string::utf8(b"bc1qtestbtcaddressxxxxxxxxxxxxxxxxxxxxxxxx"),
        string::utf8(b"So1111111111111111111111111111111111111111"),
    ];
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

// ─── PublicChains tests ─────────────────────────────────────────────

#[test]
fun public_chains_default_absent() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let r = ts::take_shared<Roster>(&scenario);
    assert!(!roster::has_public_chains(&r, OWNER), 0);
    // Probe returns false for absent whitelist.
    let eth = string::utf8(b"eth");
    assert!(!roster::public_chains_contains(&r, OWNER, &eth), 0);
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
fun public_chains_set_and_probe() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    let keys = vector[string::utf8(b"eth"), string::utf8(b"sol")];
    roster::set_public_chains(&mut r, keys, &clk, ts::ctx(&mut scenario));

    assert!(roster::has_public_chains(&r, OWNER), 0);
    let eth = string::utf8(b"eth");
    let sol = string::utf8(b"sol");
    let btc = string::utf8(b"btc");
    assert!(roster::public_chains_contains(&r, OWNER, &eth), 0);
    assert!(roster::public_chains_contains(&r, OWNER, &sol), 0);
    // btc is NOT whitelisted even though it's in record.chains.
    assert!(!roster::public_chains_contains(&r, OWNER, &btc), 0);

    let visible = roster::public_chains_visible(&r, OWNER);
    assert!(vec_map::size(visible) == 2, 0);
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
fun public_chains_clear_reverts_to_default() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    let keys = vector[string::utf8(b"eth")];
    roster::set_public_chains(&mut r, keys, &clk, ts::ctx(&mut scenario));
    assert!(roster::has_public_chains(&r, OWNER), 0);

    roster::clear_public_chains(&mut r, ts::ctx(&mut scenario));
    assert!(!roster::has_public_chains(&r, OWNER), 0);
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
fun public_chains_empty_whitelist_allowed() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::set_public_chains(&mut r, vector::empty<string::String>(), &clk, ts::ctx(&mut scenario));
    // Whitelist exists but is empty → nothing is ENS-public.
    assert!(roster::has_public_chains(&r, OWNER), 0);
    let eth = string::utf8(b"eth");
    assert!(!roster::public_chains_contains(&r, OWNER, &eth), 0);
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = roster::EChainNotInRecord, location = suiami::roster)]
fun public_chains_rejects_unknown_key() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    let keys = vector[string::utf8(b"doge")]; // not in record.chains
    roster::set_public_chains(&mut r, keys, &clk, ts::ctx(&mut scenario));
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = roster::ENoRecord, location = suiami::roster)]
fun public_chains_rejects_non_record_holder() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    ts::next_tx(&mut scenario, STRANGER);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    let keys = vector[string::utf8(b"eth")];
    roster::set_public_chains(&mut r, keys, &clk, ts::ctx(&mut scenario));
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── Guest Protocol tests ───────────────────────────────────────────

const GUEST_LABEL: vector<u8> = b"pay";
const GUEST_TARGET: vector<u8> = b"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ONE_DAY_MS: u64 = 86_400_000;
const SEVEN_DAYS_MS: u64 = 86_400_000 * 7;

#[test]
fun guest_bind_then_lookup_live() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clk, 1_000_000);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        SEVEN_DAYS_MS,
        option::none<address>(),
        &clk,
        ts::ctx(&mut scenario),
    );

    assert!(roster::has_guest(&r, owner_name_hash(), GUEST_LABEL), 0);
    let t = roster::lookup_guest_target(&r, owner_name_hash(), GUEST_LABEL, &clk);
    assert!(option::is_some(&t), 0);
    let tv = option::destroy_some(t);
    assert!(tv == string::utf8(GUEST_TARGET), 0);
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
fun guest_lookup_returns_none_after_expiry() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
    let t0: u64 = 1_000_000;
    clock::set_for_testing(&mut clk, t0);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        ONE_DAY_MS,
        option::none<address>(),
        &clk,
        ts::ctx(&mut scenario),
    );
    // Fast-forward past expiry.
    clock::set_for_testing(&mut clk, t0 + ONE_DAY_MS + 1);
    let t = roster::lookup_guest_target(&r, owner_name_hash(), GUEST_LABEL, &clk);
    assert!(option::is_none(&t), 0);
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
fun guest_revoke_by_parent() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        ONE_DAY_MS,
        option::none<address>(),
        &clk,
        ts::ctx(&mut scenario),
    );
    roster::revoke_guest(&mut r, owner_name_hash(), GUEST_LABEL, ts::ctx(&mut scenario));
    assert!(!roster::has_guest(&r, owner_name_hash(), GUEST_LABEL), 0);
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
fun guest_revoke_by_delegate() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        ONE_DAY_MS,
        option::some(DELEGATE),
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);
    ts::next_tx(&mut scenario, DELEGATE);

    let mut r2 = ts::take_shared<Roster>(&mut scenario);
    roster::revoke_guest(&mut r2, owner_name_hash(), GUEST_LABEL, ts::ctx(&mut scenario));
    assert!(!roster::has_guest(&r2, owner_name_hash(), GUEST_LABEL), 0);
    ts::return_shared(r2);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = roster::ENotParentOrDelegate, location = suiami::roster)]
fun guest_revoke_by_stranger_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        ONE_DAY_MS,
        option::some(DELEGATE),
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);
    ts::next_tx(&mut scenario, STRANGER);

    let mut r2 = ts::take_shared<Roster>(&mut scenario);
    roster::revoke_guest(&mut r2, owner_name_hash(), GUEST_LABEL, ts::ctx(&mut scenario));
    ts::return_shared(r2);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
fun guest_reap_after_expiry() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
    let t0: u64 = 1_000_000;
    clock::set_for_testing(&mut clk, t0);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        ONE_DAY_MS,
        option::none<address>(),
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);
    ts::next_tx(&mut scenario, STRANGER);

    clock::set_for_testing(&mut clk, t0 + ONE_DAY_MS + 1);
    let mut r2 = ts::take_shared<Roster>(&mut scenario);
    // Stranger sweeps the expired guest — permissionless.
    roster::reap_guest(&mut r2, owner_name_hash(), GUEST_LABEL, &clk, ts::ctx(&mut scenario));
    assert!(!roster::has_guest(&r2, owner_name_hash(), GUEST_LABEL), 0);
    ts::return_shared(r2);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = roster::EGuestNotExpired, location = suiami::roster)]
fun guest_reap_live_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        ONE_DAY_MS,
        option::none<address>(),
        &clk,
        ts::ctx(&mut scenario),
    );
    // Still live — reap must abort.
    roster::reap_guest(&mut r, owner_name_hash(), GUEST_LABEL, &clk, ts::ctx(&mut scenario));
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = roster::EGuestBadTtl, location = suiami::roster)]
fun guest_bind_zero_ttl_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        0,
        option::none<address>(),
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = roster::EGuestBadTtl, location = suiami::roster)]
fun guest_bind_excessive_ttl_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    // 181 days > 180-day cap.
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        ONE_DAY_MS * 181,
        option::none<address>(),
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = roster::ENotOwner, location = suiami::roster)]
fun guest_bind_by_stranger_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(ts::ctx(&mut scenario));
    setup_owner(&mut scenario, &clk);

    ts::next_tx(&mut scenario, STRANGER);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest(
        &mut r,
        owner_name_hash(),
        GUEST_LABEL,
        string::utf8(GUEST_TARGET),
        string::utf8(b"eth"),
        ONE_DAY_MS,
        option::none<address>(),
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}
