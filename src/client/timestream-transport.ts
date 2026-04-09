/**
 * Timestream Transport — client-side RelayerTransport backed by TimestreamAgent DO.
 *
 * Implements the @mysten/sui-stack-messaging RelayerTransport interface.
 * Messages are sent to /api/timestream/:groupId/* endpoints which route
 * to per-group TimestreamAgent Durable Objects.
 */
import type {
  RelayerTransport,
  SendMessageParams,
  SendMessageResult,
  FetchMessagesParams,
  FetchMessagesResult,
  FetchMessageParams,
  RelayerMessage,
  UpdateMessageParams,
  DeleteMessageParams,
  SubscribeParams,
} from '@mysten/sui-stack-messaging';

function toB64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

function fromB64(b64: string): Uint8Array {
  const raw = atob(b64);
  return new Uint8Array(Array.from(raw, c => c.charCodeAt(0)));
}

function wireToRelayerMessage(wire: any): RelayerMessage {
  return {
    messageId: wire.messageId,
    groupId: wire.groupId,
    order: wire.order,
    encryptedText: fromB64(wire.encryptedText),
    nonce: fromB64(wire.nonce),
    keyVersion: BigInt(wire.keyVersion),
    senderAddress: wire.senderAddress,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    attachments: [],
    isEdited: wire.isEdited ?? false,
    isDeleted: wire.isDeleted ?? false,
    signature: wire.signature || '',
    publicKey: wire.publicKey || '',
  };
}

export class TimestreamTransport implements RelayerTransport {
  private _baseUrl: string;
  private _abortControllers = new Set<AbortController>();

  constructor(baseUrl = '') {
    this._baseUrl = baseUrl;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const res = await fetch(`${this._baseUrl}/api/timestream/${params.groupId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: params.groupId,
        encryptedText: toB64(params.encryptedText),
        nonce: toB64(params.nonce),
        keyVersion: params.keyVersion.toString(),
        senderAddress: await params.signer.toSuiAddress(),
        signature: params.messageSignature || '',
      }),
    });
    const data = await res.json() as { messageId: string };
    return { messageId: data.messageId };
  }

  async fetchMessages(params: FetchMessagesParams): Promise<FetchMessagesResult> {
    const res = await fetch(`${this._baseUrl}/api/timestream/${params.groupId}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        afterOrder: params.afterOrder,
        beforeOrder: params.beforeOrder,
        limit: params.limit,
      }),
    });
    const data = await res.json() as { messages: any[]; hasNext: boolean };
    return {
      messages: data.messages.map(wireToRelayerMessage),
      hasNext: data.hasNext,
    };
  }

  async fetchMessage(params: FetchMessageParams): Promise<RelayerMessage> {
    const res = await fetch(`${this._baseUrl}/api/timestream/${params.groupId}/fetch-one`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: params.messageId }),
    });
    const data = await res.json() as any;
    return wireToRelayerMessage(data);
  }

  async updateMessage(params: UpdateMessageParams): Promise<void> {
    await fetch(`${this._baseUrl}/api/timestream/${params.groupId}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: params.messageId,
        senderAddress: await params.signer.toSuiAddress(),
        encryptedText: toB64(params.encryptedText),
        nonce: toB64(params.nonce),
        keyVersion: params.keyVersion.toString(),
        signature: params.messageSignature || '',
      }),
    });
  }

  async deleteMessage(params: DeleteMessageParams): Promise<void> {
    await fetch(`${this._baseUrl}/api/timestream/${params.groupId}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: params.messageId,
        senderAddress: await params.signer.toSuiAddress(),
      }),
    });
  }

  async *subscribe(params: SubscribeParams): AsyncIterable<RelayerMessage> {
    const ac = new AbortController();
    this._abortControllers.add(ac);
    if (params.signal) params.signal.addEventListener('abort', () => ac.abort());

    let afterOrder = params.afterOrder ?? 0;
    const limit = params.limit ?? 20;

    try {
      while (!ac.signal.aborted) {
        const { messages } = await this.fetchMessages({
          signer: params.signer,
          groupId: params.groupId,
          afterOrder,
          limit,
        });

        for (const msg of messages) {
          yield msg;
          afterOrder = msg.order;
        }

        // Poll interval — 3 seconds
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 3000);
          ac.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    } finally {
      this._abortControllers.delete(ac);
    }
  }

  disconnect(): void {
    for (const ac of this._abortControllers) ac.abort();
    this._abortControllers.clear();
  }
}
