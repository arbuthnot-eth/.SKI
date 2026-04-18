// Tests for scripts/check-move-targets.ts internals.
//
// We re-implement the regex surface inline (matching the script 1:1) so
// we can unit-test detection without spawning a subprocess / hitting the
// network. If you touch the regexes in the script, mirror the changes
// here.

import { describe, test, expect } from 'bun:test';

const PKG_CONST_DECL =
  /export\s+const\s+([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=\s*['"`](0x[0-9a-fA-F]+)['"`]/g;
const TEMPLATE_CALL =
  /\$\{\s*([A-Z_][A-Z0-9_]*)\s*\}::([a-z_][a-z0-9_]*)::([a-z_][a-z0-9_]*)/g;
const CONCAT_CALL =
  /\b([A-Z_][A-Z0-9_]*)\s*\+\s*['"`]::([a-z_][a-z0-9_]*)::([a-z_][a-z0-9_]*)/g;

function allMatches(re: RegExp, s: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m);
  return out;
}

describe('pkg const decl regex', () => {
  test('plain', () => {
    const src = `export const SUIAMI_PKG = '0x2c1dabc';`;
    const ms = allMatches(PKG_CONST_DECL, src);
    expect(ms.length).toBe(1);
    expect(ms[0]![1]).toBe('SUIAMI_PKG');
    expect(ms[0]![2]).toBe('0x2c1dabc');
  });

  test('annotated with union type', () => {
    const src = `export const SUIAMI_STEALTH_PKG: string | null = '0xf491beef';`;
    const ms = allMatches(PKG_CONST_DECL, src);
    expect(ms.length).toBe(1);
    expect(ms[0]![1]).toBe('SUIAMI_STEALTH_PKG');
    expect(ms[0]![2]).toBe('0xf491beef');
  });

  test('ignores non-hex strings', () => {
    const src = `export const FOO = 'hello';`;
    expect(allMatches(PKG_CONST_DECL, src).length).toBe(0);
  });
});

describe('template call regex', () => {
  test('catches the bad Iron-Tail snippet', () => {
    // The exact class of bug: stale pkg + upgraded fn
    const src =
      "const t = { target: `${SUIAMI_PKG}::roster::append_cf_history`, args: [] };";
    const ms = allMatches(TEMPLATE_CALL, src);
    expect(ms.length).toBe(1);
    expect(ms[0]![1]).toBe('SUIAMI_PKG');
    expect(ms[0]![2]).toBe('roster');
    expect(ms[0]![3]).toBe('append_cf_history');
  });

  test('catches the fixed good snippet', () => {
    const src =
      "const t = { target: `${SUIAMI_PKG_LATEST}::roster::append_cf_history`, args: [] };";
    const ms = allMatches(TEMPLATE_CALL, src);
    expect(ms.length).toBe(1);
    expect(ms[0]![1]).toBe('SUIAMI_PKG_LATEST');
  });

  test('catches multiple in a file', () => {
    const src = [
      "`${SUIAMI_PKG_LATEST}::roster::bind_guest`",
      "`${SUIAMI_STEALTH_PKG}::roster::seal_approve_guest_stealth`",
    ].join('\n');
    const ms = allMatches(TEMPLATE_CALL, src);
    expect(ms.length).toBe(2);
    expect(ms.map((m) => m[1])).toEqual(['SUIAMI_PKG_LATEST', 'SUIAMI_STEALTH_PKG']);
  });
});

describe('concat call regex', () => {
  test('catches string-concat form', () => {
    const src = `const t = SUIAMI_PKG + '::roster::append_cf_history';`;
    const ms = allMatches(CONCAT_CALL, src);
    expect(ms.length).toBe(1);
    expect(ms[0]![1]).toBe('SUIAMI_PKG');
    expect(ms[0]![2]).toBe('roster');
    expect(ms[0]![3]).toBe('append_cf_history');
  });
});
