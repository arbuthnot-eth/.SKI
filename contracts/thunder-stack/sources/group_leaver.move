/// Module: group_leaver
///
/// Actor object that allows group members to leave a `PermissionedGroup<T>`.
///
/// `GroupLeaver` is a derived singleton object from `MessagingNamespace`.
/// It is granted `PermissionsAdmin` on every group created via `messaging::create_group`,
/// and exposes a `leave` function that calls `object_remove_member` on behalf of the caller.
///
/// This module does NOT import `messaging.move` to avoid a circular dependency.
/// The generic `leave<T: drop>` is instantiated with the concrete `Messaging` type
/// at the call site in `messaging.move`.
///
/// All public entry points are in the `messaging` module:
/// - `messaging::leave` - removes the caller from a group
module sui_stack_messaging::group_leaver;

use sui_groups::permissioned_group::PermissionedGroup;
use std::string::String;
use sui::derived_object;

// === Derivation Key ===

/// Fixed derivation key for the singleton `GroupLeaver` derived from `MessagingNamespace`.
const GROUP_LEAVER_DERIVATION_KEY: vector<u8> = b"group_leaver";

// === Structs ===

/// Actor object that holds `PermissionsAdmin` on all messaging groups.
/// The `id` field is intentionally private — no UID getter is exposed.
/// All leave operations go through the package-internal `leave<T>` function.
public struct GroupLeaver has key {
    id: UID,
}

// === Package Functions ===

/// Creates a new `GroupLeaver` derived from the namespace UID.
/// Called once during `messaging::init`.
///
/// # Parameters
/// - `namespace_uid`: Mutable reference to the `MessagingNamespace` UID
///
/// # Returns
/// A new `GroupLeaver` object with a deterministic address.
public(package) fun new(namespace_uid: &mut UID): GroupLeaver {
    GroupLeaver {
        id: derived_object::claim(namespace_uid, GROUP_LEAVER_DERIVATION_KEY.to_string()),
    }
}

/// Shares the `GroupLeaver` object on-chain.
/// Called once during `messaging::init` after creating the object.
public(package) fun share(self: GroupLeaver) {
    transfer::share_object(self);
}

/// Returns the fixed derivation key string.
/// Used by `messaging::create_group` to compute the `GroupLeaver`'s address via
/// `derived_object::derive_address` without holding the object.
///
/// # Returns
/// The string key used for address derivation.
public(package) fun derivation_key(): String {
    GROUP_LEAVER_DERIVATION_KEY.to_string()
}

/// Removes the caller (`ctx.sender()`) from the group.
/// The `GroupLeaver` must have `PermissionsAdmin` on the group (granted at creation time).
///
/// Generic over `T: drop` so this module does not need to import `messaging.move`.
/// Instantiated as `leave<Messaging>` at the call site in `messaging.move`.
///
/// # Aborts
/// - `ENotPermitted`: if this actor doesn't have `PermissionsAdmin` on the group
/// - `EMemberNotFound`: if the caller is not a member of the group
/// - `ELastPermissionsAdmin`: if the caller is the last `PermissionsAdmin`
public(package) fun leave<T: drop>(
    self: &GroupLeaver,
    group: &mut PermissionedGroup<T>,
    ctx: &TxContext,
) {
    group.object_remove_member<T>(&self.id, ctx.sender());
}
