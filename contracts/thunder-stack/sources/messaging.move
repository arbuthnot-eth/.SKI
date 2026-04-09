/// Module: messaging
///
/// Public-facing module for the messaging package. All external interactions
/// should go through this module.
///
/// Wraps `permissions_group` to provide messaging-specific permission management
/// and `encryption_history` for key rotation.
///
/// ## Permissions
///
/// From groups (auto-granted to creator):
/// - `PermissionsAdmin`: Manages core permissions (from permissioned_groups package)
/// - `ExtensionPermissionsAdmin`: Manages extension permissions (from other packages)
///
/// Messaging-specific:
/// - `MessagingSender`: Send messages
/// - `MessagingReader`: Read/decrypt messages
/// - `MessagingEditor`: Edit messages
/// - `MessagingDeleter`: Delete messages
/// - `EncryptionKeyRotator`: Rotate encryption keys
/// - `SuiNsAdmin`: Manage SuiNS reverse lookups on the group
/// - `MetadataAdmin`: Edit group metadata (name, data)
///
/// ## Security
///
/// - Membership is defined by having at least one permission
/// - Granting a permission implicitly adds the member if they don't exist
/// - Revoking the last permission automatically removes the member
///
module sui_stack_messaging::messaging;

use sui_stack_messaging::encryption_history::{Self, EncryptionHistory, EncryptionKeyRotator};
use sui_stack_messaging::group_leaver::{Self, GroupLeaver};
use sui_stack_messaging::group_manager::{Self, GroupManager};
use sui_stack_messaging::metadata;
use sui_stack_messaging::version::Version;
use sui_groups::permissioned_group::{
    Self,
    PermissionedGroup,
    PermissionsAdmin,
    ObjectAdmin
};
use std::string::String;
use sui::derived_object;
use sui::package;
use sui::vec_set::{Self, VecSet};
use suins::suins::SuiNS;

// === Error Codes ===

/// Caller lacks the required permission for the operation.
const ENotPermitted: u64 = 0;
/// The group is archived (paused) and cannot be mutated.
const EGroupArchived: u64 = 1;
/// The provided `EncryptionHistory` does not belong to the given group.
const EEncryptionHistoryMismatch: u64 = 2;
/// `PermissionsAdmin` holders cannot use `leave()`. They should use
/// `permissioned_group::remove_member()` for their own address instead,
/// which has a best-effort guard against removing the last `PermissionsAdmin`
/// (see `ELastPermissionsAdmin` — note that this count includes actor-object admins).
const EPermissionsAdminCannotLeave: u64 = 3;

// === Witnesses ===

/// One-Time Witness for claiming Publisher.
public struct MESSAGING() has drop;

/// Package witness for `PermissionedGroup<Messaging>`.
public struct Messaging() has drop;

// === Permission Witnesses ===

/// Permission to send messages to the group.
/// Separate from `MessagingReader` to enable mute functionality.
public struct MessagingSender() has drop;

/// Permission to read/decrypt messages from the group.
/// Separate from `MessagingSender` to enable read-only or write-only access.
public struct MessagingReader() has drop;

/// Permission to delete messages in the group.
public struct MessagingDeleter() has drop;

/// Permission to edit messages in the group.
public struct MessagingEditor() has drop;

/// Permission to manage SuiNS reverse lookups on the group.
public struct SuiNsAdmin() has drop;

/// Permission to edit group metadata (name, data).
public struct MetadataAdmin() has drop;

// === Structs ===

/// Shared object used as namespace for deriving group and encryption history addresses.
/// One per package deployment.
public struct MessagingNamespace has key {
    id: UID,
}

fun init(otw: MESSAGING, ctx: &mut TxContext) {
    package::claim_and_keep(otw, ctx);

    let mut namespace = MessagingNamespace {
        id: object::new(ctx),
    };

    let group_leaver = group_leaver::new(&mut namespace.id);
    let group_manager = group_manager::new(&mut namespace.id);
    transfer::share_object(namespace);
    group_leaver.share();
    group_manager.share();
}

// === Public Functions ===

