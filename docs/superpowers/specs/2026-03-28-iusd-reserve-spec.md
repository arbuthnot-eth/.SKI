# iUSD Reserve Specification

## What iUSD Is

A yield-bearing stable backed by a diversified reserve of hard assets, equities, energy, and dollar instruments — custodied natively across Bitcoin, Ethereum, Solana, and Sui by IKA dWallet threshold signatures. No bridges. No algorithms. Just reserves.

## Reserve Composition

### Senior Tranche (60%) — Peg Floor
Absorbs losses LAST. Redeemable 1:1 for dollar value. GENIUS Act aligned.

| Asset | Chain | Custody | Yield Source | Target % |
|-------|-------|---------|-------------|----------|
| USDC | Sui + Solana | Native | Kamino/NAVI lending (4-5%) | 20% |
| BUIDL (BlackRock T-bills) | Ethereum | IKA secp256k1 | T-bill yield (4.5%) | 20% |
| VBILL (VanEck T-bills) | Solana | IKA ed25519 | T-bill yield (4.5%) | 5% |
| Staked SUI | Sui | Native | PoS validation (3.5%) | 8% |
| Staked SOL | Solana | IKA ed25519 | PoS validation (7%) | 7% |

### Junior Tranche (40%) — Growth Engine
Absorbs losses FIRST. Earns higher yield. Protects the peg.

| Asset | Chain | Custody | Yield Source | Target % |
|-------|-------|---------|-------------|----------|
| XAUM (gold) | Sui | Native | Commodity appreciation (8-15%) | 8% |
| PAXG (gold) | Ethereum | IKA secp256k1 | Commodity appreciation, NYDFS regulated | 4% |
| XAGM (silver) | Ethereum | IKA secp256k1 | Commodity appreciation (8-15%) | 4% |
| TSLAx (Tesla) | Solana | IKA ed25519 | Equity appreciation (20-40%) | 5% |
| NVDAx (Nvidia) | Solana | IKA ed25519 | Equity appreciation (20-40%) | 5% |
| SPYx (S&P 500) | Solana | IKA ed25519 | Index appreciation (10-15%) | 4% |
| BTC | Bitcoin | IKA secp256k1 | Pristine collateral, appreciation | 6% |
| WTI Crude (perp) | Hyperliquid | IKA secp256k1 | Energy exposure, contango carry | 2% |
| LITRO (crude oil) | Arbitrum | IKA secp256k1 | Physical-backed crude (2027) | 2% |

## Loss Waterfall (InfiniFi-informed)

```
Market drawdown hits →
  1. Junior tranche absorbs first (XAUM, XAGM, TSLAx, NVDAx, SPYx, BTC, oil)
  2. Senior tranche absorbs second (staked SUI/SOL, T-bills)
  3. iUSD holder absorbs last (USDC reserve)

iUSD peg holds as long as senior tranche ≥ 100% of iUSD supply.
Junior can drop 100% before senior is touched.
```

## Revenue Streams Into Treasury

| Source | Mechanism | Year 1 Est. | Year 3 Est. |
|--------|-----------|-------------|-------------|
| Moonshot grant | Sui DeFi Moonshots program | $500k | — |
| SuiNS registration 5% cut | PTB fee extraction on every mint via SKI | $135k | $500k |
| Shade order 10% escrow | Fee on execute() | $50k | $400k |
| Shade prediction markets 3% | Settlement fee on counter-bets | $25k | $300k |
| Thunder Storm protocol fees | $0.009 iUSD per signal() | $328k | $3.2M |
| Swap spread | 0.1% on DeepBook/Cetus routing | $50k | $500k |
| Treasury asset appreciation | Blended 15-25% on growing AUM | $150k | $2.5M |
| Lending yield | NAVI + Scallop + Kamino | $50k | $800k |
| **Total** | | **$1.29M** | **$8.7M** |

## Lending Strategy

### Solana — Kamino Finance ($3.5B TVL)
- First major DeFi lender accepting tokenized stocks as collateral
- Deposit TSLAx/NVDAx → borrow USDC → back iUSD senior tranche
- Deposit staked SOL (jitoSOL/mSOL) → borrow against it
- Future: list iUSD as supply asset on Kamino via BuildKit
- xStocks collateral = equities earning lending yield while appreciating

