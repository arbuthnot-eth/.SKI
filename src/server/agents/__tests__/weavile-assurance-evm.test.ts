/**
 * Weavile Assurance — EVM UserOperation helper tests (Move 2).
 *
 * Offline: global.fetch is stubbed per-test. Covers:
 *   - buildUserOp shape + defaults
 *   - computePaymasterDataHash determinism + field sensitivity
 *   - encodePaymasterAndData byte-length layout
 *   - estimateUserOpGas happy path + bundler error
 *   - submitUserOp happy path + bundler error + non-JSON response
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  buildUserOp,
  estimateUserOpGas,
  computePaymasterDataHash,
  encodePaymasterAndData,
  submitUserOp,
  type UserOperation,
} from '../weavile-assurance-evm';

// EntryPoint v0.7 on mainnet — used only as test input, never hardcoded in prod.
const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;
const BUNDLER_URL = 'https://bundler.test.example/rpc';

// Stealth placeholders: hermes + athena (never amazon/venmo).
const HERMES = '0x1111111111111111111111111111111111111111' as const;
const ATHENA = '0x2222222222222222222222222222222222222222' as const;
const PAYMASTER = '0x3333333333333333333333333333333333333333' as const;

// ─── fetch stubbing helpers ─────────────────────────────────────────

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;
let realFetch: typeof fetch;

function stubFetch(fn: FetchStub) {
  // @ts-expect-error — allow reassignment for test
  globalThis.fetch = fn as unknown as typeof fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

// ─── Fixture ────────────────────────────────────────────────────────

function baseOp(): UserOperation {
  return buildUserOp({
    sender: HERMES,
    nonce: 7n,
    callData: '0xdeadbeef',
    maxFeePerGas: 30_000_000_000n, // 30 gwei
    maxPriorityFeePerGas: 2_000_000_000n,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('buildUserOp', () => {
  test('fills defaults and passes through caller args', () => {
    const op = baseOp();
    expect(op.sender).toBe(HERMES);
    expect(op.nonce).toBe(7n);
    expect(op.callData).toBe('0xdeadbeef');
    expect(op.initCode).toBe('0x');
    expect(op.paymasterAndData).toBe('0x');
    expect(op.signature).toBe('0x');
    expect(op.callGasLimit).toBe(0n);
    expect(op.verificationGasLimit).toBe(0n);
    expect(op.preVerificationGas).toBe(0n);
    expect(op.maxFeePerGas).toBe(30_000_000_000n);
    expect(op.maxPriorityFeePerGas).toBe(2_000_000_000n);
  });

  test('accepts explicit initCode', () => {
    const op = buildUserOp({
      sender: HERMES,
      nonce: 0n,
      initCode: '0xcafebabe',
      callData: '0x00',
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    });
    expect(op.initCode).toBe('0xcafebabe');
  });
});

describe('computePaymasterDataHash', () => {
  const input = {
    op: baseOp(),
    paymaster: PAYMASTER,
    validAfter: 1000n,
    validUntil: 2000n,
    chainId: 1n,
  };

  test('is deterministic for identical input', () => {
    const h1 = computePaymasterDataHash(input);
    const h2 = computePaymasterDataHash({ ...input, op: { ...input.op } });
    expect(h1).toBe(h2);
    expect(h1.length).toBe(66); // 0x + 64 hex chars
  });

  test('differs when any single field changes', () => {
    const base = computePaymasterDataHash(input);
    // mutate op.nonce
    expect(computePaymasterDataHash({ ...input, op: { ...input.op, nonce: 8n } })).not.toBe(base);
    // mutate op.sender
    expect(computePaymasterDataHash({ ...input, op: { ...input.op, sender: ATHENA } })).not.toBe(base);
    // mutate op.callData
    expect(
      computePaymasterDataHash({ ...input, op: { ...input.op, callData: '0xbeef' } }),
    ).not.toBe(base);
    // mutate paymaster
    expect(computePaymasterDataHash({ ...input, paymaster: ATHENA })).not.toBe(base);
    // mutate validAfter
    expect(computePaymasterDataHash({ ...input, validAfter: 1001n })).not.toBe(base);
    // mutate validUntil
    expect(computePaymasterDataHash({ ...input, validUntil: 2001n })).not.toBe(base);
    // mutate chainId
    expect(computePaymasterDataHash({ ...input, chainId: 137n })).not.toBe(base);
  });
});

describe('encodePaymasterAndData', () => {
  test('produces [20][65][6][6]=97 bytes with a 65-byte secp256k1 sig', () => {
    const sig = ('0x' + '11'.repeat(65)) as `0x${string}`;
    const out = encodePaymasterAndData({
      paymaster: PAYMASTER,
      paymasterSig: sig,
      validAfter: 1n,
      validUntil: 2n,
    });
    // 0x-prefix + 2 hex chars per byte = 2 + 97*2 = 196
    expect(out.length).toBe(2 + 97 * 2);
    // first 20 bytes = paymaster addr (lowercased hex)
    expect(out.slice(0, 42).toLowerCase()).toBe(PAYMASTER.toLowerCase());
  });
});

describe('estimateUserOpGas', () => {
  test('happy path returns gas-filled op', async () => {
    stubFetch(async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          callGasLimit: '0x186a0', // 100_000
          verificationGasLimit: '0x1e848', // 125_000
          preVerificationGas: '0xafc8', // 45_000
        },
      }),
    );
    const filled = await estimateUserOpGas(baseOp(), ENTRYPOINT_V07, BUNDLER_URL);
    expect(filled.callGasLimit).toBe(100_000n);
    expect(filled.verificationGasLimit).toBe(125_000n);
    expect(filled.preVerificationGas).toBe(45_000n);
    // unchanged pass-through
    expect(filled.sender).toBe(HERMES);
    expect(filled.nonce).toBe(7n);
  });

  test('bundler error throws', async () => {
    stubFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: 'AA21 didnt pay' } }),
    );
    await expect(
      estimateUserOpGas(baseOp(), ENTRYPOINT_V07, BUNDLER_URL),
    ).rejects.toThrow(/AA21 didnt pay/);
  });
});

describe('submitUserOp', () => {
  test('happy path returns 0x-prefixed userOpHash', async () => {
    const hash = '0x' + 'ab'.repeat(32);
    stubFetch(async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: hash }));
    const out = await submitUserOp(baseOp(), ENTRYPOINT_V07, BUNDLER_URL);
    expect(out).toBe(hash as `0x${string}`);
  });

  test('bundler error throws', async () => {
    stubFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: 'nonce too low' } }),
    );
    await expect(
      submitUserOp(baseOp(), ENTRYPOINT_V07, BUNDLER_URL),
    ).rejects.toThrow(/nonce too low/);
  });

  test('non-JSON response throws', async () => {
    stubFetch(async () => new Response('<html>500</html>', { status: 500 }));
    await expect(
      submitUserOp(baseOp(), ENTRYPOINT_V07, BUNDLER_URL),
    ).rejects.toThrow(/non-JSON response/);
  });
});
