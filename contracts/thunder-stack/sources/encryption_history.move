/// Module: encryption_history
///
/// Internal module for envelope encryption key management.
/// Stores encrypted DEKs (Data Encryption Keys) with version tracking for key rotation.
///
/// `EncryptionHistory` is a derived object from `MessagingNamespace`, enabling
/// deterministic address derivation for Seal encryption namespacing.
///
/// Uses client-provided UUIDs for derivation, enabling predictable group IDs
/// for single-transaction encryption with Seal.
///
/// All public entry points are in the `messaging` module:
/// - `messaging::create_group` - creates group with encryption
/// - `messaging::rotate_encryption_key` - rotates keys
///
module sui_stack_messaging::encryption_history;

use std::string::String;
use sui::derived_object;
use sui::event;
use sui::table_vec::{Self, TableVec};

// === Error Codes ===

const EEncryptionHistoryAlreadyExists: u64 = 0;
const EKeyVersionNotFound: u64 = 1;
const EEncryptedDEKTooLarge: u64 = 2;

// === Constants ===

/// Maximum allowed size for encrypted DEK bytes.
///
/// Accommodates a BCS-serialized Seal EncryptedObject containing:
/// - AES-256-GCM key (32 bytes) encrypted with AES-256-GCM will result in 48 bytes
/// - potentially AAD (additional authenticated data) - variable size, typically 16-32 bytes
/// - Seal package ID (32 bytes)
/// - Identity bytes: Creator's Sui address (32 bytes) + nonce (up to 32 bytes)
/// - services: vector((address (32 bytes), weight (1 byte))) - typically 2-3 entries
/// - Encrypted key shares - {
///     nonce(96 bytes),
///     encryptedShares (vector(32 bytes each)),
///     encryptedRandomness (32 bytes)
/// }
const MAX_ENCRYPTED_DEK_BYTES: u64 = 1024;

// === Derivation Keys ===

/// Key for deriving `EncryptionHistory` address from `MessagingNamespace`.
/// Uses client-provided UUID (String) for predictable address derivation.
public struct EncryptionHistoryTag(String) has copy, drop, store;

/// Key for deriving `PermissionedGroup<Messaging>` address from `MessagingNamespace`.
/// Uses client-provided UUID (String) for predictable address derivation.
public struct PermissionedGroupTag(String) has copy, drop, store;

// === Permission Witnesses ===

/// Permission to rotate encryption keys. Auto-granted to group creator.
public struct EncryptionKeyRotator() has drop;

// === Structs ===

/// Encrypted key history for a messaging group.
/// Derived object from `MessagingNamespace` with 1:1 relationship to `PermissionedGroup<Messaging>`.
public struct EncryptionHistory has key, store {
    id: UID,
    /// Associated `PermissionedGroup<Messaging>` ID.
    group_id: ID,
    /// UUID used for derivation.
    uuid: String,
    /// Versioned encrypted DEKs. Index = version number.
    /// Each entry is Seal `EncryptedObject` bytes.
    encrypted_keys: TableVec<vector<u8>>,
}

// === Events ===

/// Emitted when a new EncryptionHistory is created.
public struct EncryptionHistoryCreated has copy, drop {
    /// ID of the created EncryptionHistory.
    encryption_history_id: ID,
    /// ID of the associated PermissionedGroup<Messaging>.
    group_id: ID,
    /// UUID used for derivation.
    uuid: String,
    /// Initial encrypted DEK bytes.
    initial_encrypted_dek: vector<u8>,
}

/// Emitted when an encryption key is rotated.
public struct EncryptionKeyRotated has copy, drop {
    /// ID of the EncryptionHistory.
    encryption_history_id: ID,
    /// ID of the associated PermissionedGroup<Messaging>.
    group_id: ID,
    /// New key version (0-indexed).
    new_key_version: u64,
    /// New encrypted DEK bytes.
    new_encrypted_dek: vector<u8>,
}

// === Package Functions ===

