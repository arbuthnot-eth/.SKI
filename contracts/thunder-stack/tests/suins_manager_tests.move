#[test_only]
module sui_stack_messaging::suins_manager_tests;

use sui_stack_messaging::group_manager::GroupManager;
use sui_stack_messaging::messaging::{Self, Messaging, MessagingNamespace, MessagingReader};
use sui_stack_messaging::version::{Self, Version};
use sui_groups::permissioned_group::PermissionedGroup;
use sui::test_scenario as ts;
use sui::vec_set;
use suins::suins::{Self, SuiNS};

// === Test Addresses ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;

// === Test Data ===

const TEST_ENCRYPTED_DEK: vector<u8> = b"test_encrypted_dek";
const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440100";
const TEST_UUID_2: vector<u8> = b"550e8400-e29b-41d4-a716-446655440101";
const TEST_DOMAIN: vector<u8> = b"mygroup.sui";
const TEST_GROUP_NAME: vector<u8> = b"Test Group";

// === Helper Functions ===

/// Creates a minimal SuiNS object for testing.
/// The SuiNS doesn't need full setup (registry, ControllerV2 auth) because
/// the permission check aborts before any SuiNS interaction.
fun setup_suins(ctx: &mut TxContext): SuiNS {
    let (suins, admin_cap) = suins::new_for_testing(ctx);
    transfer::public_transfer(admin_cap, ctx.sender());
    suins
}

// === set_suins_reverse_lookup tests ===

#[test, expected_failure(abort_code = sui_stack_messaging::messaging::ENotPermitted)]
fun set_suins_reverse_lookup_without_permission_fails() {
    let mut ts = ts::begin(ALICE);

    // Initialize messaging namespace
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create a group — Alice is creator with all permissions
    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let (mut group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        TEST_GROUP_NAME.to_string(),
        TEST_UUID.to_string(),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    // Grant Bob only MessagingReader (no SuiNsAdmin)
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(namespace);

    // Set up SuiNS (minimal — permission check aborts before SuiNS is touched)
    ts.next_tx(BOB);
    let suins = setup_suins(ts.ctx());
    suins.share_for_testing();

    // Bob tries to set reverse lookup — should fail with ENotPermitted
    ts.next_tx(BOB);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let group_manager = ts.take_shared<GroupManager>();
    let mut suins = ts.take_shared<SuiNS>();

    messaging::set_suins_reverse_lookup(
        &group_manager,
        &mut group,
        &mut suins,
        TEST_DOMAIN.to_string(),
        ts.ctx(),
    );

    abort
}

// === unset_suins_reverse_lookup tests ===

#[test, expected_failure(abort_code = sui_stack_messaging::messaging::ENotPermitted)]
fun unset_suins_reverse_lookup_without_permission_fails() {
    let mut ts = ts::begin(ALICE);

    // Initialize messaging namespace
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create a group
    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let (mut group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        TEST_GROUP_NAME.to_string(),
        TEST_UUID_2.to_string(),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    // Grant Bob only MessagingReader
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(namespace);

    // Set up SuiNS (minimal)
    ts.next_tx(BOB);
    let suins = setup_suins(ts.ctx());
    suins.share_for_testing();

    // Bob tries to unset reverse lookup — should fail with ENotPermitted
    ts.next_tx(BOB);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let group_manager = ts.take_shared<GroupManager>();
    let mut suins = ts.take_shared<SuiNS>();

    messaging::unset_suins_reverse_lookup(
        &group_manager,
        &mut group,
        &mut suins,
        ts.ctx(),
    );

    abort
}
