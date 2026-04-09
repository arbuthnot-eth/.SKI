/**
 * Thunder Timestream — Seal-encrypted messaging between SuiNS identities.
 *
 * Architecture:
 * - Seal 2-of-3 threshold encryption (Overclock, NodeInfra, Studio Mirai)
 * - Messages stored in TimestreamAgent DOs (one per group)
 * - Transport: TimestreamTransport → /api/timestream/:groupId/*
 * - SDK: @mysten/sui-stack-messaging handles envelope encryption + group mgmt
 * - Groups: named by convention (thunder-{sender}-{recipient})
 */
import {
  createSuiStackMessagingClient,
  type DecryptedMessage,
  type GroupRef,
} from '@mysten/sui-stack-messaging';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { TimestreamTransport } from './timestream-transport.js';

// ─── Constants ──────────────────────────────────────────────────────
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// Mainnet Seal key servers (free, open mode, 2-of-3 threshold)
const SEAL_SERVERS = [
  { objectId: '0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6', weight: 1 }, // Overclock
  { objectId: '0x1afb3a57211ceff8f6781757821847e3ddae73f64e78ec8cd9349914ad985475', weight: 1 }, // NodeInfra
  { objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10', weight: 1 }, // Studio Mirai
];

// ─── Types ──────────────────────────────────────────────────────────

export interface ThunderMessage {
  messageId: string;
  groupId: string;
  order: number;
  text: string;
  senderAddress: string;
  createdAt: number;
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  senderVerified: boolean;
}

export interface ThunderClientOptions {
  signer: {
    signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
    toSuiAddress(): string;
  };
  transport: TimestreamTransport;
}

// ─── Client state ───────────────────────────────────────────────────

let _client: ReturnType<typeof createSuiStackMessagingClient> | null = null;
let _transport: TimestreamTransport | null = null;
let _signer: ThunderClientOptions['signer'] | null = null;

/**
 * Initialize the Thunder Timestream client.
 * Sets up Seal 2-of-3 threshold encryption with mainnet key servers
 * and the TimestreamTransport for message delivery.
 */
export function initThunderClient(opts: ThunderClientOptions) {
  _transport = opts.transport;
  _signer = opts.signer;

  const baseClient = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

  _client = createSuiStackMessagingClient(baseClient as any, {
    seal: { serverConfigs: SEAL_SERVERS },
    encryption: {
      sessionKey: { signer: opts.signer as any },
    },
    relayer: { transport: opts.transport },
  });

  return _client;
}

export function getThunderClient() {
  if (!_client) throw new Error('Thunder client not initialized');
  return _client;
}

export function getThunderTransport(): TimestreamTransport {
  if (!_transport) throw new Error('Thunder client not initialized');
  return _transport;
}

export function getThunderSigner() {
  if (!_signer) throw new Error('Thunder client not initialized');
  return _signer;
}

export function resetThunderClient() {
  if (_client) {
    try { _client.messaging.disconnect(); } catch {}
  }
  _client = null;
  _transport = null;
  _signer = null;
}

// ─── High-level API ─────────────────────────────────────────────────

/**
 * Send a Seal-encrypted Thunder signal to a Timestream.
 * SDK handles envelope encryption (AES-256-GCM + Seal threshold key mgmt).
 * Optionally executes a SUI transfer as a separate on-chain tx.
 */
export async function sendThunder(opts: {
  signer?: ThunderClientOptions['signer'];
  groupRef: GroupRef;
  text: string;
  transfer?: { recipientAddress: string; amountMist: bigint };
  executeTransfer?: (txBytes: Uint8Array) => Promise<any>;
}): Promise<{ messageId: string }> {
  const client = getThunderClient();

  // Execute token transfer as separate on-chain tx
  if (opts.transfer && opts.transfer.amountMist > 0n && opts.executeTransfer) {
    const signer = opts.signer || getThunderSigner();
    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(signer.toSuiAddress()));
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.transfer.amountMist)]);
    tx.transferObjects([coin], tx.pure.address(normalizeSuiAddress(opts.transfer.recipientAddress)));
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const bytes = await tx.build({ client: gql as never });
    await opts.executeTransfer(bytes as Uint8Array);
  }

  // Send Seal-encrypted message via SDK + Timestream transport
  return client.messaging.sendMessage({
    signer: (opts.signer || getThunderSigner()) as any,
    groupRef: opts.groupRef,
    text: opts.text,
  });
}

/**
 * Fetch and decrypt messages from a Timestream.
 * SDK handles Seal decryption + envelope verification.
 */
export async function getThunders(opts: {
  signer?: ThunderClientOptions['signer'];
  groupRef: GroupRef;
  afterOrder?: number;
  limit?: number;
}): Promise<{ messages: ThunderMessage[]; hasNext: boolean }> {
  const client = getThunderClient();

  const result = await client.messaging.getMessages({
    signer: (opts.signer || getThunderSigner()) as any,
    groupRef: opts.groupRef,
    afterOrder: opts.afterOrder,
    limit: opts.limit,
  });

  return {
    messages: result.messages.map(m => ({
      messageId: m.messageId,
      groupId: m.groupId,
      order: m.order,
      text: m.text,
      senderAddress: m.senderAddress,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      isEdited: m.isEdited,
      isDeleted: m.isDeleted,
      senderVerified: m.senderVerified,
    })),
    hasNext: result.hasNext,
  };
}

/**
 * Subscribe to real-time Thunder signals in a Timestream.
 */
export async function* subscribeThunders(opts: {
  signer?: ThunderClientOptions['signer'];
  groupRef: GroupRef;
  signal?: AbortSignal;
}): AsyncGenerator<ThunderMessage> {
  const client = getThunderClient();

  for await (const m of client.messaging.subscribe({
    signer: (opts.signer || getThunderSigner()) as any,
    groupRef: opts.groupRef,
    signal: opts.signal,
  })) {
    yield {
      messageId: m.messageId,
      groupId: m.groupId,
      order: m.order,
      text: m.text,
      senderAddress: m.senderAddress,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      isEdited: m.isEdited,
      isDeleted: m.isDeleted,
      senderVerified: m.senderVerified,
    };
  }
}

/**
 * Create a new Timestream (messaging group).
 * Groups are auto-created on first message via the DO, but this
 * creates the on-chain group for Seal key management.
 */
export async function createTimestream(opts: {
  signer?: any;
  name: string;
  members: string[];
  transaction?: Transaction;
}) {
  const client = getThunderClient();
  return client.messaging.createAndShareGroup({
    signer: opts.signer || getThunderSigner() as any,
    name: opts.name,
    initialMembers: opts.members,
    transaction: opts.transaction,
  });
}

// ─── SuiNS resolution ───────────────────────────────────────────────

export async function lookupRecipientAddress(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const suinsClient = new SuinsClient({ client: gql as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    return record?.targetAddress ?? null;
  } catch { return null; }
}

// Re-export types
export type { DecryptedMessage, GroupRef, TimestreamTransport };