/// Creates a new messaging group with encryption.
/// The transaction sender (`ctx.sender()`) automatically becomes the creator with all permissions.
///
/// # Parameters
/// - `version`: Reference to the Version shared object
/// - `namespace`: Mutable reference to the MessagingNamespace
/// - `group_manager`: Reference to the shared GroupManager actor
/// - `name`: Human-readable group name
/// - `uuid`: Client-provided UUID for deterministic address derivation
/// - `initial_encrypted_dek`: Initial Seal-encrypted DEK bytes
/// - `initial_members`: Addresses to grant `MessagingReader` permission (should not include
/// creator)
/// - `ctx`: Transaction context
///
/// # Returns
/// Tuple of `(PermissionedGroup<Messaging>, EncryptionHistory)`.
///
/// # Note
/// If `initial_members` contains the creator's address, it is silently skipped (no abort).
/// This handles the common case where the creator might be mistakenly included in the initial
/// members list.
///
/// # Aborts
/// - `EInvalidVersion` (from `version`): if package version doesn't match
/// - If the UUID has already been used (duplicate derivation)
public fun create_group(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: VecSet<address>,
    ctx: &mut TxContext,
): (PermissionedGroup<Messaging>, EncryptionHistory) {
    version.validate_version();
    let mut group: PermissionedGroup<Messaging> = permissioned_group::new_derived<
        Messaging,
        encryption_history::PermissionedGroupTag,
    >(
        Messaging(),
        &mut namespace.id,
        encryption_history::permissions_group_tag(uuid),
        ctx,
    );

    let creator = ctx.sender();
    grant_all_messaging_permissions(&mut group, creator, ctx);

    // Grant PermissionsAdmin to the GroupLeaver actor so it can remove members on behalf of
    // callers.
    // The address is derived deterministically from the namespace — no need to pass the object.
    let group_leaver_address = derived_object::derive_address(
        object::id(namespace),
        group_leaver::derivation_key(),
    );
    group.grant_permission<Messaging, PermissionsAdmin>(group_leaver_address, ctx);

    // Grant ObjectAdmin to the GroupManager actor so it can access the group UID
    // for SuiNS reverse lookups and metadata management.
    group.grant_permission<Messaging, ObjectAdmin>(
        object::id(group_manager).to_address(),
        ctx,
    );

    // Attach Metadata via GroupManager
    let m = metadata::new(name, uuid, creator);
    group_manager::attach_metadata<Messaging>(group_manager, &mut group, m);

    // Grant MessagingReader permission to initial members (skip creator)
    initial_members.into_keys().do!(|member| {
        if (member != creator) {
            group.grant_permission<Messaging, MessagingReader>(member, ctx);
        };
    });

    let encryption_history = encryption_history::new(
        &mut namespace.id,
        uuid,
        object::id(&group),
        initial_encrypted_dek,
        ctx,
    );

    (group, encryption_history)
}

/// Creates a new messaging group and shares both objects.
///
/// # Parameters
/// - `version`: Reference to the Version shared object
/// - `namespace`: Mutable reference to the MessagingNamespace
/// - `group_manager`: Reference to the shared GroupManager actor
/// - `name`: Human-readable group name
/// - `uuid`: Client-provided UUID for deterministic address derivation
/// - `initial_encrypted_dek`: Initial Seal-encrypted DEK bytes
/// - `initial_members`: Set of addresses to grant `MessagingReader` permission
/// - `ctx`: Transaction context
///
/// # Note
/// See `create_group` for details on creator permissions and initial member handling.
#[allow(lint(share_owned))]
entry fun create_and_share_group(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    initial_members: vector<address>,
    ctx: &mut TxContext,
) {
    let (group, encryption_history) = create_group(
        version,
        namespace,
        group_manager,
        name,
        uuid,
        initial_encrypted_dek,
        vec_set::from_keys(initial_members),
        ctx,
    );
    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
}

