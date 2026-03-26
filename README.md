# .SKI — .Sui Key-In

Your Sui wallet, everywhere. Connect once, authenticate everywhere.

[![npm](https://img.shields.io/npm/v/sui.ski)](https://www.npmjs.com/package/sui.ski)
[![Live](https://img.shields.io/badge/live-sui.ski-blue)](https://sui.ski)

<a href="https://sui.ski"><img src="public/assets/sui-ski-qr.svg" width="160" alt="sui.ski QR code"></a>

---

## Domain structure

| Domain | Purpose |
|---|---|
| `sui.ski` | Root — main application, embeddable widget, API endpoints |
| `<name>.sui.ski` | SuiNS profile pages (e.g. `brando.sui.ski` for `brando.sui`) |

All subdomains with 3+ characters are reserved for SuiNS profile pages. There are no dedicated subdomains for the app, API, or RPC — everything routes through the root domain.

A cross-domain session cookie (`ski:xdomain`) is set on `domain=sui.ski` so authentication persists across the root and all profile subdomains.

---

## UI overview

The `.SKI` header bar renders up to four elements in a row:

### Dot button (`ski-dot`)

Small status indicator on the far left. Shows the connected wallet's shape (diamond = address only, blue square = has SuiNS name, green circle = unconnected). Clicking it opens the **SKI modal** when disconnected, or toggles the **SKI menu** when connected. The dot carries a Splash drop overlay when a sponsor is active.

### Profile pill (`ski-profile`)

Displays the connected wallet icon, social badge (WaaP provider), SuiNS name, and live balance. Clicking the pill opens the wallet's `.sui.ski` profile page in a new tab when a SuiNS name is set. The balance cycles between SUI-primary and USD-primary on click.

### SKI button (`ski-btn`)

The main branded button showing the SKI logo and optionally the wallet shape, SuiNS name, and Splash drop. When disconnected, clicking it opens the **SKI modal**. When connected, it toggles the **SKI menu**. The modal and menu are mutually exclusive — opening one always closes the other.

### Balance pill

Shows the live USD-equivalent balance with a dollar icon. Click to cycle between SUI and USD display.

---

## SKI modal

A single-column overlay anchored below the SKI button, right-aligned with it. The modal has a fixed header (brand logo, balance, QR code) and a scrollable body containing:

- **Key detail pane** — the currently selected wallet with SuiNS name, address, balance, network badges, and Ika dWallet status. Defaults to the first blue-square wallet on open, falls back to the first black-diamond, then to WaaP.
- **Splash legend** — every key that has ever connected from this device, grouped by shape tier (diamond > blue square > green circle) with collapsible group arrows
- **+ new WaaP row** — always present in the green tier; clicking it shows a placeholder detail pane, and clicking that detail header disconnects any active WaaP session and opens a fresh WaaP OAuth modal
- **Wallet list** (alternative layout) — one row per installed wallet extension with shape badges and social icons

Each legend row shows the key shape, SuiNS name badge, truncated hex address (right-justified), and the wallet provider icon (Phantom, Backpack, WaaP social icon, Slush, Suiet, etc.).

**Long-press lock** — hold a row for 2.2 s to lock the detail pane to that wallet. An amber ring indicates locked state. Long-press again to unlock.

**Layout toggle** — the Splash/List switch at the bottom lets users choose between the splash legend view and the plain wallet list. Preference is persisted in `localStorage`.

## SKI menu

A dropdown menu beneath the SKI button (mutually exclusive with the modal). Contains:

- SuiNS name management — register new `.sui` names, set default, view owned names with renewal dates
- Shade orders — privacy-preserving grace-period domain sniping with commitment-reveal
- Disconnect button
- Manage Keys — opens the modal from the menu

## SuiNS integration

Full SuiNS lifecycle from the SKI menu:

- **Register** — search and register `.sui` names with instant tier pricing, pay with SUI, USDC, or NS tokens
- **Set default** — change your primary SuiNS name (updates the SKI button and profile instantly)
- **Target address** — view and copy the address a name points to, with color-coded status (purple = self, green = available, orange = kiosk-listed)
- **Owned names** — scrollable chip grid showing all names owned by the connected wallet, with grace-period expiry warnings and renewal cost estimates

---

## Session layer

After connecting, .SKI requests one personal message signature to prove key ownership. The signed proof is tied to a FingerprintJS `visitorId` (device fingerprint) and stored in `localStorage`. On reload the session is restored silently — no re-signing required until it expires (7 days for software wallets, 24 hours for hardware/Keystone).

Session format: `{ address, signature, bytes, visitorId, expiresAt }` — stored under `ski:session`.

## Splash sponsorship

Splash is a device-level gas sponsor system. A wallet owner activates Splash to cover gas fees for every key connected from the same device. Sponsored transactions use Sui's sponsored transaction flow.

- Activate via the Splash button in the modal header or the detail card
- Devices that connect through `?splash={address}` are enrolled automatically
- SuiNS names work as the sponsor parameter: `?splash=brando.sui`
- The drop badge appears on keys covered by an active sponsor

## Shade

Privacy-preserving SuiNS grace-period domain sniping via on-chain commitment-reveal. A Move contract stores only `keccak256(domain || execute_after_ms || target_address || salt)` — the domain name, target address, and execution timestamp remain hidden until reveal at execution time.

- **ShadeOrder** — a shared object holding the owner address, escrowed SUI balance, and opaque commitment hash
- **`execute()`** — permissionless; anyone with the preimage can call, enabling keeper bots
- **`cancel()`** — owner-only; returns escrowed SUI
- **ShadeExecutorAgent** — Cloudflare Durable Object that auto-executes orders at grace-period expiry via DO Alarms, using a dedicated keeper address with its own gas
- Three execution routes: SUI->NS (DeepBook), SUI->USDC->NS (two-hop), or SUI direct fallback

Contract: `0xfcd0b2b4f69758cd3ed0d35a55335417cac6304017c3c5d9a5aaff75c367aaff`

See [SHIELD.md](SHIELD.md) for the full security model and threat analysis.

## WaaP (social login)

WaaP provides custodial wallet creation via social login, email, phone, and biometrics — no browser extension required. A static placeholder wallet is always present in the SKI modal so the "+ new WaaP" row renders instantly on page load, before the WaaP SDK finishes initializing.

| Auth method | Status |
|---|---|
| Social (X, Google, Discord, GitHub) | Active |
| Email | Active |
| Phone | Active |
| Biometrics | Active |

WaaP accounts appear in the legend with their social provider icon (X, Google, Discord, or email envelope). Clicking an existing WaaP blue-square row reconnects via encrypted device proof (zero-modal). Clicking "+ new WaaP" forces a full disconnect and opens a fresh OAuth flow.

---

## Install

```bash
npm install sui.ski
# or
bun add sui.ski
```

## Embed via script tag (CDN)

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/sui.ski/public/styles.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/sui.ski/public/dist/ski.js"></script>
```

Add the widget markup anywhere in your `<body>`:

```html
<div class="ski-header">
  <div class="ski-wallet" id="ski-wallet">
    <button class="ski-btn ski-dot" id="ski-dot" style="display:none"></button>
    <div id="ski-profile"></div>
    <button class="ski-btn" id="ski-btn" style="display:none"></button>
    <div id="ski-menu"></div>
  </div>
</div>
<div id="ski-modal"></div>
```

The script auto-initializes on load — no further JS required.

## Embed via bundler

```ts
import 'sui.ski';
```

Same DOM markup as above is required.

## Events

```ts
window.addEventListener('ski:wallet-connected', (e: CustomEvent) => {
  const { address, walletName } = e.detail;
});

window.addEventListener('ski:wallet-disconnected', () => {});

// Request sign-in (opens modal, then triggers sign + redirect to sui.ski)
window.dispatchEvent(new CustomEvent('ski:request-signin'));
```

## Requesting a transaction

```ts
import { Transaction } from '@mysten/sui/transactions';

const tx = new Transaction();
// ... build your transaction

window.dispatchEvent(new CustomEvent('ski:sign-and-execute-transaction', {
  detail: { transaction: tx, requestId: 'my-req-1' }
}));

window.addEventListener('ski:transaction-result', (e: CustomEvent) => {
  const { requestId, success, digest, error } = e.detail;
});
```

If a Splash sponsor is active, the sponsored flow is used automatically.

## Modal API

```ts
import { openModal } from 'sui.ski';
import { setModalLayout, type ModalLayout } from 'sui.ski';

// Layouts: 'splash' (default), 'list' (wallet list only), 'layout2' (no Splash strip)
setModalLayout('list');
```

## Supported wallets

Any wallet implementing the [Sui Wallet Standard](https://docs.sui.io/standards/wallet-standard):

| Wallet | Shape | Notes |
|---|---|---|
| Phantom | Diamond/Blue | |
| Backpack | Diamond/Blue | Keystone hardware via Backpack supported (24 h session) |
| Slush | Green | |
| Suiet | Green | |
| Keystone | Diamond | Direct extension; auto-prompts on connect |
| WaaP | Diamond/Blue/Green | Social/email/phone/biometrics wallet; provider badge displayed |
| Any Sui Wallet Standard extension | Varies | |

Shape is determined by state: green circle = never connected, black diamond = connected (no SuiNS), blue square = connected with SuiNS name.

## Self-hosting / Cloudflare Worker deploy

```bash
bun install
npx wrangler login
bun run build && npx wrangler deploy
```

The worker hosts four Durable Objects:

| Binding | Purpose |
|---|---|
| `SessionAgent` | Verifies signed sessions server-side |
| `SponsorAgent` | Manages Splash sponsor state |
| `SplashDeviceAgent` | Tracks per-device Splash activation (keyed by FingerprintJS `visitorId`) |
| `ShadeExecutorAgent` | Auto-executes Shade orders at grace-period expiry via DO Alarms |

API routes served by the worker:

| Route | Purpose |
|---|---|
| `/agents/*` | WebSocket upgrade for Durable Object agents |
| `/api/health` | Health check |
| `/api/shade/*` | Shade order management (poke, status, schedule) |
| `/api/tradeport/listing/:label` | TradePort listing proxy |

## IKA dWallet Integration (feat/ika-btc)

Native Bitcoin addresses via IKA's 2PC-MPC threshold signatures. A single secp256k1 dWallet controls a real Bitcoin address — no bridges, no wrapping, no custodians.

### Architecture

| Layer | File | Purpose |
|-------|------|---------|
| Chain registry | `src/client/chains.ts` | CAIP-2 chain → IKA curve/algo/derivation mapping |
| Address derivation | `src/client/ika.ts` | Extract pubkey from dWallet → derive chain addresses |
| Signing ceremony | `src/client/ika-signing.ts` | 5-phase 2PC-MPC signing with browser presign pool |
| gRPC adapter | `src/server/grpc-7k-adapter.ts` | Wraps SuiGrpcClient for 7K SDK compatibility |
| DKG provisioning | `src/server/ika-provision.ts` | Server-side sponsored dWallet creation |
| SuiNS gate | `src/server/index.ts` | Gas sponsorship gated by SuiNS NFT ownership |

### How it works

1. **Sign in** → check for existing dWallet via `getCrossChainStatus()`
2. **No dWallet + has SuiNS** → server builds sponsored DKG tx (SUI→IKA swap via Cetus CLMM in same PTB), user co-signs, submits
3. **dWallet active** → derive `bc1q...` address from secp256k1 public output
4. **BTC network view** → orange address row, mempool.space explorer, BTC QR code

### Credits

Chain registry and signing ceremony adapted from [inkwell-finance/ows-ika](https://github.com/inkwell-finance/ows-ika) (MIT) — Inkwell Finance's OpenWallet Standard adapter for IKA dWallets.

### Development log

| Date | Change | Commit |
|------|--------|--------|
| 2026-03-26 | gRPC adapter for Bluefin 7K aggregator SDK (4-method shim, no JSON-RPC) | `0f3818a` |
| 2026-03-26 | SuiNS NFT ownership gate on `/api/sponsor-gas` | `5a8b8fe` |
| 2026-03-26 | Bitcoin bech32 address derivation from dWallet pubkey | `65982ea` |
| 2026-03-26 | Orange BTC address display, mempool.space link, network-aware copy/QR | `674d8ab` |
| 2026-03-26 | Server-side sponsored DKG provisioning endpoint | `14c17ab` |
| 2026-03-26 | Auto-provision dWallet at sign-in for SuiNS holders | `d361082` |
| 2026-03-26 | Direct Cetus SUI→IKA swap in DKG PTB, IKA buffer fallback | `37d8345` |
| 2026-03-26 | CAIP-2 chain registry for multi-chain address derivation | `3871a7f` |
| 2026-03-26 | 2PC-MPC signing ceremony adapter with browser presign pool | `ce66411` |

---

## Stack

- `@mysten/sui` ^2.5.1, `@mysten/suins` ^1.0.2, `@human.tech/waap-sdk` ^1.2.2, `@ika.xyz/sdk` ^0.3.1
- Transport: `SuiGrpcClient` primary with `SuiGraphQLClient` fallback (no JSON-RPC)
- Crypto: `@noble/hashes` (SHA-256, RIPEMD-160), `@scure/base` (bech32)
- Build: `bun build src/ski.ts --outdir public/dist --target browser`
- Deploy: Cloudflare Workers + Wrangler 4.77

## Local development

```bash
bun install
bun run dev          # watches src/ski.ts, rebuilds on change
# in a second terminal:
bun run dev:wrangler # wrangler dev with hot reload
```

Open `http://localhost:8787` — always use `http://localhost` (not `file://`) so wallet extensions have a valid origin.

## License

MIT
