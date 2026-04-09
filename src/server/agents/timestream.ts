/**
 * TimestreamAgent — per-group message storage Durable Object.
 *
 * Stores encrypted Thunder Timestream messages. One DO instance per group
 * (keyed by groupId). Implements the server side of the transport protocol.
 *
 * Messages are stored as encrypted blobs — the DO never sees plaintext.
 * Seal threshold encryption happens client-side via the SDK.
 */

import { Agent } from 'agents';

interface StoredMessage {
  messageId: string;
  groupId: string;
  order: number;
  encryptedText: string;  // base64
  nonce: string;          // base64
  keyVersion: string;     // bigint as string
  senderAddress: string;
  createdAt: number;
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  signature: string;      // hex
  publicKey: string;      // hex
}

interface TimestreamState {
  messages: StoredMessage[];
  nextOrder: number;
}

interface Env {
  Chronicom: DurableObjectNamespace;
  [key: string]: unknown;
}

export class TimestreamAgent extends Agent<Env, TimestreamState> {
  initialState: TimestreamState = {
    messages: [],
    nextOrder: 1,
  };

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split('/').pop() || '';

    try {
      if (request.method === 'POST' && path === 'send') {
        return this._handleSend(request);
      }
      if (request.method === 'POST' && path === 'fetch') {
        return this._handleFetch(request);
      }
      if (request.method === 'POST' && path === 'fetch-one') {
        return this._handleFetchOne(request);
      }
      if (request.method === 'POST' && path === 'update') {
        return this._handleUpdate(request);
      }
      if (request.method === 'POST' && path === 'delete') {
        return this._handleDelete(request);
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  private async _handleSend(request: Request): Promise<Response> {
    const body = await request.json() as {
      groupId: string;
      encryptedText: string;
      nonce: string;
      keyVersion: string;
      senderAddress: string;
      signature?: string;
      publicKey?: string;
    };

    const messageId = crypto.randomUUID();
    const order = this.state.nextOrder;
    const now = Date.now();

    const msg: StoredMessage = {
      messageId,
      groupId: body.groupId,
      order,
      encryptedText: body.encryptedText,
      nonce: body.nonce,
      keyVersion: body.keyVersion,
      senderAddress: body.senderAddress,
      createdAt: now,
      updatedAt: now,
      isEdited: false,
      isDeleted: false,
      signature: body.signature || '',
      publicKey: body.publicKey || '',
    };

    const messages = [...this.state.messages, msg];
    this.setState({ messages, nextOrder: order + 1 });

    return Response.json({ messageId });
  }

  private async _handleFetch(request: Request): Promise<Response> {
    const body = await request.json() as {
      afterOrder?: number;
      beforeOrder?: number;
      limit?: number;
    };

    let msgs = this.state.messages.filter(m => !m.isDeleted);
    if (body.afterOrder !== undefined) msgs = msgs.filter(m => m.order > body.afterOrder!);
    if (body.beforeOrder !== undefined) msgs = msgs.filter(m => m.order < body.beforeOrder!);
    msgs.sort((a, b) => a.order - b.order);

    const limit = body.limit ?? 50;
    const hasNext = msgs.length > limit;
    const page = msgs.slice(0, limit);

    return Response.json({ messages: page, hasNext });
  }

  private async _handleFetchOne(request: Request): Promise<Response> {
    const body = await request.json() as { messageId: string };
    const msg = this.state.messages.find(m => m.messageId === body.messageId);
    if (!msg) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(msg);
  }

  private async _handleUpdate(request: Request): Promise<Response> {
    const body = await request.json() as {
      messageId: string;
      senderAddress: string;
      encryptedText: string;
      nonce: string;
      keyVersion: string;
      signature?: string;
      publicKey?: string;
    };

    const idx = this.state.messages.findIndex(m => m.messageId === body.messageId);
    if (idx === -1) return Response.json({ error: 'Not found' }, { status: 404 });

    const msg = this.state.messages[idx];
    if (msg.senderAddress !== body.senderAddress) {
      return Response.json({ error: 'Not authorized' }, { status: 403 });
    }

    const updated: StoredMessage = {
      ...msg,
      encryptedText: body.encryptedText,
      nonce: body.nonce,
      keyVersion: body.keyVersion,
      signature: body.signature || msg.signature,
      publicKey: body.publicKey || msg.publicKey,
      updatedAt: Date.now(),
      isEdited: true,
    };

    const messages = [...this.state.messages];
    messages[idx] = updated;
    this.setState({ ...this.state, messages });

    return Response.json({ ok: true });
  }

  private async _handleDelete(request: Request): Promise<Response> {
    const body = await request.json() as { messageId: string; senderAddress: string };

    const idx = this.state.messages.findIndex(m => m.messageId === body.messageId);
    if (idx === -1) return Response.json({ error: 'Not found' }, { status: 404 });

    const msg = this.state.messages[idx];
    if (msg.senderAddress !== body.senderAddress) {
      return Response.json({ error: 'Not authorized' }, { status: 403 });
    }

    const updated: StoredMessage = { ...msg, isDeleted: true, updatedAt: Date.now() };
    const messages = [...this.state.messages];
    messages[idx] = updated;
    this.setState({ ...this.state, messages });

    return Response.json({ ok: true });
  }
}
