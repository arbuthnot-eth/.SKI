/**
 * SuiAMI — SUI-Authenticated Message Identity
 *
 * Cryptographic proof that a wallet owner controls a SuiNS name.
 * The proof is a signed personal message bundled into a shareable token.
 */

export interface SuiamiMessage {
  suiami: string;
  datetime: string;
  network: 'sui';
  address: string;
  /** Cross-chain addresses derived from IKA dWallets */
  btc?: string;
  sol?: string;
  eth?: string;
  ski: string;
  nftId: string;
  timestamp: number;
  version: 2;
}

export interface SuiamiProof {
  token: string;
  message: SuiamiMessage;
  bytes: string;
  signature: string;
}

/** Build a SuiAMI message ready for signing. Includes all cross-chain addresses. */
export function buildSuiamiMessage(name: string, address: string, nftId: string, crossChain?: { btc?: string; sol?: string; eth?: string }): SuiamiMessage {
  const now = Date.now();
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: 'numeric', month: 'numeric', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  const art = `${p('hour')}:${p('minute')} ${p('day')}/${parseInt(p('month'), 10)}/${p('year')}`;
  return {
    suiami: `I am ${name}`,
    datetime: art,
    network: 'sui',
    address,
    ...(crossChain?.btc ? { btc: crossChain.btc } : {}),
    ...(crossChain?.sol ? { sol: crossChain.sol } : {}),
    ...(crossChain?.eth ? { eth: crossChain.eth } : {}),
    ski: `${name}.sui.ski`,
    nftId,
    timestamp: now,
    version: 2,
  };
}

/** Bundle a signed message into a shareable proof token. */
export function createSuiamiProof(message: SuiamiMessage, bytes: string, signature: string): SuiamiProof {
  const msgB64 = btoa(JSON.stringify(message));
  const token = `suiami:${msgB64}.${signature}`;
  return { token, message, bytes, signature };
}

/** Parse a proof token back into its components. */
export function parseSuiamiProof(token: string): { message: SuiamiMessage; signature: string } | null {
  if (!token.startsWith('suiami:')) return null;
  const body = token.slice(7);
  const dotIdx = body.lastIndexOf('.');
  if (dotIdx < 0) return null;
  try {
    const msgB64 = body.slice(0, dotIdx);
    const signature = body.slice(dotIdx + 1);
    const message = JSON.parse(atob(msgB64)) as SuiamiMessage;
    if (!message.suiami) return null;
    return { message, signature };
  } catch {
    return null;
  }
}