/// Creates a new `EncryptionHistory` derived from the namespace.
/// Uses `EncryptionHistoryTag(uuid)` as the derivation key.
///
/// # Parameters
/// - `namespace_uid`: Mutable reference to the MessagingNamespace UID
/// - `uuid`: Client-provided UUID for deterministic address derivation
/// - `group_id`: ID of the associated PermissionedGroup<Messaging>
/// - `initial_encrypted_dek`: Initial Seal-encrypted DEK bytes
/// - `ctx`: Transaction context
///
/// # Returns
/// A new `EncryptionHistory` object.
///
/// # Aborts
/// - `EEncryptionHistoryAlreadyExists`: if derived address is already claimed (duplicate UUID)
/// - `EEncryptedDEKTooLarge`: if the initial DEK exceeds maximum size
public(package) fun new(
    namespace_uid: &mut UID,
    uuid: String,
    group_id: ID,
    initial_encrypted_dek: vector<u8>,
    ctx: &mut TxContext,
): EncryptionHistory {
    assert!(
        !derived_object::exists(namespace_uid, EncryptionHistoryTag(uuid)),
        EEncryptionHistoryAlreadyExists,
    );
    assert!(initial_encrypted_dek.length() <= MAX_ENCRYPTED_DEK_BYTES, EEncryptedDEKTooLarge);

    let mut encrypted_keys = table_vec::empty<vector<u8>>(ctx);
    encrypted_keys.push_back(initial_encrypted_dek);

    let encryption_history = EncryptionHistory {
        id: derived_object::claim(
            namespace_uid,
            EncryptionHistoryTag(uuid),
        ),
        uuid,
        group_id,
        encrypted_keys,
    };

    event::emit(EncryptionHistoryCreated {
        encryption_history_id: object::id(&encryption_history),
        group_id,
        uuid: encryption_history.uuid,
        initial_encrypted_dek,
    });

    encryption_history
}

/// Appends a new encrypted DEK. Caller must verify permissions.
///
/// # Parameters
/// - `self`: Mutable reference to the EncryptionHistory
/// - `new_encrypted_dek`: New Seal-encrypted DEK bytes
///
/// # Aborts
/// - `EEncryptedDEKTooLarge`: if the new DEK exceeds maximum size
public(package) fun rotate_key(self: &mut EncryptionHistory, new_encrypted_dek: vector<u8>) {
    assert!(new_encrypted_dek.length() <= MAX_ENCRYPTED_DEK_BYTES, EEncryptedDEKTooLarge);
    self.encrypted_keys.push_back(new_encrypted_dek);

    event::emit(EncryptionKeyRotated {
        encryption_history_id: object::id(self),
        group_id: self.group_id,
        new_key_version: self.encrypted_keys.length() - 1,
        new_encrypted_dek,
    });
}

/// Returns the `PermissionedGroupTag` for address derivation.
///
/// # Parameters
/// - `uuid`: Client-provided UUID for deterministic address derivation
///
/// # Returns
/// A `PermissionedGroupTag` wrapping the UUID.
public(package) fun permissions_group_tag(uuid: String): PermissionedGroupTag {
    PermissionedGroupTag(uuid)
}

// === Getters ===

/// Returns the associated `PermissionedGroup<Messaging>` ID.
///
/// # Parameters
/// - `self`: Reference to the EncryptionHistory
///
/// # Returns
/// The group ID.
public fun group_id(self: &EncryptionHistory): ID {
    self.group_id
}

/// Returns the UUID used for derivation.
///
/// # Parameters
/// - `self`: Reference to the EncryptionHistory
///
/// # Returns
/// The UUID string.
public fun uuid(self: &EncryptionHistory): String {
    self.uuid
}

/// Returns the current key version (0-indexed).
///
/// # Parameters
/// - `self`: Reference to the EncryptionHistory
///
/// # Returns
/// The current (latest) key version.
public fun current_key_version(self: &EncryptionHistory): u64 {
    self.encrypted_keys.length() - 1
}

/// Returns the encrypted DEK for a specific version.
///
/// # Parameters
/// - `self`: Reference to the EncryptionHistory
/// - `version`: The key version to retrieve (0-indexed)
///
/// # Returns
/// Reference to the encrypted DEK bytes.
///
/// # Aborts
/// - `EKeyVersionNotFound`: if the version doesn't exist
public fun encrypted_key(self: &EncryptionHistory, version: u64): &vector<u8> {
    assert!(version < self.encrypted_keys.length(), EKeyVersionNotFound);
    self.encrypted_keys.borrow(version)
}

/// Returns the encrypted DEK for the current (latest) version.
///
/// # Parameters
/// - `self`: Reference to the EncryptionHistory
///
/// # Returns
/// Reference to the current encrypted DEK bytes.
public fun current_encrypted_key(self: &EncryptionHistory): &vector<u8> {
    self.encrypted_key(self.current_key_version())
}

// === Unit Tests ===

#[test, expected_failure(abort_code = EEncryptionHistoryAlreadyExists)]
fun new_duplicate_derivation_key_fails() {
    let mut ctx = tx_context::dummy();
    let mut namespace_uid = object::new(&mut ctx);
    let uuid = b"550e8400-e29b-41d4-a716-446655440000".to_string();

    // Create first EncryptionHistory with UUID
    let _eh1 = new(
        &mut namespace_uid,
        uuid,
        object::id_from_address(@0x1),
        b"dek1",
        &mut ctx,
    );

    // Try to create second with same UUID - should fail
    let _eh2 = new(
        &mut namespace_uid,
        uuid,
        object::id_from_address(@0x2),
        b"dek2",
        &mut ctx,
    );

    abort
}
