// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// iUSD — yield-bearing stable backed by a diversified reserve of hard
/// assets, equities, energy, and dollar instruments, custodied natively
/// across Bitcoin, Ethereum, Solana, and Sui by IKA dWallet threshold
/// signatures.
///
/// TreasuryCap controls mint/burn. Held by the protocol treasury address.
/// CollateralRecord tracks on-chain what backs each unit.
/// Revenue flows in via FeePaid events from Thunder, Shade, and swaps.
module iusd::iusd;

use sui::coin::{Self, Coin, TreasuryCap, CoinMetadata};
use sui::url;
use sui::event;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotAuthorized: u64 = 0;
const EInsufficientCollateral: u64 = 1;
const EZeroAmount: u64 = 2;

// ─── Events ─────────────────────────────────────────────────────────

/// Emitted on every mint — audit trail.
public struct Minted has copy, drop {
    amount: u64,
    recipient: address,
    collateral_type: vector<u8>,
}

/// Emitted on every burn — audit trail.
public struct Burned has copy, drop {
    amount: u64,
    burner: address,
}

/// Emitted when revenue flows into the treasury.
public struct RevenueReceived has copy, drop {
    source: vector<u8>,
    amount: u64,
}

// ─── One-Time Witness ───────────────────────────────────────────────

/// OTW for coin creation. Name must match module name in uppercase.
public struct IUSD has drop {}

// ─── Types ──────────────────────────────────────────────────────────

/// Per-asset collateral record. Stored as dynamic fields on Treasury.
/// Key = collateral_type string (e.g. "XAUM", "TSLAx", "BUIDL").
public struct CollateralRecord has store, drop {
    /// Asset identifier (human-readable)
    asset: vector<u8>,
    /// Chain where the asset is custodied
    chain: vector<u8>,
    /// IKA dWallet ID controlling the asset (or 0x0 for Sui-native)
    dwallet_id: address,
    /// Current value in MIST-equivalent (updated by oracle)
    value_mist: u64,
    /// Tranche: 0 = senior, 1 = junior
    tranche: u8,
    /// Last oracle update timestamp
    updated_ms: u64,
}

/// Protocol treasury — holds revenue balance and collateral manifest.
public struct Treasury has key {
    id: UID,
    /// Revenue balance (SUI) from protocol fees
    revenue: sui::balance::Balance<sui::sui::SUI>,
    /// Total iUSD ever minted (for NAV calculation)
    total_minted: u64,
    /// Total iUSD ever burned
    total_burned: u64,
    /// Authorized minter address (multisig or keeper)
    minter: address,
    /// Authorized oracle updater
    oracle: address,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(witness: IUSD, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        witness,
        6, // decimals — matches USDC
        b"iUSD",
        b"iUSD",
        b"Yield-bearing stable backed by gold, silver, equities, energy, and dollar instruments across Bitcoin, Ethereum, Solana, and Sui.",
        option::some(url::new_unsafe_from_bytes(
            b"https://sui.ski/assets/iusd.svg"
        )),
        ctx,
    );

    // Create treasury, sender is initial minter + oracle
    let treasury = Treasury {
        id: object::new(ctx),
        revenue: sui::balance::zero(),
        total_minted: 0,
        total_burned: 0,
        minter: ctx.sender(),
        oracle: ctx.sender(),
    };

    // Share treasury, transfer TreasuryCap to sender (will be moved to multisig)
    transfer::share_object(treasury);
    transfer::public_transfer(treasury_cap, ctx.sender());
    transfer::public_freeze_object(metadata);
}

// ─── Mint (authorized) ──────────────────────────────────────────────

/// Mint iUSD — only callable by the authorized minter.
/// Collateral must be recorded before minting.
public fun mint(
    treasury_cap: &mut TreasuryCap<IUSD>,
    treasury: &mut Treasury,
    amount: u64,
    recipient: address,
    collateral_type: vector<u8>,
    ctx: &mut TxContext,
): Coin<IUSD> {
    assert!(ctx.sender() == treasury.minter, ENotAuthorized);
    assert!(amount > 0, EZeroAmount);

    treasury.total_minted = treasury.total_minted + amount;

    event::emit(Minted { amount, recipient, collateral_type });

    coin::mint(treasury_cap, amount, ctx)
}

/// Mint and transfer in one call.
entry fun mint_and_transfer(
    treasury_cap: &mut TreasuryCap<IUSD>,
    treasury: &mut Treasury,
    amount: u64,
    recipient: address,
    collateral_type: vector<u8>,
    ctx: &mut TxContext,
) {
    let coin = mint(treasury_cap, treasury, amount, recipient, collateral_type, ctx);
    transfer::public_transfer(coin, recipient);
}

// ─── Burn ───────────────────────────────────────────────────────────

/// Burn iUSD — anyone can burn their own.
entry fun burn(
    treasury_cap: &mut TreasuryCap<IUSD>,
    treasury: &mut Treasury,
    coin: Coin<IUSD>,
    ctx: &TxContext,
) {
    let amount = coin.value();
    assert!(amount > 0, EZeroAmount);

    treasury.total_burned = treasury.total_burned + amount;

    event::emit(Burned { amount, burner: ctx.sender() });

    coin::burn(treasury_cap, coin);
}

// ─── Revenue ────────────────────────────────────────────────────────

/// Deposit protocol revenue (SUI) into treasury. Permissionless —
/// Thunder, Shade, swap fees all call this.
entry fun deposit_revenue(
    treasury: &mut Treasury,
    payment: Coin<sui::sui::SUI>,
    source: vector<u8>,
    _ctx: &TxContext,
) {
    let amount = payment.value();
    treasury.revenue.join(coin::into_balance(payment));
    event::emit(RevenueReceived { source, amount });
}

// ─── Oracle ─────────────────────────────────────────────────────────

/// Update a collateral record. Oracle-gated.
entry fun update_collateral(
    treasury: &mut Treasury,
    asset: vector<u8>,
    chain: vector<u8>,
    dwallet_id: address,
    value_mist: u64,
    tranche: u8,
    updated_ms: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == treasury.oracle, ENotAuthorized);

    let record = CollateralRecord {
        asset,
        chain,
        dwallet_id,
        value_mist,
        tranche,
        updated_ms,
    };

    // Upsert: remove old if exists, add new
    if (sui::dynamic_field::exists_(&treasury.id, asset)) {
        sui::dynamic_field::remove<vector<u8>, CollateralRecord>(&mut treasury.id, asset);
    };
    sui::dynamic_field::add(&mut treasury.id, asset, record);
}

// ─── Admin ──────────────────────────────────────────────────────────

/// Transfer minter authority. Current minter only.
entry fun set_minter(
    treasury: &mut Treasury,
    new_minter: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == treasury.minter, ENotAuthorized);
    treasury.minter = new_minter;
}

/// Transfer oracle authority. Current oracle only.
entry fun set_oracle(
    treasury: &mut Treasury,
    new_oracle: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == treasury.oracle, ENotAuthorized);
    treasury.oracle = new_oracle;
}

// ─── Queries ────────────────────────────────────────────────────────

/// Total iUSD in circulation (minted - burned).
public fun supply(treasury: &Treasury): u64 {
    treasury.total_minted - treasury.total_burned
}

/// Revenue balance held in treasury.
public fun revenue_balance(treasury: &Treasury): u64 {
    treasury.revenue.value()
}
