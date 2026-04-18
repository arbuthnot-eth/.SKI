// Beldum Double Hit (#167) — personal-mode stealth resolution tests.
//
// Covers the pure `resolveSuiAddr` helper + `identityMode` predicate.
// The full `handleEnsCcipRead` wire path depends on a Hono Context +
// upstream Sui/Walrus fetches — tested separately via smoke curl. Here
// we focus on the crypto seam: service vs personal, freshness, and
// that stealth outputs are well-formed 32-byte Sui addresses.

import { describe, test, expect, afterEach } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  identityMode,
  resolveSuiAddr,
  setEphemeralKeySource,
} from './ens-resolver.js';
// Inline the meta-address builder — client-side file transitively
// imports @noble/curves via a bundler-only path that bun:test can't
// resolve, and we only need the serialization format here.
function buildSka(ikaDwalletId: string, viewPubkeysByChain: Record<string, string>): string {
  const entries = Object.entries(viewPubkeysByChain)
    .map(([chain, pk]) => `${chain}=${pk.startsWith('0x') ? pk : '0x' + pk}`)
    .join('|');
  return `ska:${ikaDwalletId}:${entries}`;
}

// Fixture identities — hermes (service mode), athena (personal mode
// with ska), apollo (personal mode, different view key). No real
// SuiNS names; these are pure test scaffolds.

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// Deterministic viewPub derived from a fixed seed so snapshot math is
// reproducible even across @noble upgrades.
const ATHENA_VIEW_SEED = new Uint8Array(32).fill(0x42);
const ATHENA_VIEW_PUB = ed25519.getPublicKey(ATHENA_VIEW_SEED);
const ATHENA_SKA = buildSka('0x' + '11'.repeat(32), { sui: '0x' + bytesToHex(ATHENA_VIEW_PUB) });

const hermesRecord = {
  name: 'hermes',
  sui_address: '0x' + 'aa'.repeat(32),
  chains: {},
  dwallet_caps: [],
};

const athenaRecord = {
  name: 'athena',
  sui_address: '0x' + 'bb'.repeat(32),
  chains: { ska: ATHENA_SKA },
  dwallet_caps: [],
};

const apolloRecord = {
  name: 'apollo',
  sui_address: '0x' + 'cc'.repeat(32),
  chains: { ska: 'ska:malformed-not-a-meta' },
  dwallet_caps: [],
};

// Counter-based deterministic ephemeral source for freshness tests.
function makeCountingSource() {
  let n = 0;
  return {
    freshEd25519Seed(): Uint8Array {
      n++;
      const seed = new Uint8Array(32);
      seed[0] = n & 0xff;
      seed[1] = (n >> 8) & 0xff;
      // Fill remainder with stable noise so seeds are valid.
      for (let i = 2; i < 32; i++) seed[i] = 0xa5;
      return seed;
    },
  };
}

afterEach(() => setEphemeralKeySource(null));

// ─── identityMode ──────────────────────────────────────────────────

describe('identityMode', () => {
  test('null record → service', () => {
    expect(identityMode(null)).toBe('service');
  });
  test('no ska chain entry → service', () => {
    expect(identityMode(hermesRecord)).toBe('service');
  });
  test('valid ska entry → personal', () => {
    expect(identityMode(athenaRecord)).toBe('personal');
  });
  test('malformed ska value → service (graceful fallback)', () => {
    expect(identityMode(apolloRecord)).toBe('service');
  });
});

// ─── resolveSuiAddr ────────────────────────────────────────────────

describe('resolveSuiAddr', () => {
  test('service mode returns stable sui_address', () => {
    const r = resolveSuiAddr(hermesRecord, 'service');
    expect(r.addr).toBe(hermesRecord.sui_address);
    expect(r.ephemeralPubHex).toBeUndefined();
  });

  test('personal mode forced on a record with no ska falls back to stable', () => {
    const r = resolveSuiAddr(hermesRecord, 'personal');
    expect(r.addr).toBe(hermesRecord.sui_address);
    expect(r.ephemeralPubHex).toBeUndefined();
  });

  test('personal mode on athena returns a stealth addr (not stable) with ephemeralPub', () => {
    setEphemeralKeySource(makeCountingSource());
    const r = resolveSuiAddr(athenaRecord, 'personal');
    expect(r.addr).not.toBe(athenaRecord.sui_address);
    expect(r.addr).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.ephemeralPubHex).toBeDefined();
    expect(r.ephemeralPubHex!.length).toBe(64); // 32 bytes hex
  });

  test('two consecutive personal-mode queries return DIFFERENT stealth addrs (freshness)', () => {
    setEphemeralKeySource(makeCountingSource());
    const a = resolveSuiAddr(athenaRecord, 'personal');
    const b = resolveSuiAddr(athenaRecord, 'personal');
    expect(a.addr).not.toBe(b.addr);
    expect(a.ephemeralPubHex).not.toBe(b.ephemeralPubHex);
  });

  test('stealth addr is a well-formed 32-byte Sui address (blake2b output)', () => {
    setEphemeralKeySource(makeCountingSource());
    const r = resolveSuiAddr(athenaRecord, 'personal');
    expect(r.addr).toMatch(/^0x[0-9a-f]{64}$/);
    const raw = hexToBytes(r.addr!);
    expect(raw.length).toBe(32);
  });

  test('same ephemeral seed + same record ⇒ same stealth addr (determinism seam)', () => {
    let calls = 0;
    const fixedSeed = new Uint8Array(32).fill(0x07);
    setEphemeralKeySource({
      freshEd25519Seed() {
        calls++;
        return fixedSeed;
      },
    });
    const a = resolveSuiAddr(athenaRecord, 'personal');
    const b = resolveSuiAddr(athenaRecord, 'personal');
    expect(calls).toBe(2);
    expect(a.addr).toBe(b.addr);
    expect(a.ephemeralPubHex).toBe(b.ephemeralPubHex);
  });

  test('malformed ska payload ⇒ graceful fallback to stable', () => {
    const r = resolveSuiAddr(apolloRecord, 'personal');
    expect(r.addr).toBe(apolloRecord.sui_address);
    expect(r.ephemeralPubHex).toBeUndefined();
  });
});
