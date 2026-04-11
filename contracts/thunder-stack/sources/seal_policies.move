/// Module: seal_policies
///
/// Default `seal_approve` functions for Seal encryption access control.
/// Called by Seal key servers (via dry-run) to authorize decryption.
///
/// ## Identity Bytes Format
///
/// Identity bytes: `[group_id (32 bytes)][key_version (8 bytes LE u64)]`
/// Total: 40 bytes
///
/// - `group_id`: The PermissionedGroup<Messaging> object ID
/// - `key_version`: The encryption key version (supports key rotation)
///
/// ## Custom Policies
///
/// Apps can implement custom `seal_approve` with different logic:
/// - Subscription-based, time-limited, NFT-gated access, etc.
/// - Must be in the same package used during `seal.encrypt`.
///
module sui_stack_messaging::seal_policies;

use sui_groups::permissioned_group::PermissionedGroup;
use sui_stack_messaging::messaging::{MessagingReader, Messaging};
use sui_stack_messaging::encryption_history::EncryptionHistory;
use sui_stack_messaging::version::Version;
use sui::bcs;

// === Error Codes ===

/// Identity bytes are malformed (wrong length or mismatched group ID).
const EInvalidIdentity: u64 = 0;
/// Caller lacks the required `MessagingReader` permission.
const ENotPermitted: u64 = 1;
/// Requested key version does not exist in the encryption history.
const EInvalidKeyVersion: u64 = 2;
/// The provided `EncryptionHistory` does not belong to the given group.
const EEncryptionHistoryMismatch: u64 = 3;

// === Constants ===

/// Expected identity bytes length: 32 (group_id) + 8 (key_version) = 40 bytes
const IDENTITY_BYTES_LENGTH: u64 = 40;

// === Public Functions ===

/// Validates identity bytes format and extracts components.
///
/// Expected format: `[group_id (32 bytes)][key_version (8 bytes LE u64)]`
///
/// Custom `seal_approve` functions in external packages should call this
/// to reuse the standard identity validation logic instead of duplicating it.
///
/// # Parameters
/// - `group`: Reference to the PermissionedGroup<Messaging>
/// - `encryption_history`: Reference to the EncryptionHistory
/// - `id`: The Seal identity bytes to validate
///
/// # Aborts
/// - `EEncryptionHistoryMismatch`: if encryption_history doesn't belong to this group
/// - `EInvalidIdentity`: if length != 40 or group_id doesn't match
/// - `EInvalidKeyVersion`: if key_version > current_key_version
public fun validate_identity(
    group: &PermissionedGroup<Messaging>,
    encryption_history: &EncryptionHistory,
    id: vector<u8>,
) {
    // Verify encryption_history belongs to this group
    assert!(encryption_history.group_id() == object::id(group), EEncryptionHistoryMismatch);

    // Must be exactly 40 bytes: 32 (group_id) + 8 (key_version)
    assert!(id.length() == IDENTITY_BYTES_LENGTH, EInvalidIdentity);

    // Use BCS to parse the identity bytes
    let mut bcs_bytes = bcs::new(id);

    // Parse group_id (32 bytes as address)
    let parsed_group_id = bcs_bytes.peel_address();

    // Verify group_id matches
    assert!(object::id_to_address(&object::id(group)) == parsed_group_id, EInvalidIdentity);

    // Parse key_version (u64, little-endian)
    let key_version = bcs_bytes.peel_u64();

    // Key version must exist (be <= current version)
    assert!(key_version <= encryption_history.current_key_version(), EInvalidKeyVersion);
}

// === Entry Functions ===

/// Default seal_approve that checks `MessagingReader` permission.
///
/// # Parameters
/// - `id`: Seal identity bytes `[group_id (32 bytes)][key_version (8 bytes LE u64)]`
/// - `group`: Reference to the PermissionedGroup<Messaging>
/// - `encryption_history`: Reference to the EncryptionHistory
/// - `ctx`: Transaction context
///
/// # Aborts
/// - `EEncryptionHistoryMismatch`: if encryption_history doesn't belong to this group
/// - `EInvalidIdentity`: if identity bytes are malformed or group_id doesn't match
/// - `EInvalidKeyVersion`: if key_version doesn't exist
/// - `ENotPermitted`: if caller doesn't have `MessagingReader` permission
entry fun seal_approve_reader(
    id: vector<u8>,
    version: &Version,
    group: &PermissionedGroup<Messaging>,
    encryption_history: &EncryptionHistory,
    ctx: &TxContext,
) {
    version.validate_version();
    validate_identity(group, encryption_history, id);
    assert!(group.has_permission<Messaging, MessagingReader>(ctx.sender()), ENotPermitted);
}