/// Rotates the encryption key for a group.
///
/// # Parameters
/// - `encryption_history`: Mutable reference to the group's EncryptionHistory
/// - `group`: Reference to the PermissionedGroup<Messaging>
/// - `new_encrypted_dek`: New Seal-encrypted DEK bytes
/// - `ctx`: Transaction context
///
/// # Aborts
/// - `EInvalidVersion` (from `version`): if package version doesn't match
/// - `ENotPermitted`: if caller doesn't have `EncryptionKeyRotator` permission
public fun rotate_encryption_key(
    version: &Version,
    encryption_history: &mut EncryptionHistory,
    group: &PermissionedGroup<Messaging>,
    new_encrypted_dek: vector<u8>,
    ctx: &TxContext,
) {
    version.validate_version();
    assert!(!group.is_paused(), EGroupArchived);
    assert!(encryption_history.group_id() == object::id(group), EEncryptionHistoryMismatch);
    assert!(group.has_permission<Messaging, EncryptionKeyRotator>(ctx.sender()), ENotPermitted);
    encryption_history.rotate_key(new_encrypted_dek);
}

/// Removes the caller from a messaging group.
/// The `GroupLeaver` actor holds `PermissionsAdmin` on all groups and calls
/// `object_remove_member` on behalf of the caller.
///
/// `PermissionsAdmin` holders cannot use this function. Since they already have
/// `PermissionsAdmin`, they can call `permissioned_group::remove_member()` for
/// their own address instead. Alternatively, they can first revoke their own
/// `PermissionsAdmin` and then call `leave()`.
///
/// **Why**: `leave()` is a self-service action via the `GroupLeaver` actor object.
/// Since `permissions_admin_count` includes both human and actor-object admins,
/// there is no reliable way to determine whether removing the caller would leave
/// the group without a human admin. Blocking `PermissionsAdmin` holders from
/// `leave()` makes this a deliberate admin decision rather than a casual action.
///
/// **Limitation**: Note that `permissions_admin_count` is a best-effort invariant.
/// Even via `remove_member()`, a group could end up with only actor-object admins
/// if the caller removes themselves when they are the last human admin. The count
/// cannot distinguish human from actor-object holders.
///
/// # Parameters
/// - `group_leaver`: Reference to the shared `GroupLeaver` object
/// - `group`: Mutable reference to the `PermissionedGroup<Messaging>`
/// - `ctx`: Transaction context
///
/// # Aborts
/// - `EPermissionsAdminCannotLeave`: if the caller holds `PermissionsAdmin`
/// - `EMemberNotFound` (from `permissioned_group`): if the caller is not a member
public fun leave(
    group_leaver: &GroupLeaver,
    group: &mut PermissionedGroup<Messaging>,
    ctx: &TxContext,
) {
    assert!(
        !group.has_permission<Messaging, PermissionsAdmin>(ctx.sender()),
        EPermissionsAdminCannotLeave,
    );
    group_leaver::leave<Messaging>(group_leaver, group, ctx);
}

// === Archive Functions ===

/// Permanently archives a messaging group.
///
/// Pauses the group and burns the `UnpauseCap`, making it impossible to unpause.
/// After this call, `is_paused()` returns `true` and all mutations are blocked.
///
/// The caller must have `PermissionsAdmin` permission (enforced by `pause()`).
///
/// # Aborts
/// - `ENotPermitted` (from `pause`): if caller doesn't have `PermissionsAdmin`
/// - `EAlreadyPaused` (from `pause`): if the group is already paused
///
/// # Note
/// Alternative to burning: `transfer::public_freeze_object(cap)` makes the cap immutable
/// and un-passable by value, also preventing unpause without destroying the object.
entry fun archive_group(
    version: &Version,
    group: &mut PermissionedGroup<Messaging>,
    ctx: &mut TxContext,
) {
    version.validate_version();
    let cap = group.pause<Messaging>(ctx);
    cap.burn();
}

// === SuiNS Functions ===

