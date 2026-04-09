#[test_only]
module sui_stack_messaging::messaging_tests;

use sui_stack_messaging::encryption_history::{Self, EncryptionHistory, EncryptionKeyRotator};
use sui_stack_messaging::group_leaver::GroupLeaver;
use sui_stack_messaging::group_manager::{Self, GroupManager};
use sui_stack_messaging::messaging::{
    Self,
    Messaging,
    MessagingNamespace,
    MessagingSender,
    MessagingReader,
    MessagingEditor,
    MessagingDeleter,
    SuiNsAdmin,
    MetadataAdmin
};
use sui_stack_messaging::version::{Self, Version};
use sui_groups::permissioned_group::{
    Self as pg,
    PermissionedGroup,
    PermissionsAdmin,
    ExtensionPermissionsAdmin
};
use std::string;
use std::unit_test::{assert_eq, destroy};
use sui::test_scenario as ts;
use sui::vec_set;

// === Test Addresses ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;

// === Test Data ===

const TEST_ENCRYPTED_DEK: vector<u8> = b"test_encrypted_dek";
const TEST_ENCRYPTED_DEK_V2: vector<u8> = b"test_encrypted_dek_v2";
const TEST_UUID: vector<u8> = b"550e8400-e29b-41d4-a716-446655440000";
/// Second UUID for tests that create multiple groups in a single scenario.
const TEST_UUID_2: vector<u8> = b"550e8400-e29b-41d4-a716-446655440001";

const TEST_GROUP_NAME: vector<u8> = b"Test Group";

// === version getter tests ===

#[test]
fun version_returns_current_version() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let v = ts.take_shared<Version>();

    assert_eq!(v.version(), version::package_version());

    ts::return_shared(v);
    ts.end();
}

#[test]
fun package_version_returns_constant() {
    // package_version() is a pure function — no shared objects needed
    assert_eq!(version::package_version(), 1);
}

// === encryption_history getter tests ===

#[test]
fun uuid_getter_returns_correct_value() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();
    let (_group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );

    assert_eq!(encryption_history.uuid(), string::utf8(TEST_UUID));

    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    destroy(_group);
    destroy(encryption_history);
    ts.end();
}

// === create_group tests ===

#[test]
fun create_group_creates_group_and_encryption_history() {
    let mut ts = ts::begin(ALICE);

    // Initialize namespace
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create group
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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

    // Verify group creator
    assert!(group.creator<Messaging>() == ALICE);
    assert!(group.is_member(ALICE));
    // Count is 2: creator (ALICE) + GroupLeaver actor (always granted PermissionsAdmin to enable
    // leave)
    assert!(group.permissions_admin_count<Messaging>() == 2);

    // Verify creator has all messaging permissions
    assert!(group.has_permission<Messaging, MessagingSender>(ALICE));
    assert!(group.has_permission<Messaging, MessagingReader>(ALICE));
    assert!(group.has_permission<Messaging, MessagingEditor>(ALICE));
    assert!(group.has_permission<Messaging, MessagingDeleter>(ALICE));
    assert!(group.has_permission<Messaging, EncryptionKeyRotator>(ALICE));
    assert!(group.has_permission<Messaging, SuiNsAdmin>(ALICE));
    assert!(group.has_permission<Messaging, MetadataAdmin>(ALICE));

    // Verify creator has core permissions
    assert!(group.has_permission<Messaging, PermissionsAdmin>(ALICE));
    assert!(group.has_permission<Messaging, ExtensionPermissionsAdmin>(ALICE));

    // Verify encryption history
    assert_eq!(encryption_history.group_id(), object::id(&group));
    assert_eq!(encryption_history.current_key_version(), 0);
    assert_eq!(*encryption_history.current_encrypted_key(), TEST_ENCRYPTED_DEK);

    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    destroy(group);
    destroy(encryption_history);
    ts.end();
}

#[test]
fun create_group_with_different_uuids() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();

    let (group1, eh1) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );

    let (group2, eh2) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID_2),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );

    // Verify groups have different IDs
    assert!(object::id(&group1) != object::id(&group2));

    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    destroy(group1);
    destroy(eh1);
    destroy(group2);
    destroy(eh2);
    ts.end();
}

#[test]
fun create_group_with_initial_members() {
    let mut ts = ts::begin(ALICE);

    // Initialize namespace
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create group with Bob as initial member
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();
    let mut initial_members = vec_set::empty();
    initial_members.insert(BOB);
    let (group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        initial_members,
        ts.ctx(),
    );

    // Verify Bob has MessagingReader permission
    assert_eq!(group.has_permission<Messaging, MessagingReader>(BOB), true);
    assert_eq!(group.is_member(BOB), true);

    // Verify Bob does NOT have other permissions
    assert_eq!(group.has_permission<Messaging, MessagingSender>(BOB), false);
    assert_eq!(group.has_permission<Messaging, PermissionsAdmin>(BOB), false);

    // Verify creator still has all permissions
    assert_eq!(group.has_permission<Messaging, PermissionsAdmin>(ALICE), true);
    assert_eq!(group.has_permission<Messaging, MessagingReader>(ALICE), true);

    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    destroy(group);
    destroy(encryption_history);
    ts.end();
}

