// Unit tests for the suiami SDK public surface. Run with `bun test`
// from packages/suiami/.
//
// Coverage: buildMessage shape, createProof/parseProof round-trip,
// extractName, ensHash/nameHash determinism + format.

import { describe, test, expect } from 'bun:test';
import {
    buildMessage,
    createProof,
    parseProof,
    extractName,
    nameHash,
    ensHash,
} from './index.js';

describe('buildMessage', () => {
    test('includes required fields for a bare SuiNS name', () => {
        const msg = buildMessage('alice', '0xAAAA', '0xnftid');
        expect(msg.suiami).toBe('I am alice');
        expect(msg.sui).toBe('0xAAAA');
        expect(msg.nftId).toBe('0xnftid');
        expect(msg.version).toBe(2);
        expect(msg.ski).toBe('alice.sui.ski');
        expect(typeof msg.timestamp).toBe('number');
        expect(msg.chains).toContain('sui');
    });

    test('includes optional cross-chain squids when provided', () => {
        const msg = buildMessage('bob', '0xBBBB', '0xnft', {
            btc: 'bc1q0000000000000000000000000000000000000000',
            sol: 'So1111111111111111111111111111111111111111',
            eth: '0xcccccccccccccccccccccccccccccccccccccccc',
        });
        expect(msg.btc).toBeDefined();
        expect(msg.sol).toBeDefined();
        expect(msg.eth).toBeDefined();
        expect(msg.chains).toContain('btc');
        expect(msg.chains).toContain('sol');
        expect(msg.chains).toContain('eth');
    });

    test('includes balance line only when > 0', () => {
        const none = buildMessage('zero', '0x1', '0xn');
        expect(none.balance).toBeUndefined();
        const some = buildMessage('some', '0x1', '0xn', undefined, 42.5);
        expect(some.balance).toBe('$42.50');
    });

    test('permits the sentinel "nobody" name without an nftId', () => {
        const msg = buildMessage('nobody', '0x1', '');
        expect(msg.suiami).toBe('I am nobody');
    });

    test('throws if a real name is passed without an nftId', () => {
        expect(() => buildMessage('alice', '0x1', '')).toThrow(/don't own alice.sui/);
    });
});

describe('createProof / parseProof round-trip', () => {
    test('parse(create(msg)) returns equivalent message + signature', () => {
        const msg = buildMessage('alice', '0xAAAA', '0xnft');
        const proof = createProof(msg, 'bytes-placeholder', 'sig-placeholder');
        expect(proof.token.startsWith('suiami:')).toBe(true);
        const parsed = parseProof(proof.token);
        expect(parsed).not.toBeNull();
        expect(parsed!.signature).toBe('sig-placeholder');
        expect(parsed!.message.suiami).toBe('I am alice');
        expect(parsed!.message.sui).toBe('0xAAAA');
    });

    test('parseProof rejects tokens without the suiami: prefix', () => {
        expect(parseProof('notsuiami:foo.bar')).toBeNull();
    });

    test('parseProof rejects malformed bodies', () => {
        expect(parseProof('suiami:no-dot-separator')).toBeNull();
        expect(parseProof('suiami:not-base64.sig')).toBeNull();
    });
});

describe('extractName', () => {
    test('strips the "I am " prefix', () => {
        const msg = buildMessage('alice', '0x1', '0x2');
        expect(extractName(msg)).toBe('alice');
    });
});

describe('nameHash / ensHash', () => {
    test('nameHash is 32 bytes', () => {
        const h = nameHash('alice');
        expect(h).toBeInstanceOf(Uint8Array);
        expect(h.length).toBe(32);
    });

    test('nameHash strips trailing .sui and lowercases', () => {
        const a = nameHash('alice');
        const b = nameHash('ALICE.sui');
        const c = nameHash('Alice.SUI');
        expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
        expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(c).toString('hex'));
    });

    test('ensHash is 32 bytes and lowercases', () => {
        const a = ensHash('alice.waap.eth');
        const b = ensHash('ALICE.WAAP.ETH');
        expect(a.length).toBe(32);
        expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    });

    test('ensHash and nameHash produce different outputs for the same bare label', () => {
        // Different inputs (bare label vs full ENS) must hash to different bytes.
        const a = nameHash('alice');
        const b = ensHash('alice.waap.eth');
        expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
    });
});
