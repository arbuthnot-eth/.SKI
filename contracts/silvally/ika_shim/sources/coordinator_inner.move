// IKA shim — coordinator_inner module.
// Mirrors the public structs exposed by the real IKA mainnet package at
// 0xdd24c627... Pulled from @ika.xyz/sdk@0.3.1 generated BCS definitions
// to match exact field order and types.

module ika_dwallet_2pc_mpc::coordinator_inner;

/// The capability that authorizes signing for a specific dWallet.
/// Held by whoever controls the dWallet's signing rights. For Silvally,
/// it lives inside a `SubnamePolicy` shared object.
///
/// Field layout MUST match the real package:
///   id: UID
///   dwallet_id: ID of the controlled dWallet
public struct DWalletCap has key, store {
    id: UID,
    dwallet_id: ID,
}

/// Imported-key variant — same layout, separate type.
public struct ImportedKeyDWalletCap has key, store {
    id: UID,
    dwallet_id: ID,
}