#[test]
fun create_group_with_initial_members_including_creator() {
    let mut ts = ts::begin(ALICE);

    // Initialize namespace
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create group with Alice (creator) in initial_members - should be silently skipped
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();
    let mut initial_members = vec_set::empty();
    initial_members.insert(ALICE); // Creator included
    initial_members.insert(BOB);
    let (group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        initial_members,
        ts.ctx(),
    );

    // Verify Bob has MessagingReader
    assert_eq!(group.has_permission<Messaging, MessagingReader>(BOB), true);

    // Verify Alice still has all permissions (not just MessagingReader)
    assert_eq!(group.has_permission<Messaging, PermissionsAdmin>(ALICE), true);
    assert_eq!(group.has_permission<Messaging, MessagingSender>(ALICE), true);

    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    destroy(group);
    destroy(encryption_history);
    ts.end();
}

// === create_group metadata tests ===

#[test]
fun create_group_attaches_metadata() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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

    // Verify Metadata exists
    let m = group_manager::borrow_metadata<Messaging>(&group_manager, &group);
    assert_eq!(*m.name(), string::utf8(TEST_GROUP_NAME));
    assert_eq!(*m.uuid(), string::utf8(TEST_UUID));
    assert_eq!(m.creator(), ALICE);

    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    destroy(group);
    destroy(encryption_history);
    ts.end();
}

// === create_and_share_group tests ===

#[test]
fun create_and_share_group_creates_shared_objects() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();
    messaging::create_and_share_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vector[],
        ts.ctx(),
    );
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Verify shared objects exist
    ts.next_tx(ALICE);
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let encryption_history = ts.take_shared<EncryptionHistory>();

    assert!(group.creator<Messaging>() == ALICE);
    assert_eq!(encryption_history.group_id(), object::id(&group));

    ts::return_shared(group);
    ts::return_shared(encryption_history);
    ts.end();
}

// === rotate_encryption_key tests ===

#[test]
fun rotate_encryption_key_with_permission() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Alice rotates the key
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let mut encryption_history = ts.take_shared<EncryptionHistory>();

    assert_eq!(encryption_history.current_key_version(), 0);

    messaging::rotate_encryption_key(
        &version,
        &mut encryption_history,
        &group,
        TEST_ENCRYPTED_DEK_V2,
        ts.ctx(),
    );

    assert_eq!(encryption_history.current_key_version(), 1);
    assert_eq!(*encryption_history.current_encrypted_key(), TEST_ENCRYPTED_DEK_V2);
    // Old key is still accessible
    assert_eq!(*encryption_history.encrypted_key(0), TEST_ENCRYPTED_DEK);

    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(encryption_history);
    ts.end();
}

#[test, expected_failure(abort_code = sui_stack_messaging::messaging::ENotPermitted)]
fun rotate_encryption_key_without_permission_fails() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();
    let (mut group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    // Add Bob without EncryptionKeyRotator (just grant MessagingReader)
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Bob tries to rotate the key
    ts.next_tx(BOB);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let mut encryption_history = ts.take_shared<EncryptionHistory>();

    messaging::rotate_encryption_key(
        &version,
        &mut encryption_history,
        &group,
        TEST_ENCRYPTED_DEK_V2,
        ts.ctx(),
    );

    abort
}

#[test, expected_failure(abort_code = sui_stack_messaging::messaging::EEncryptionHistoryMismatch)]
fun rotate_encryption_key_with_mismatched_encryption_history_fails() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    // Create two groups with different UUIDs
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();

    let (group1, encryption_history1) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    let group1_id = object::id(&group1);
    transfer::public_share_object(group1);
    transfer::public_share_object(encryption_history1);

    let (_group2, encryption_history2) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID_2),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    let eh2_id = object::id(&encryption_history2);
    transfer::public_share_object(_group2);
    transfer::public_share_object(encryption_history2);

    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Alice tries to rotate group1's key using group2's EncryptionHistory
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group1 = ts.take_shared_by_id<PermissionedGroup<Messaging>>(group1_id);
    let mut encryption_history2 = ts.take_shared_by_id<EncryptionHistory>(eh2_id);

    messaging::rotate_encryption_key(
        &version,
        &mut encryption_history2,
        &group1,
        TEST_ENCRYPTED_DEK_V2,
        ts.ctx(),
    );

    abort
}

