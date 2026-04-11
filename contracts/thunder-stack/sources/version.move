module sui_stack_messaging::version;

use sui::package;

const EInvalidVersion: u64 = 0;
// const EInvalidPublisher: u64 = 1;

// === Constants ===

/// Current version of the package, starting from version 1
const PACKAGE_VERSION: u64 = 1;

// === Witnesses ===

public struct VERSION() has drop;

// === Structs ===

/// Shared object that keeps track of the package version
public struct Version has key {
    id: UID,
    version: u64,
}

// === Initialization ===
fun init(otw: VERSION, ctx: &mut TxContext) {
    package::claim_and_keep(otw, ctx);
    transfer::share_object(Version {
        id: object::new(ctx),
        version: PACKAGE_VERSION,
    });
}

// === Public functions ===

public fun version(self: &Version): u64 {
    self.version
}

public fun package_version(): u64 {
    PACKAGE_VERSION
}

// === Package functions ===
public(package) fun validate_version(self: &Version) {
    assert!(self.version == PACKAGE_VERSION, EInvalidVersion);
}

// === Test Helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(VERSION(), ctx);
}

// Will need to enable this when we decide to make a contract upgrade
// entry fun migrate(publisher: &Publisher, version: &mut Version) {
//     assert!(package::from_package<Version>(publisher), EInvalidPublisher);
//     assert!(version.version < PACKAGE_VERSION, EInvalidVersion);
//     version.version = PACKAGE_VERSION;
// }