/// Sets a SuiNS reverse lookup on a messaging group.
/// The caller must have `SuiNsAdmin` permission on the group.
/// The `GroupManager` actor internally holds `ObjectAdmin` to access the group UID.
///
/// # Parameters
/// - `group_manager`: Reference to the shared `GroupManager` actor
/// - `group`: Mutable reference to the `PermissionedGroup<Messaging>`
/// - `suins`: Mutable reference to the SuiNS shared object
/// - `domain_name`: The domain name to set as reverse lookup
/// - `ctx`: Transaction context
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `SuiNsAdmin`
public fun set_suins_reverse_lookup(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    suins: &mut SuiNS,
    domain_name: String,
    ctx: &TxContext,
) {
    assert!(group.has_permission<Messaging, SuiNsAdmin>(ctx.sender()), ENotPermitted);
    group_manager::set_reverse_lookup<Messaging>(group_manager, group, suins, domain_name);
}

/// Unsets a SuiNS reverse lookup on a messaging group.
/// The caller must have `SuiNsAdmin` permission on the group.
/// The `GroupManager` actor internally holds `ObjectAdmin` to access the group UID.
///
/// # Parameters
/// - `group_manager`: Reference to the shared `GroupManager` actor
/// - `group`: Mutable reference to the `PermissionedGroup<Messaging>`
/// - `suins`: Mutable reference to the SuiNS shared object
/// - `ctx`: Transaction context
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `SuiNsAdmin`
public fun unset_suins_reverse_lookup(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    suins: &mut SuiNS,
    ctx: &TxContext,
) {
    assert!(group.has_permission<Messaging, SuiNsAdmin>(ctx.sender()), ENotPermitted);
    group_manager::unset_reverse_lookup<Messaging>(group_manager, group, suins);
}

// === Metadata Functions ===

/// Sets the group name.
/// Caller must have `MetadataAdmin` permission.
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
/// - `ENameTooLong` (from `metadata`): if name exceeds limit
public fun set_group_name(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    name: String,
    ctx: &TxContext,
) {
    assert!(group.has_permission<Messaging, MetadataAdmin>(ctx.sender()), ENotPermitted);
    let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, group);
    m.set_name(name);
}

/// Inserts a key-value pair into the group's metadata data map.
/// Caller must have `MetadataAdmin` permission.
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
/// - `EDataKeyTooLong` (from `metadata`): if key exceeds limit
/// - `EDataValueTooLong` (from `metadata`): if value exceeds limit
public fun insert_group_data(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    key: String,
    value: String,
    ctx: &TxContext,
) {
    assert!(group.has_permission<Messaging, MetadataAdmin>(ctx.sender()), ENotPermitted);
    let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, group);
    m.insert_data(key, value);
}

/// Removes a key-value pair from the group's metadata data map.
/// Caller must have `MetadataAdmin` permission.
///
/// # Returns
/// The removed (key, value) tuple.
///
/// # Aborts
/// - `ENotPermitted`: if caller doesn't have `MetadataAdmin`
public fun remove_group_data(
    group_manager: &GroupManager,
    group: &mut PermissionedGroup<Messaging>,
    key: &String,
    ctx: &TxContext,
): (String, String) {
    assert!(group.has_permission<Messaging, MetadataAdmin>(ctx.sender()), ENotPermitted);
    let m = group_manager::borrow_metadata_mut<Messaging>(group_manager, group);
    m.remove_data(key)
}

/// Grants all messaging permissions to a member.
/// Includes: `MessagingSender`, `MessagingReader`, `MessagingEditor`,
/// `MessagingDeleter`, `EncryptionKeyRotator`, `SuiNsAdmin`, `MetadataAdmin`.
fun grant_all_messaging_permissions(
    group: &mut PermissionedGroup<Messaging>,
    member: address,
    ctx: &TxContext,
) {
    group.grant_permission<Messaging, MessagingSender>(member, ctx);
    group.grant_permission<Messaging, MessagingReader>(member, ctx);
    group.grant_permission<Messaging, MessagingEditor>(member, ctx);
    group.grant_permission<Messaging, MessagingDeleter>(member, ctx);
    group.grant_permission<Messaging, EncryptionKeyRotator>(member, ctx);
    group.grant_permission<Messaging, SuiNsAdmin>(member, ctx);
    group.grant_permission<Messaging, MetadataAdmin>(member, ctx);
}

// === Test Helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(MESSAGING(), ctx);
}

#[test_only]
public fun get_otw_for_testing(): MESSAGING {
    MESSAGING()
}
