# .SKI — .Sui Key-In

Your Sui wallet, everywhere. Connect once, authenticate everywhere.

[![npm](https://img.shields.io/npm/v/sui.ski)](https://www.npmjs.com/package/sui.ski)
[![Live](https://img.shields.io/badge/live-sui.ski-blue)](https://sui.ski)

<a href="https://sui.ski"><img src="public/assets/sui-ski-qr.svg" width="160" alt="sui.ski QR code"></a>

---

## UI overview

The `.SKI` header bar renders up to four elements in a row:

### Dot button (`ski-dot`)

Small status indicator on the far left. Shows the connected wallet's shape (diamond, blue square, green circle). Clicking it opens the **SKI modal** when disconnected, or toggles the **SKI menu** when connected. The dot also carries a Splash drop overlay when a sponsor is active.

### Profile pill (`ski-profile`)

Displays the connected wallet icon, social badge (WaaP provider), SuiNS name, and live balance. Clicking the pill opens the wallet's `.sui.ski` profile page in a new tab when a SuiNS name is set. The balance cycles between SUI-primary and USD-primary on click.

### SKI button (`ski-btn`)

The main branded button showing the SKI logo and optionally the wallet shape, SuiNS name, and Splash drop. When disconnected, clicking it opens the **SKI modal**. When connected, it toggles the **SKI menu**. The modal and menu are mutually exclusive — opening one always closes the other.

### Balance pill

Shows the live USD-equivalent balance with a dollar icon. Click to cycle between SUI and USD display.

---

## SKI modal

A single-column overlay anchored below the SKI button, right-aligned with it. The modal has a fixed header (brand logo, balance, QR code) and a scrollable body containing:

- **Connected key card** — the currently active wallet with SuiNS name, address, balance, network badges, and Ika dWallet status
- **Splash legend** — every key that has ever connected from this device, grouped by shape tier (diamond > blue square > green circle) with collapsible group arrows
- **Wallet list** (alternative layout) — one row per installed wallet extension with shape badges and social icons

Each legend row shows the key shape, SuiNS name badge, truncated hex address (right-justified next to the wallet provider icon), and the provider icon (Phantom, Backpack, WaaP, Slush, Suiet, etc.).

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

See [SHIELD.md](SHIELD.md) for the full security model and threat analysis.

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

| Wallet | Notes |
|---|---|
| Phantom | |
| Backpack | Keystone hardware via Backpack supported (24 h session) |
| Slush | |
| Suiet | |
| Keystone | Direct extension; auto-prompts on connect |
| WaaP | Social/email wallet (Google, X, email); diamond shape; provider badge displayed |
| Any Sui Wallet Standard extension | |

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

## Stack

- `@mysten/sui` v2.5.1, `@mysten/suins` ^1.0.2, `@human.tech/waap-sdk` ^1.2.1
- Transport: `SuiGrpcClient` with `SuiGraphQLClient` fallback (no JSON-RPC)
- Build: `bun build src/ski.ts --outdir public/dist --target browser`
- Deploy: Cloudflare Workers + Wrangler 4.70

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
