import { describe, test, expect } from 'bun:test';

import {
  CHAIN_TAG,
  IUSD_COIN_TYPE,
  SUI_COIN_TYPE,
  SUI_ULTRON_ADDRESS,
  USDC_COIN_TYPE,
  WAL_COIN_TYPE,
  chainTagName,
  decodeSubcentIntent,
  extractInboundToUltron,
  lookupRecipientByIntent,
} from './sui-inbound.js';

// ─── decodeSubcentIntent ──────────────────────────────────────────────

describe('decodeSubcentIntent', () => {
  test('zero tail → hasIntent: false', () => {
    // 10 USDC exactly — no intent.
    const d = decodeSubcentIntent(10_000_000n, USDC_COIN_TYPE);
    expect(d.hasIntent).toBe(false);
    expect(d.intentCode).toBe(0);
    expect(d.chainTag).toBe(0);
    expect(d.recipientIndex).toBe(0);
    expect(d.baseAmount).toBe(10_000_000n);
  });

  test('USDC chain-tag 0 (sui) + recipient 0042', () => {
    // 10.000042 USDC — tail = 00042 (chain=0, recipient=42).
    const d = decodeSubcentIntent(10_000_042n, USDC_COIN_TYPE);
    expect(d.hasIntent).toBe(true);
    expect(d.intentCode).toBe(42);
    expect(d.chainTag).toBe(CHAIN_TAG.SUI);
    expect(d.recipientIndex).toBe(42);
    expect(d.baseAmount).toBe(10_000_000n);
  });

  test('USDC chain-tag 1 (eth) + recipient 0007, intentCode 10007', () => {
    // 5.010007 USDC — tail = 10007 (chain=1, recipient=7).
    const d = decodeSubcentIntent(5_010_007n, USDC_COIN_TYPE);
    expect(d.intentCode).toBe(10_007);
    expect(d.chainTag).toBe(CHAIN_TAG.ETH);
    expect(d.recipientIndex).toBe(7);
    expect(d.baseAmount).toBe(5_000_000n);
    expect(d.hasIntent).toBe(true);
  });

  test('WAL (9 decimals) sub-cent tail handled correctly', () => {
    // 2.000020042 WAL = 2_000_020_042 base units. Tail = 20042
    // (chain=2 sol, recipient=0042).
    const raw = 2_000_020_042n;
    const d = decodeSubcentIntent(raw, WAL_COIN_TYPE);
    expect(d.intentCode).toBe(20_042);
    expect(d.chainTag).toBe(CHAIN_TAG.SOL);
    expect(d.recipientIndex).toBe(42);
    expect(d.baseAmount).toBe(2_000_000_000n);
    expect(d.hasIntent).toBe(true);
  });

  test('iUSD (9 decimals) max recipient 9999 with chain=3 btc', () => {
    // tail = 39999 (chain=3, recipient=9999)
    const raw = 1_000_039_999n;
    const d = decodeSubcentIntent(raw, IUSD_COIN_TYPE);
    expect(d.intentCode).toBe(39_999);
    expect(d.chainTag).toBe(CHAIN_TAG.BTC);
    expect(d.recipientIndex).toBe(9999);
    expect(d.baseAmount).toBe(1_000_000_000n);
  });

  test('SUI (9 decimals) zero tail → no intent', () => {
    const d = decodeSubcentIntent(5_000_000_000n, SUI_COIN_TYPE);
    expect(d.hasIntent).toBe(false);
    expect(d.intentCode).toBe(0);
  });
});

// ─── extractInboundToUltron ───────────────────────────────────────────

const MK_TX = (
  digest: string,
  changes: Array<{ owner: unknown; coinType: string; amount: string | number }>,
  sender = '0xsender',
) => ({
  digest,
  timestampMs: 1_700_000_000_000,
  sender,
  balanceChanges: changes,
});

