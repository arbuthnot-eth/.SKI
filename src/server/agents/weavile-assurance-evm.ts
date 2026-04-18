/**
 * Weavile Assurance — pure EVM UserOperation helpers (Move 2).
 *
 * Pure helpers, no DO state, no IKA calls, no private keys. All functions take
 * explicit parameters so they can be unit-tested without mocking any DO.
 *
 * Depends only on `fetch` (for bundler JSON-RPC) and viem primitives
 * (`encodeAbiParameters`, `keccak256`). Caller supplies EntryPoint addr +
 * bundler URL — nothing is hardcoded.
 *
 * See `docs/superpowers/plans/2026-04-18-weavile-assurance.md` §3.2 + §7.
 */

import { encodeAbiParameters, keccak256, concat, numberToHex } from 'viem';

// ─── Types ──────────────────────────────────────────────────────────

export interface UserOperation {
  sender: `0x${string}`;
  nonce: bigint;
  initCode: `0x${string}`;
  callData: `0x${string}`;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: `0x${string}`;
  signature: `0x${string}`;
}

// ─── Wire helpers ───────────────────────────────────────────────────

function toHexBig(v: bigint): `0x${string}` {
  return numberToHex(v);
}

/** Serialize a UserOperation for JSON-RPC (all bigints → hex strings). */
function userOpToWire(op: UserOperation): Record<string, string> {
  return {
    sender: op.sender,
    nonce: toHexBig(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    callGasLimit: toHexBig(op.callGasLimit),
    verificationGasLimit: toHexBig(op.verificationGasLimit),
    preVerificationGas: toHexBig(op.preVerificationGas),
    maxFeePerGas: toHexBig(op.maxFeePerGas),
    maxPriorityFeePerGas: toHexBig(op.maxPriorityFeePerGas),
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

function parseHexBig(v: unknown): bigint {
  if (typeof v !== 'string') throw new Error(`expected hex string, got ${typeof v}`);
  return BigInt(v);
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Build a UserOperation with placeholder gas fields + empty
 * signature/paymasterAndData. Gas fields must be filled in by
 * `estimateUserOpGas`; signature + paymasterAndData by the caller after IKA
 * signs.
 */
export function buildUserOp(args: {
  sender: `0x${string}`;
  nonce: bigint;
  initCode?: `0x${string}`;
  callData: `0x${string}`;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): UserOperation {
  return {
    sender: args.sender,
    nonce: args.nonce,
    initCode: args.initCode ?? '0x',
    callData: args.callData,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: args.maxFeePerGas,
    maxPriorityFeePerGas: args.maxPriorityFeePerGas,
    paymasterAndData: '0x',
    signature: '0x',
  };
}

/**
 * POST eth_estimateUserOperationGas to the Pimlico bundler. Returns a new
 * UserOperation with `callGasLimit`, `verificationGasLimit`, and
 * `preVerificationGas` filled in. Throws with the bundler's error on failure.
 */
export async function estimateUserOpGas(
  op: UserOperation,
  entryPoint: `0x${string}`,
  bundlerUrl: string,
): Promise<UserOperation> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_estimateUserOperationGas',
    params: [userOpToWire(op), entryPoint],
  };
  const res = await fetch(bundlerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`estimateUserOpGas: non-JSON response (${(err as Error).message})`);
  }
  const obj = json as { result?: Record<string, string>; error?: { message?: string } };
  if (!obj || obj.error || !obj.result) {
    const msg = obj?.error?.message ?? 'unknown bundler error';
    throw new Error(`estimateUserOpGas: ${msg}`);
  }
  const r = obj.result;
  return {
    ...op,
    callGasLimit: parseHexBig(r.callGasLimit),
    verificationGasLimit: parseHexBig(r.verificationGasLimit),
    preVerificationGas: parseHexBig(r.preVerificationGas),
  };
}

/**
 * Deterministic EIP-712-style digest the paymaster signer must produce over.
 * Covers the UserOp fields (minus `paymasterAndData` + `signature`), the
 * paymaster contract address, the validity window, and the chainId.
 *
 * Encoding mirrors Pimlico's reference VerifyingPaymaster hash input.
 */
export function computePaymasterDataHash(args: {
  op: UserOperation;
  paymaster: `0x${string}`;
  validAfter: bigint;
  validUntil: bigint;
  chainId: bigint;
}): `0x${string}` {
  const { op, paymaster, validAfter, validUntil, chainId } = args;
  const initCodeHash = keccak256(op.initCode);
  const callDataHash = keccak256(op.callData);
  const encoded = encodeAbiParameters(
    [
      { type: 'address' }, // sender
      { type: 'uint256' }, // nonce
      { type: 'bytes32' }, // keccak(initCode)
      { type: 'bytes32' }, // keccak(callData)
      { type: 'uint256' }, // callGasLimit
      { type: 'uint256' }, // verificationGasLimit
      { type: 'uint256' }, // preVerificationGas
      { type: 'uint256' }, // maxFeePerGas
      { type: 'uint256' }, // maxPriorityFeePerGas
      { type: 'address' }, // paymaster
      { type: 'uint48' },  // validAfter
      { type: 'uint48' },  // validUntil
      { type: 'uint256' }, // chainId
    ],
    [
      op.sender,
      op.nonce,
      initCodeHash,
      callDataHash,
      op.callGasLimit,
      op.verificationGasLimit,
      op.preVerificationGas,
      op.maxFeePerGas,
      op.maxPriorityFeePerGas,
      paymaster,
      validAfter,
      validUntil,
      chainId,
    ],
  );
  return keccak256(encoded);
}

/**
 * Encode paymasterAndData bytes as:
 *   [paymaster_addr (20)] [paymasterSig (var, typically 65)] [validAfter (6)] [validUntil (6)]
 *
 * validAfter + validUntil are uint48 (6 bytes each) to match EIP-4337's
 * validation data packing.
 */
export function encodePaymasterAndData(args: {
  paymaster: `0x${string}`;
  paymasterSig: `0x${string}`;
  validAfter: bigint;
  validUntil: bigint;
}): `0x${string}` {
  const { paymaster, paymasterSig, validAfter, validUntil } = args;
  const validAfterHex = numberToHex(validAfter, { size: 6 });
  const validUntilHex = numberToHex(validUntil, { size: 6 });
  return concat([paymaster, paymasterSig, validAfterHex, validUntilHex]);
}

/**
 * POST eth_sendUserOperation to the Pimlico bundler. Returns the userOpHash on
 * success. Throws with the bundler's error on failure.
 */
export async function submitUserOp(
  op: UserOperation,
  entryPoint: `0x${string}`,
  bundlerUrl: string,
): Promise<`0x${string}`> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_sendUserOperation',
    params: [userOpToWire(op), entryPoint],
  };
  const res = await fetch(bundlerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`submitUserOp: non-JSON response (${(err as Error).message})`);
  }
  const obj = json as { result?: string; error?: { message?: string } };
  if (!obj || obj.error || typeof obj.result !== 'string') {
    const msg = obj?.error?.message ?? 'unknown bundler error';
    throw new Error(`submitUserOp: ${msg}`);
  }
  if (!obj.result.startsWith('0x')) {
    throw new Error(`submitUserOp: malformed userOpHash (${obj.result})`);
  }
  return obj.result as `0x${string}`;
}