// === EncryptionHistory getters tests ===

#[test]
fun encryption_history_encrypted_key_returns_correct_version() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Rotate twice
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let mut encryption_history = ts.take_shared<EncryptionHistory>();

    messaging::rotate_encryption_key(
        &version,
        &mut encryption_history,
        &group,
        b"key_v1",
        ts.ctx(),
    );
    messaging::rotate_encryption_key(
        &version,
        &mut encryption_history,
        &group,
        b"key_v2",
        ts.ctx(),
    );

    // Verify each version
    assert_eq!(*encryption_history.encrypted_key(0), TEST_ENCRYPTED_DEK);
    assert_eq!(*encryption_history.encrypted_key(1), b"key_v1");
    assert_eq!(*encryption_history.encrypted_key(2), b"key_v2");
    assert_eq!(encryption_history.current_key_version(), 2);

    ts::return_shared(version);
    ts::return_shared(group);
    ts::return_shared(encryption_history);
    ts.end();
}

#[test, expected_failure(abort_code = encryption_history::EKeyVersionNotFound)]
fun encryption_history_encrypted_key_invalid_version_fails() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();
    let (_group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );

    // Try to access version 1 when only version 0 exists
    let _ = encryption_history.encrypted_key(1);

    abort
}

// === EEncryptedDEKTooLarge error tests ===

/// Generate a vector of bytes larger than MAX_ENCRYPTED_DEK_BYTES (1024).
fun make_oversized_dek(): vector<u8> {
    vector::tabulate!(1025, |_| 0x42u8)
}

#[test, expected_failure(abort_code = encryption_history::EEncryptedDEKTooLarge)]
fun create_group_with_oversized_dek_fails() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();

    // Try to create group with oversized DEK
    let (_group, _encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        make_oversized_dek(),
        vec_set::empty(),
        ts.ctx(),
    );

    abort
}

#[test, expected_failure(abort_code = encryption_history::EEncryptedDEKTooLarge)]
fun rotate_encryption_key_with_oversized_dek_fails() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Alice tries to rotate with oversized DEK
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let mut encryption_history = ts.take_shared<EncryptionHistory>();

    messaging::rotate_encryption_key(
        &version,
        &mut encryption_history,
        &group,
        make_oversized_dek(),
        ts.ctx(),
    );

    abort
}

// === leave tests ===

#[test]
fun leave_removes_member() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();
    let (mut group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    // Grant Bob MessagingReader so he becomes a member
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Bob leaves
    ts.next_tx(BOB);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let group_leaver = ts.take_shared<GroupLeaver>();
    messaging::leave(&group_leaver, &mut group, ts.ctx());

    assert_eq!(group.is_member(BOB), false);

    ts::return_shared(group);
    ts::return_shared(group_leaver);
    ts.end();
}

#[test, expected_failure(abort_code = messaging::EPermissionsAdminCannotLeave)]
fun leave_permissions_admin_fails() {
    // PermissionsAdmin holders cannot use leave() — they should use remove_member() instead.
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    ts.next_tx(ALICE);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let group_leaver = ts.take_shared<GroupLeaver>();
    messaging::leave(&group_leaver, &mut group, ts.ctx());
    abort
}

#[test, expected_failure(abort_code = sui_groups::permissioned_group::EMemberNotFound)]
fun leave_non_member_fails() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Bob is not a member — leave should fail
    ts.next_tx(BOB);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let group_leaver = ts.take_shared<GroupLeaver>();
    messaging::leave(&group_leaver, &mut group, ts.ctx());

    abort
}

// === metadata tests ===

#[test]
fun set_group_name_succeeds_with_metadata_admin() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Alice (MetadataAdmin) sets the group name
    ts.next_tx(ALICE);
    let group_manager = ts.take_shared<GroupManager>();
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let new_name = string::utf8(b"New Name");
    messaging::set_group_name(&group_manager, &mut group, new_name, ts.ctx());

    // Verify
    let m = group_manager::borrow_metadata<Messaging>(&group_manager, &group);
    assert_eq!(*m.name(), new_name);

    ts::return_shared(group_manager);
    ts::return_shared(group);
    ts.end();
}

#[test, expected_failure(abort_code = sui_stack_messaging::messaging::ENotPermitted)]
fun set_group_name_fails_without_permission() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
    let group_manager = ts.take_shared<GroupManager>();
    let (mut group, encryption_history) = messaging::create_group(
        &version,
        &mut namespace,
        &group_manager,
        string::utf8(TEST_GROUP_NAME),
        string::utf8(TEST_UUID),
        TEST_ENCRYPTED_DEK,
        vec_set::empty(),
        ts.ctx(),
    );
    // Add Bob with just MessagingReader (no MetadataAdmin)
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Bob tries to set group name — should fail
    ts.next_tx(BOB);
    let group_manager = ts.take_shared<GroupManager>();
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    messaging::set_group_name(
        &group_manager,
        &mut group,
        string::utf8(b"Hacked Name"),
        ts.ctx(),
    );

    abort
}