describe('extractInboundToUltron', () => {
  test('filters non-ultron transfers', () => {
    const cp = {
      transactions: [
        MK_TX('d1', [
          {
            owner: { AddressOwner: '0xdeadbeef' },
            coinType: SUI_COIN_TYPE,
            amount: '1000000000',
          },
        ]),
      ],
    };
    const out = extractInboundToUltron(cp);
    expect(out).toHaveLength(0);
  });

  test('includes ultron-bound SUI / WAL / USDC transfers', () => {
    const cp = {
      transactions: [
        MK_TX('dSUI', [
          {
            owner: { AddressOwner: SUI_ULTRON_ADDRESS },
            coinType: SUI_COIN_TYPE,
            amount: '2000000042',
          },
        ]),
        MK_TX('dWAL', [
          {
            owner: { AddressOwner: SUI_ULTRON_ADDRESS },
            coinType: WAL_COIN_TYPE,
            amount: '500000000',
          },
        ]),
        MK_TX('dUSDC', [
          {
            owner: { AddressOwner: SUI_ULTRON_ADDRESS },
            coinType: USDC_COIN_TYPE,
            amount: '10000042',
          },
        ]),
      ],
    };
    const out = extractInboundToUltron(cp);
    expect(out).toHaveLength(3);
    const byCoin = Object.fromEntries(out.map((a) => [a.coinType, a]));
    expect(byCoin[SUI_COIN_TYPE]!.amountMist).toBe(2_000_000_042n);
    expect(byCoin[WAL_COIN_TYPE]!.amountMist).toBe(500_000_000n);
    expect(byCoin[USDC_COIN_TYPE]!.amountMist).toBe(10_000_042n);
    expect(out.every((a) => a.toAddress.toLowerCase() === SUI_ULTRON_ADDRESS.toLowerCase())).toBe(
      true,
    );
  });

  test('skips negative balance changes (debits)', () => {
    const cp = {
      transactions: [
        MK_TX('debit', [
          {
            owner: { AddressOwner: SUI_ULTRON_ADDRESS },
            coinType: SUI_COIN_TYPE,
            amount: '-1000000000',
          },
        ]),
      ],
    };
    expect(extractInboundToUltron(cp)).toHaveLength(0);
  });

  test('handles nested checkpoint shape', () => {
    const cp = {
      checkpoint: {
        transactions: [
          MK_TX('nest', [
            {
              owner: { AddressOwner: SUI_ULTRON_ADDRESS },
              coinType: USDC_COIN_TYPE,
              amount: '10000000',
            },
          ]),
        ],
      },
    };
    const out = extractInboundToUltron(cp);
    expect(out).toHaveLength(1);
    expect(out[0]!.digest).toBe('nest');
  });

  test('gracefully returns [] on junk input', () => {
    expect(extractInboundToUltron(null)).toEqual([]);
    expect(extractInboundToUltron({})).toEqual([]);
    expect(extractInboundToUltron({ transactions: 'no' })).toEqual([]);
  });
});

// ─── lookupRecipientByIntent ──────────────────────────────────────────

describe('lookupRecipientByIntent', () => {
  test('returns null when no intent code', async () => {
    const r = await lookupRecipientByIntent(0, 'sui');
    expect(r).toBeNull();
  });

  test('returns null when rosterLookup not provided', async () => {
    const r = await lookupRecipientByIntent(42, 'sui');
    expect(r).toBeNull();
  });

  test('delegates to rosterLookup with recipientIndex', async () => {
    const calls: Array<{ idx: number; chain: string }> = [];
    const fakeRoster = async (idx: number, chain: string) => {
      calls.push({ idx, chain });
      return 'brando.sui';
    };
    // intentCode 10042 — chain bucket 1, recipient 42.
    const r = await lookupRecipientByIntent(10_042, 'eth', fakeRoster);
    expect(r).toBe('brando.sui');
    expect(calls).toEqual([{ idx: 42, chain: 'eth' }]);
  });

  test('returns null when recipient index is 0', async () => {
    // 20000 → chain 2, recipient 0 → no actual recipient.
    const r = await lookupRecipientByIntent(20_000, 'sol', async () => 'nope');
    expect(r).toBeNull();
  });
});

describe('chainTagName', () => {
  test('maps known tags', () => {
    expect(chainTagName(CHAIN_TAG.SUI)).toBe('sui');
    expect(chainTagName(CHAIN_TAG.ETH)).toBe('eth');
    expect(chainTagName(CHAIN_TAG.SOL)).toBe('sol');
    expect(chainTagName(CHAIN_TAG.BTC)).toBe('btc');
    expect(chainTagName(9)).toBe('unknown');
  });
});
