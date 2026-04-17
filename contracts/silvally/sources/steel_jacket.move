// Steel Jacket — auto-prune-on-expiry composition over SubnamePolicy.
//
// Klinklang Gear Grind (#191): when a delegated subname expires, the
// Crowd DO's alarm sweeps it via `subdomains::prune_expired_subname_by_parent`
// (Mysten #356, merged 2026-04-17) and calls `record_prune` here, which
// reclaims the policy's quota so the slot reopens for the next member.
//
// First jacket shipped atop the Silvally base module — proves the
// composition pattern is live, not hypothetical.

module ski::steel_jacket;

use sui::clock::Clock;
use sui::event;

use ski::dwallet_subname_policy::{Self as policy, SubnamePolicy, OwnerCap};

// ─── Errors ────────────────────────────────────────────────────────

const E_WRONG_POLICY: u64 = 10;
const E_WRONG_JACKET: u64 = 11;
const E_GRACE_NOT_ELAPSED: u64 = 12;

// ─── State ─────────────────────────────────────────────────────────

public struct SteelJacket has key {
    id: UID,
    policy_id: ID,
    /// Extra ms past `cap_expiration_ms` before a subname can be pruned
    /// (gives members a renewal window).
    grace_period_ms: u64,
    pruned_count: u64,
    last_grind_ms: u64,
}

public struct SteelJacketCap has key, store {
    id: UID,
    jacket_id: ID,
}

// ─── Events ────────────────────────────────────────────────────────

public struct JacketAttached has copy, drop {
    jacket_id: ID,
    policy_id: ID,
    grace_period_ms: u64,
}

public struct PruneRecorded has copy, drop {
    jacket_id: ID,
    policy_id: ID,
    subname: vector<u8>,
    pruned_at_ms: u64,
    pruned_total: u64,
}

// ─── Attach ────────────────────────────────────────────────────────

/// Attach a Steel Jacket to an existing SubnamePolicy. Only the
/// policy's OwnerCap holder can attach; returns a `SteelJacketCap`
/// the caller keeps for later admin ops.
public fun attach(
    pol: &SubnamePolicy,
    owner_cap: &OwnerCap,
    grace_period_ms: u64,
    ctx: &mut TxContext,
): SteelJacketCap {
    // Verify owner_cap belongs to this policy.
    assert!(policy::owner_cap_id(pol) == object::id(owner_cap), E_WRONG_POLICY);

    let jacket_uid = object::new(ctx);
    let jacket_id = jacket_uid.to_inner();
    let policy_id = policy::policy_id(pol);

    let jacket = SteelJacket {
        id: jacket_uid,
        policy_id,
        grace_period_ms,
        pruned_count: 0,
        last_grind_ms: 0,
    };

    let cap = SteelJacketCap {
        id: object::new(ctx),
        jacket_id,
    };

    event::emit(JacketAttached { jacket_id, policy_id, grace_period_ms });

    transfer::share_object(jacket);
    cap
}

// ─── Record prune ───────────────────────────────────────────────────

/// Record that the off-chain orchestrator (Crowd DO) has pruned a
/// subname via `subdomains::prune_expired_subname_by_parent`. Reclaims
/// one quota slot on the parent policy. Requires the `SteelJacketCap`
/// so only the policy owner's delegate can reclaim.
public fun record_prune(
    pol: &mut SubnamePolicy,
    jacket: &mut SteelJacket,
    cap: &SteelJacketCap,
    subname: vector<u8>,
    clock: &Clock,
) {
    assert!(cap.jacket_id == jacket.id.to_inner(), E_WRONG_JACKET);
    assert!(jacket.policy_id == policy::policy_id(pol), E_WRONG_POLICY);

    // Grace window enforcement — orchestrator can't record a prune
    // before grace_period_ms has elapsed past policy expiration.
    let now = clock.timestamp_ms();
    assert!(
        now >= policy::expiration_ms(pol) + jacket.grace_period_ms,
        E_GRACE_NOT_ELAPSED,
    );

    policy::reclaim_quota(pol, 1);
    jacket.pruned_count = jacket.pruned_count + 1;
    jacket.last_grind_ms = now;

    event::emit(PruneRecorded {
        jacket_id: jacket.id.to_inner(),
        policy_id: jacket.policy_id,
        subname,
        pruned_at_ms: now,
        pruned_total: jacket.pruned_count,
    });
}

// ─── Views ──────────────────────────────────────────────────────────

public fun grace_period_ms(j: &SteelJacket): u64 { j.grace_period_ms }
public fun pruned_count(j: &SteelJacket): u64 { j.pruned_count }
public fun last_grind_ms(j: &SteelJacket): u64 { j.last_grind_ms }
public fun jacket_policy_id(j: &SteelJacket): ID { j.policy_id }
public fun cap_jacket_id(c: &SteelJacketCap): ID { c.jacket_id }

// ─── Test-only ──────────────────────────────────────────────────────

#[test_only] public fun err_wrong_policy(): u64 { E_WRONG_POLICY }
#[test_only] public fun err_wrong_jacket(): u64 { E_WRONG_JACKET }
#[test_only] public fun err_grace_not_elapsed(): u64 { E_GRACE_NOT_ELAPSED }
