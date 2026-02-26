/**
 * SponsorAgent — Durable Object that coordinates gas sponsorship.
 *
 * One DO instance per sponsor address (keyed by the sponsor's Sui address).
 *
 * Flow:
 *   1. Sponsor registers with a signed authorization message + pushes gas coins.
 *   2. User requests sponsorship: sends fully-built sponsored tx bytes.
 *   3. State update pushes the request to the sponsor's WebSocket client.
 *   4. Sponsor signs → submits sig.  User signs → submits sig.
 *   5. When both sigs are present, the requesting client submits via gRPC.
 */

import { Agent, callable } from 'agents';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

export interface GasCoin {
  objectId: string;
  version: string;
  digest: string;
}

export interface SponsorRequest {
  id: string;
  senderAddress: string;
  /** base64-encoded fully-built sponsored transaction bytes */
  txBytes: string;
  userSig?: string;
  sponsorSig?: string;
  status: 'awaiting_sigs' | 'user_signed' | 'sponsor_signed' | 'ready' | 'submitted' | 'failed';
  createdAt: number;
  digest?: string;
  error?: string;
}

export interface SponsorState {
  sponsorAddress: string;
  authSignature: string;
  authMessage: string;
  registeredAt: number;
  expiresAt: number;
  active: boolean;
  gasCoins: GasCoin[];
  gasCoinsRefreshedAt: number;
  pendingRequests: SponsorRequest[];
  totalSponsored: number;
  /** Resolved Sui addresses allowed to request sponsorship. Empty = open (any sender). */
  approvedList: string[];
}

interface Env {}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — mirrors .SKI session TTL
const MAX_PENDING = 20;                   // cap queue length

export class SponsorAgent extends Agent<Env, SponsorState> {
  initialState: SponsorState = {
    sponsorAddress: '',
    authSignature: '',
    authMessage: '',
    registeredAt: 0,
    expiresAt: 0,
    active: false,
    gasCoins: [],
    gasCoinsRefreshedAt: 0,
    pendingRequests: [],
    totalSponsored: 0,
    approvedList: [],
  };

  // ─── Sponsor Registration ────────────────────────────────────────────

  @callable()
  async register(params: {
    sponsorAddress: string;
    authSignature: string;
    authMessage: string;
  }): Promise<{ success: boolean; expiresAt?: number; error?: string }> {
    const { sponsorAddress, authSignature, authMessage } = params;

    try {
      const messageBytes = new TextEncoder().encode(authMessage);
      await verifyPersonalMessageSignature(messageBytes, authSignature, { address: sponsorAddress });
    } catch {
      return { success: false, error: 'Invalid signature' };
    }

    if (!authMessage.includes('.SKI Splash')) {
      return { success: false, error: 'Invalid sponsor authorization message' };
    }

    const now = Date.now();
    const expiresAt = now + TTL_MS;

    this.setState({
      ...this.state,
      sponsorAddress,
      authSignature,
      authMessage,
      registeredAt: now,
      expiresAt,
      active: true,
    });

    return { success: true, expiresAt };
  }

  @callable()
  async deactivate(): Promise<void> {
    this.setState({ ...this.state, active: false });
  }

  @callable()
  async addEntry(params: { address: string }): Promise<{ success: boolean }> {
    const list = this.state.approvedList ?? [];
    if (list.includes(params.address)) return { success: true };
    this.setState({ ...this.state, approvedList: [...list, params.address] });
    return { success: true };
  }

  @callable()
  async removeEntry(params: { address: string }): Promise<{ success: boolean }> {
    this.setState({
      ...this.state,
      approvedList: (this.state.approvedList ?? []).filter((a) => a !== params.address),
    });
    return { success: true };
  }

  // ─── Gas Coin Management ─────────────────────────────────────────────

  @callable()
  async refreshGasCoins(params: { coins: GasCoin[] }): Promise<{ success: boolean }> {
    if (!this.state.active) return { success: false };
    this.setState({
      ...this.state,
      gasCoins: params.coins,
      gasCoinsRefreshedAt: Date.now(),
    });
    return { success: true };
  }

