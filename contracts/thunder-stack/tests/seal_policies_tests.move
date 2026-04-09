#[test_only]
module sui_stack_messaging::seal_policies_tests;

use sui_stack_messaging::encryption_history::EncryptionHistory;
use sui_stack_messaging::group_manager::GroupManager;
use sui_stack_messaging::messaging::{Self, Messaging, MessagingNamespace, MessagingReader, MessagingSender};
use sui_stack_messaging::seal_policies;
use sui_stack_messaging::version::{Self, Version};
use sui_groups::permissioned_group::PermissionedGroup;
use std::string;
use sui::bcs;
use sui::test_scenario as ts;
use sui::vec_set;

// === Test Addresses ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;

// === Test Data ===

const TEST_ENCRYPTED_DEK: vector<u8> = b"test_encrypted_dek";
const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440000";
const TEST_UUID_2: vector<u8> = b"550e8400-e29b-41d4-a716-446655440001";
const TEST_UUID_3: vector<u8> = b"550e8400-e29b-41d4-a716-446655440002";
const TEST_GROUP_NAME: vector<u8> = b"Test Group";

/// Builds a valid Seal identity bytes.
/// Format: [group_id (32 bytes)][key_version (8 bytes LE u64)]
fun build_identity(group_id: ID, key_version: u64): vector<u8> {
    let mut id = object::id_to_address(&group_id).to_bytes();
    id.append(bcs::to_bytes(&key_version));
    id
}

/// Sets up a messaging group and returns its ID.
fun setup_group(ts: &mut ts::Scenario): ID {
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let (group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    let group_id = object::id(&group);
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(namespace);

    group_id
}

// === seal_approve_reader tests ===

#[test]
fun seal_approve_reader_valid_identity_and_permission() {
    let mut ts = ts::begin(ALICE);
    let group_id = setup_group(&mut ts);

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();

    // Build valid identity with group_id and key_version 0
    let id = build_identity(group_id, 0);

    // Alice has MessagingReader permission (granted on group creation)
    seal_policies::seal_approve_reader(id, &version, &group, &encryption_history, ts.ctx());

    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(encryption_history);
    ts.end();
}

#[test]
fun seal_approve_reader_with_rotated_key_version() {
    let mut ts = ts::begin(ALICE);
    let group_id = setup_group(&mut ts);

    // Rotate the key
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let mut encryption_history = ts.take_shared<EncryptionHistory>();
    messaging::rotate_encryption_key(&version, &mut encryption_history, &group, b"new_dek", ts.ctx());
    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(encryption_history);

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();

    // Both key versions should work
    seal_policies::seal_approve_reader(build_identity(group_id, 0), &version, &group, &encryption_history, ts.ctx());
    seal_policies::seal_approve_reader(build_identity(group_id, 1), &version, &group, &encryption_history, ts.ctx());

    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(encryption_history);
    ts.end();
}

#[test]
fun seal_approve_reader_member_with_reader_permission() {
    let mut ts = ts::begin(ALICE);
    let group_id = setup_group(&mut ts);

    // Alice grants Bob MessagingReader
    ts.next_tx(ALICE);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    ts::return_shared(group);

    // Bob should be able to approve
    ts.next_tx(BOB);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();
    let id = build_identity(group_id, 0);
    seal_policies::seal_approve_reader(id, &version, &group, &encryption_history, ts.ctx());

    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(encryption_history);
    ts.end();
}

#[test, expected_failure(abort_code = seal_policies::EInvalidIdentity)]
fun seal_approve_reader_invalid_group_id_fails() {
    let mut ts = ts::begin(ALICE);
    setup_group(&mut ts);

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();

    // Build identity with wrong group_id
    let wrong_group_id = object::id_from_address(@0xDEADBEEF);
    let id = build_identity(wrong_group_id, 0);

    seal_policies::seal_approve_reader(id, &version, &group, &encryption_history, ts.ctx());

    abort
}

#[test, expected_failure(abort_code = seal_policies::EInvalidIdentity)]
fun seal_approve_reader_short_id_fails() {
    let mut ts = ts::begin(ALICE);
    setup_group(&mut ts);

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();

    // ID shorter than 40 bytes
    let short_id = vector[1, 2, 3, 4];

    seal_policies::seal_approve_reader(short_id, &version, &group, &encryption_history, ts.ctx());

    abort
}

#[test, expected_failure(abort_code = seal_policies::EInvalidKeyVersion)]
fun seal_approve_reader_future_key_version_fails() {
    let mut ts = ts::begin(ALICE);
    let group_id = setup_group(&mut ts);

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();

    // Try to use key_version 1 when only version 0 exists
    let id = build_identity(group_id, 1);

    seal_policies::seal_approve_reader(id, &version, &group, &encryption_history, ts.ctx());

    abort
}

#[test, expected_failure(abort_code = seal_policies::ENotPermitted)]
fun seal_approve_reader_without_permission_fails() {
    let mut ts = ts::begin(ALICE);
    let group_id = setup_group(&mut ts);

    // Alice grants Bob a permission but NOT MessagingReader
    ts.next_tx(ALICE);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    group.grant_permission<Messaging, MessagingSender>(BOB, ts.ctx());
    ts::return_shared(group);

    // Bob tries to approve but doesn't have MessagingReader
    ts.next_tx(BOB);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();
    let id = build_identity(group_id, 0);

    seal_policies::seal_approve_reader(id, &version, &group, &encryption_history, ts.ctx());

    abort
}

#[test, expected_failure(abort_code = seal_policies::ENotPermitted)]
fun seal_approve_reader_non_member_fails() {
    let mut ts = ts::begin(ALICE);
    let group_id = setup_group(&mut ts);

    // Bob is not a member — has_permission returns false, so the assert fails
    ts.next_tx(BOB);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();
    let id = build_identity(group_id, 0);

    seal_policies::seal_approve_reader(id, &version, &group, &encryption_history, ts.ctx());

    abort
}

#[test, expected_failure(abort_code = seal_policies::EEncryptionHistoryMismatch)]
fun seal_approve_reader_mismatched_encryption_history_fails() {
    let mut ts = ts::begin(ALICE);

    // Create first group
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let version = ts.take_shared<Version>();
    let group_manager = ts.take_shared<GroupManager>();
    let (group1, encryption_history1) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID_2),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    let group1_id = object::id(&group1);
    let encryption_history1_id = object::id(&encryption_history1);
    transfer::public_share_object(group1);
    transfer::public_share_object(encryption_history1);

    // Create second group
    let (group2, encryption_history2) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID_3),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    let encryption_history2_id = object::id(&encryption_history2);
    transfer::public_share_object(group2);
    transfer::public_share_object(encryption_history2);
    ts::return_shared(version);
    ts::return_shared(group_manager);
    ts::return_shared(namespace);

    // Try to use group1 with encryption_history2
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group1 = ts.take_shared_by_id<PermissionedGroup<Messaging>>(group1_id);
    // Take encryption_history2 (wrong one for group1)
    let encryption_history2 = ts.take_shared_by_id<EncryptionHistory>(encryption_history2_id);
    // Also take encryption_history1 so we can return it later
    let encryption_history1 = ts.take_shared_by_id<EncryptionHistory>(encryption_history1_id);

    let id = build_identity(group1_id, 0);
    seal_policies::seal_approve_reader(id, &version, &group1, &encryption_history2, ts.ctx());

    // These won't be reached due to abort, but needed for type checking
    ts::return_shared(version);
    ts::return_shared(group1);
    ts::return_shared(encryption_history1);
    ts::return_shared(encryption_history2);
    ts.end();
}