### Sui — NAVI Protocol ($252M TVL)
- Largest lending protocol on Sui
- 35 pools, USDC supply APY ~4.47%, flash loans 0% fee
- Governance listing process: forum post → NAVX vote → integration
- Needs: Pyth oracle for iUSD, security audit, $500K+ liquidity
- Target: Month 3-5 for listing

### Sui — Scallop (~$130-580M TVL)
- veSCA governance model, sCoins composability
- Target: Month 6 after NAVI track record established
- Requires demonstrated liquidity depth first

### Ethereum — Aave v4 (future)
- Pulling back from multi-chain, focusing on Ethereum mainnet
- Not coming to Solana or Sui near-term
- IKA secp256k1 dWallet can interact on Ethereum if opportunity arises
- Not in near-term plan

## IKA dWallet Custody Architecture

```
secp256k1 dWallet (one key, three chains):
  ├── Bitcoin:    BTC held natively
  ├── Ethereum:   BUIDL, PAXG, XAGM, LITRO (2027)
  ├── Arbitrum:   LITRO crude oil tokens
  └── Hyperliquid: WTI crude perp position

ed25519 dWallet (Solana native):
  ├── TSLAx, NVDAx, SPYx (Backed Finance xStocks)
  ├── Staked SOL (via Marinade/Jito)
  ├── VBILL (VanEck T-bills)
  ├── USDC (Solana-native)
  └── Kamino lending positions

Sui native (no dWallet needed):
  ├── XAUM (Matrixdock gold)
  ├── Staked SUI
  ├── USDC (Circle native, CCTP v2 June 2026)
  ├── NAVI/Scallop lending positions
  └── iUSD TreasuryCap
```

## Yield Projections

### Blended Reserve Yield
| Component | Weight | Yield | Contribution |
|-----------|--------|-------|-------------|
| USDC lending (Kamino/NAVI) | 20% | 4.5% | 0.90% |
| T-bills (BUIDL + VBILL) | 25% | 4.5% | 1.13% |
| Staked SUI | 8% | 3.5% | 0.28% |
| Staked SOL | 7% | 7.0% | 0.49% |
| Gold (XAUM + PAXG) | 12% | 10% | 1.20% |
| Silver (XAGM) | 4% | 12% | 0.48% |
| Equities (TSLAx + NVDAx + SPYx) | 14% | 25% | 3.50% |
| BTC | 6% | 15% | 0.90% |
| Oil (perps + LITRO) | 4% | 10% | 0.40% |
| **Blended** | **100%** | | **9.28%** |

Plus protocol revenue (Thunder fees, registration cuts, Shade fees) adds 1-3% on top.

**Target iUSD holder yield: 8-12% APY** — competitive with USDe, backed by real assets instead of funding rates.

## Superteam Distribution

37 country subnames on superteam.sui. iUSD activity rewards distributed by country Thunder Storm volume:

- Countries with highest unique Thunder signals earn largest iUSD allocation
- Rewards backed by real protocol revenue (not inflationary)
- Argentina (ar.superteam.sui) pilots first — Buenos Aires hackathon launch
- Expansion: El Salvador, Venezuela, Colombia, Chile, Uruguay, Cuba, Panama, Greenland, Iran

## Compliance

- **GENIUS Act**: Senior tranche (USDC + T-bills = 45%) meets HQLA requirements. Junior tranche disclosed as yield collateral, not reserve.
- **MiCA**: Optional auditor viewing key for regulated entities. Not a CASP — protocol infrastructure.
- **Tranching disclosure**: Loss waterfall transparent on-chain. Junior holders explicitly opt into higher risk/reward.

## Solana P-Tokens Note

When SIMD-0266 activates, all SPL token operations (TSLAx, NVDAx, SOL, USDC on Solana) get 95% compute unit reduction. Treasury operations on Solana become dramatically cheaper — more frequent rebalancing, tighter lending management, lower gas overhead on Kamino interactions.

## Implementation Priority

1. Thunder protocol fee (0.001 SUI) — revenue primitive
2. Shade 10% treasury cut — revenue primitive
3. iUSD Move module (TreasuryCap, CollateralRecord, tranching, mint/burn)
4. Pyth oracle for iUSD NAV
5. Kamino research + Solana xStocks custody via IKA ed25519
6. NAVI governance proposal + audit
7. Shade prediction markets (counter-bets)
8. Superteam subnames + country Thunder rewards