  @callable()
  async getGasCoins(): Promise<{ coins: GasCoin[]; refreshedAt: number } | null> {
    if (!this.state.active) return null;
    if (Date.now() > this.state.expiresAt) {
      this.setState({ ...this.state, active: false });
      return null;
    }
    return { coins: this.state.gasCoins, refreshedAt: this.state.gasCoinsRefreshedAt };
  }

  // ─── Sponsorship Requests ────────────────────────────────────────────

  @callable()
  async requestSponsorship(params: {
    senderAddress: string;
    /** base64 of fully-built sponsored transaction bytes (built client-side) */
    txBytes: string;
  }): Promise<{ requestId: string } | { error: string }> {
    if (!this.state.active) return { error: 'Sponsor not active' };
    if (Date.now() > this.state.expiresAt) {
      this.setState({ ...this.state, active: false });
      return { error: 'Sponsor authorization expired' };
    }

    const approvedList = this.state.approvedList ?? [];
    if (approvedList.length > 0 && !approvedList.includes(params.senderAddress)) {
      return { error: 'Not on sponsor list' };
    }

    const openRequests = this.state.pendingRequests.filter(
      r => r.status !== 'submitted' && r.status !== 'failed',
    );
    if (openRequests.length >= MAX_PENDING) {
      return { error: 'Sponsor queue full — try again later' };
    }

    const requestId = crypto.randomUUID();
    const request: SponsorRequest = {
      id: requestId,
      senderAddress: params.senderAddress,
      txBytes: params.txBytes,
      status: 'awaiting_sigs',
      createdAt: Date.now(),
    };

    this.setState({
      ...this.state,
      pendingRequests: [...this.state.pendingRequests, request],
    });

    return { requestId };
  }

  @callable()
  async submitUserSignature(params: {
    requestId: string;
    userSig: string;
  }): Promise<{ success: boolean; error?: string }> {
    const idx = this.state.pendingRequests.findIndex(r => r.id === params.requestId);
    if (idx === -1) return { success: false, error: 'Request not found' };

    const req = this.state.pendingRequests[idx];
    if (req.userSig) return { success: false, error: 'User sig already submitted' };

    const updated: SponsorRequest = {
      ...req,
      userSig: params.userSig,
      status: req.sponsorSig ? 'ready' : 'user_signed',
    };
    const requests = [...this.state.pendingRequests];
    requests[idx] = updated;
    this.setState({ ...this.state, pendingRequests: requests });
    return { success: true };
  }

  @callable()
  async submitSponsorSignature(params: {
    requestId: string;
    sponsorSig: string;
  }): Promise<{ success: boolean; error?: string }> {
    const idx = this.state.pendingRequests.findIndex(r => r.id === params.requestId);
    if (idx === -1) return { success: false, error: 'Request not found' };

    const req = this.state.pendingRequests[idx];
    if (req.sponsorSig) return { success: false, error: 'Sponsor sig already submitted' };

    const updated: SponsorRequest = {
      ...req,
      sponsorSig: params.sponsorSig,
      status: req.userSig ? 'ready' : 'sponsor_signed',
    };
    const requests = [...this.state.pendingRequests];
    requests[idx] = updated;
    this.setState({ ...this.state, pendingRequests: requests });
    return { success: true };
  }

  @callable()
  async markSubmitted(params: { requestId: string; digest: string }): Promise<{ success: boolean }> {
    const idx = this.state.pendingRequests.findIndex(r => r.id === params.requestId);
    if (idx === -1) return { success: false };

    const requests = [...this.state.pendingRequests];
    requests[idx] = { ...requests[idx], status: 'submitted', digest: params.digest };
    this.setState({
      ...this.state,
      pendingRequests: requests,
      totalSponsored: this.state.totalSponsored + 1,
    });
    return { success: true };
  }

  @callable()
  async getSponsorState(): Promise<SponsorState> {
    return this.state;
  }
}
