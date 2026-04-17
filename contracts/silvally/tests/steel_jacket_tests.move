// Steel Jacket — composition tests proving the jacket pattern ships.

#[test_only]
module ski::steel_jacket_tests;

use sui::clock;
use sui::test_scenario as ts;

use ika_dwallet_2pc_mpc::coordinator::{Self};
use ika_dwallet_2pc_mpc::coordinator_inner::{Self};

use ski::dwallet_subname_policy::{Self as policy, SubnamePolicy, OwnerCap};
use ski::steel_jacket::{Self as steel, SteelJacket, SteelJacketCap};

const OWNER: address = @0xA11CE;
const DELEGATE: address = @0xB0B;

const MAX: u64 = 3;
const EXP_MS: u64 = 1_000_000;
const GRACE_MS: u64 = 100_000;

fun setup_with_jacket(): ts::Scenario {
    let mut sc = ts::begin(OWNER);
    // 1. Init policy.
    {
        let ctx = sc.ctx();
        let cap = coordinator_inner::new_dwallet_cap_for_testing(ctx);
        let owner_cap = policy::init_policy(cap, MAX, EXP_MS, ctx);
        transfer::public_transfer(owner_cap, OWNER);
    };
    // 2. Attach steel jacket.
    sc.next_tx(OWNER);
    {
        let pol = sc.take_shared<SubnamePolicy>();
        let owner_cap = sc.take_from_address<OwnerCap>(OWNER);
        let jacket_cap = steel::attach(&pol, &owner_cap, GRACE_MS, sc.ctx());
        transfer::public_transfer(jacket_cap, OWNER);
        sc.return_to_sender(owner_cap);
        ts::return_shared(pol);
    };
    sc
}

// ─── Happy path ────────────────────────────────────────────────────

#[test]
fun attach_then_record_prune_reclaims_quota() {
    let mut sc = setup_with_jacket();

    // Burn one quota slot via delegate path.
    sc.next_tx(DELEGATE);
    {
        let mut pol = sc.take_shared<SubnamePolicy>();
        let mut coord = coordinator::new_coordinator_for_testing(sc.ctx());
        let clk = clock::create_for_testing(sc.ctx());
        let approval = policy::delegate_approve_spike(&mut pol, &mut coord, b"alice", &clk, sc.ctx());
        assert!(policy::issued_count(&pol) == 1, 0);
        coordinator::destroy_approval_for_testing(approval);
        coordinator::destroy_coordinator_for_testing(coord);
        clock::destroy_for_testing(clk);
        ts::return_shared(pol);
    };

    // After grace window elapses, record_prune reclaims quota.
    sc.next_tx(OWNER);
    {
        let mut pol = sc.take_shared<SubnamePolicy>();
        let mut jacket = sc.take_shared<SteelJacket>();
        let jacket_cap = sc.take_from_address<SteelJacketCap>(OWNER);
        let mut clk = clock::create_for_testing(sc.ctx());
        // Advance past expiration + grace.
        clk.set_for_testing(EXP_MS + GRACE_MS + 1);

        steel::record_prune(&mut pol, &mut jacket, &jacket_cap, b"alice", &clk);

        assert!(policy::issued_count(&pol) == 0, 1); // quota reclaimed
        assert!(steel::pruned_count(&jacket) == 1, 2);

        clock::destroy_for_testing(clk);
        sc.return_to_sender(jacket_cap);
        ts::return_shared(jacket);
        ts::return_shared(pol);
    };

    sc.end();
}

// ─── Grace enforcement ─────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 12, location = ski::steel_jacket)]
fun record_prune_before_grace_aborts() {
    let mut sc = setup_with_jacket();

    sc.next_tx(OWNER);
    let mut pol = sc.take_shared<SubnamePolicy>();
    let mut jacket = sc.take_shared<SteelJacket>();
    let jacket_cap = sc.take_from_address<SteelJacketCap>(OWNER);
    let mut clk = clock::create_for_testing(sc.ctx());
    // Past expiration but within grace window.
    clk.set_for_testing(EXP_MS + GRACE_MS - 1);

    steel::record_prune(&mut pol, &mut jacket, &jacket_cap, b"early", &clk);

    clock::destroy_for_testing(clk);
    sc.return_to_sender(jacket_cap);
    ts::return_shared(jacket);
    ts::return_shared(pol);
    sc.end();
}

// ─── Views work ────────────────────────────────────────────────────

#[test]
fun jacket_views_reflect_attach_config() {
    let mut sc = setup_with_jacket();
    sc.next_tx(OWNER);

    let jacket = sc.take_shared<SteelJacket>();
    assert!(steel::grace_period_ms(&jacket) == GRACE_MS, 0);
    assert!(steel::pruned_count(&jacket) == 0, 1);
    assert!(steel::last_grind_ms(&jacket) == 0, 2);

    ts::return_shared(jacket);
    sc.end();
}
