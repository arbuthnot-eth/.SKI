/// Module: metadata
///
/// Metadata associated with a messaging group.
/// Stored as a dynamic field on the `PermissionedGroup<Messaging>` object
/// via the `GroupManager` actor.
///
/// Immutable fields (set at creation, never changed):
/// - `uuid`: Client-provided UUID
/// - `creator`: Address of the group creator
///
/// Mutable fields (editable by `MetadataAdmin` holders):
/// - `name`: Human-readable group name
/// - `data`: Key-value map for arbitrary extension data
module sui_stack_messaging::metadata;

use std::string::String;
use sui::vec_map::{Self, VecMap};

// === Error Codes ===

/// Group name exceeds the maximum allowed length.
const ENameTooLong: u64 = 0;
/// Data key exceeds the maximum allowed length.
const EDataKeyTooLong: u64 = 1;
/// Data value exceeds the maximum allowed length.
const EDataValueTooLong: u64 = 2;

// === Constants ===

/// Schema version for the Metadata struct. Bumped when the struct changes.
const METADATA_SCHEMA_VERSION: u64 = 1;
/// Maximum length for the group name (in bytes).
const MAX_NAME_LENGTH: u64 = 128;
/// Maximum length for a data key (in bytes).
const MAX_DATA_KEY_LENGTH: u64 = 64;
/// Maximum length for a data value (in bytes).
const MAX_DATA_VALUE_LENGTH: u64 = 256;

// === Structs ===

/// Dynamic field key for Metadata on a PermissionedGroup<Messaging>.
/// Versioned by schema version — bumped when the Metadata struct changes.
public struct MetadataKey(u64) has copy, drop, store;

/// Metadata associated with a messaging group.
public struct Metadata has store, drop, copy {
    name: String,
    uuid: String,
    creator: address,
    data: VecMap<String, String>,
}

// === Key Constructor ===

/// Returns the dynamic field key for the current schema version.
public fun key(): MetadataKey { MetadataKey(METADATA_SCHEMA_VERSION) }

// === Constructor ===

/// Creates a new Metadata instance.
///
/// # Parameters
/// - `name`: Human-readable group name
/// - `uuid`: Client-provided UUID
/// - `creator`: Address of the group creator
///
/// # Aborts
/// - `ENameTooLong`: if name exceeds MAX_NAME_LENGTH
public(package) fun new(
    name: String,
    uuid: String,
    creator: address,
): Metadata {
    assert!(name.length() <= MAX_NAME_LENGTH, ENameTooLong);
    Metadata { name, uuid, creator, data: vec_map::empty() }
}

// === Getters ===

public fun name(self: &Metadata): &String { &self.name }
public fun uuid(self: &Metadata): &String { &self.uuid }
public fun creator(self: &Metadata): address { self.creator }
public fun data(self: &Metadata): &VecMap<String, String> { &self.data }

// === Mutable Setters (package-only, permission check at caller) ===

/// Sets the group name.
///
/// # Aborts
/// - `ENameTooLong`: if name exceeds MAX_NAME_LENGTH
public(package) fun set_name(self: &mut Metadata, name: String) {
    assert!(name.length() <= MAX_NAME_LENGTH, ENameTooLong);
    self.name = name;
}

/// Inserts a key-value pair into the data map.
///
/// # Aborts
/// - `EDataKeyTooLong`: if key exceeds MAX_DATA_KEY_LENGTH
/// - `EDataValueTooLong`: if value exceeds MAX_DATA_VALUE_LENGTH
public(package) fun insert_data(self: &mut Metadata, key: String, value: String) {
    assert!(key.length() <= MAX_DATA_KEY_LENGTH, EDataKeyTooLong);
    assert!(value.length() <= MAX_DATA_VALUE_LENGTH, EDataValueTooLong);
    self.data.insert(key, value);
}

/// Removes a key-value pair from the data map.
///
/// # Returns
/// The removed (key, value) tuple.
public(package) fun remove_data(self: &mut Metadata, key: &String): (String, String) {
    self.data.remove(key)
}