#[test]
fun insert_and_remove_group_data() {
    let mut ts = ts::begin(ALICE);

    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    ts::return_shared(version);
    ts::return_shared(namespace);
    ts::return_shared(group_manager);

    // Alice inserts data
    ts.next_tx(ALICE);
    let group_manager = ts.take_shared<GroupManager>();
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let key = string::utf8(b"description");
    let value = string::utf8(b"A test group");
    messaging::insert_group_data(&group_manager, &mut group, key, value, ts.ctx());

    // Verify data exists
    let m = group_manager::borrow_metadata<Messaging>(&group_manager, &group);
    assert_eq!(m.data().length(), 1);

    // Remove the data
    let (removed_key, removed_value) = messaging::remove_group_data(
        &group_manager,
        &mut group,
        &key,
        ts.ctx(),
    );
    assert_eq!(removed_key, key);
    assert_eq!(removed_value, value);

    // Verify data is gone
    let m = group_manager::borrow_metadata<Messaging>(&group_manager, &group);
    assert_eq!(m.data().length(), 0);

    ts::return_shared(group_manager);
    ts::return_shared(group);
    ts.end();
}

// === archive tests ===

/// Helper: creates a group, shares it, and returns the group ID.
fun setup_shared_group(ts: &mut ts::Scenario): ID {
    ts.next_tx(ALICE);
    messaging::init_for_testing(ts.ctx());
    version::init_for_testing(ts.ctx());

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut namespace = ts.take_shared<MessagingNamespace>();
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
    ts::return_shared(namespace);
    ts::return_shared(group_manager);
    group_id
}

/// Helper: archives the group as ALICE (who has PermissionsAdmin from creation).
fun archive_group(ts: &mut ts::Scenario) {
    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    messaging::archive_group(&version, &mut group, ts.ctx());
    ts::return_shared(group);
    ts::return_shared(version);
}

#[test, expected_failure(abort_code = sui_stack_messaging::messaging::EGroupArchived)]
fun rotate_encryption_key_on_archived_group_fails() {
    let mut ts = ts::begin(ALICE);
    setup_shared_group(&mut ts);
    archive_group(&mut ts);

    ts.next_tx(ALICE);
    let version = ts.take_shared<Version>();
    let group = ts.take_shared<PermissionedGroup<Messaging>>();
    let mut encryption_history = ts.take_shared<EncryptionHistory>();

    messaging::rotate_encryption_key(
        &version,
        &mut encryption_history,
        &group,
        TEST_ENCRYPTED_DEK_V2,
        ts.ctx(),
    );

    abort
}

#[test, expected_failure(abort_code = pg::EGroupPaused)]
fun leave_on_archived_group_fails() {
    let mut ts = ts::begin(ALICE);
    setup_shared_group(&mut ts);

    // Add Bob as a member before archiving
    ts.next_tx(ALICE);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    group.grant_permission<Messaging, MessagingReader>(BOB, ts.ctx());
    ts::return_shared(group);

    archive_group(&mut ts);

    // Bob tries to leave the archived group
    ts.next_tx(BOB);
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    let group_leaver = ts.take_shared<GroupLeaver>();
    messaging::leave(&group_leaver, &mut group, ts.ctx());

    abort
}

#[test, expected_failure(abort_code = pg::EGroupPaused)]
fun set_group_name_on_archived_group_fails() {
    let mut ts = ts::begin(ALICE);
    setup_shared_group(&mut ts);
    archive_group(&mut ts);

    ts.next_tx(ALICE);
    let group_manager = ts.take_shared<GroupManager>();
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    messaging::set_group_name(
        &group_manager,
        &mut group,
        string::utf8(b"New Name"),
        ts.ctx(),
    );

    abort
}

#[test, expected_failure(abort_code = pg::EGroupPaused)]
fun insert_group_data_on_archived_group_fails() {
    let mut ts = ts::begin(ALICE);
    setup_shared_group(&mut ts);
    archive_group(&mut ts);

    ts.next_tx(ALICE);
    let group_manager = ts.take_shared<GroupManager>();
    let mut group = ts.take_shared<PermissionedGroup<Messaging>>();
    messaging::insert_group_data(
        &group_manager,
        &mut group,
        string::utf8(b"key"),
        string::utf8(b"value"),
        ts.ctx(),
    );

    abort
}
