# .SKI — .Sui Key-In

One-button Sui wallet sign-in. Connect once, authenticate everywhere.

[![npm](https://img.shields.io/npm/v/sui.ski)](https://www.npmjs.com/package/sui.ski)
[![Live](https://img.shields.io/badge/live-sui.ski-blue)](https://sui.ski)

## What it does

.SKI adds a two-button wallet widget to any Sui dApp:

- **Left pill** — shows the connected wallet icon, SuiNS name or address, and balance
- **.SKI button** — opens the .SKI modal

The **.Sui Key-In modal** lists all installed Sui wallet extensions. For each one it shows every key that has ever connected through that extension (with SuiNS names resolved), the active networks, and supported features. The currently connected wallet and address are pre-selected when the modal opens.

After the user picks a wallet and connects, .SKI requests a personal message signature to prove key ownership, then binds the proof to a device fingerprint. The signed session persists across reloads. No backend required for the core flow.

## Install

```bash
npm install sui.ski
# or
bun add sui.ski
```

## Embed via script tag (CDN)

Add the stylesheet and module to your `<head>`:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/sui.ski/public/styles.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/sui.ski/public/dist/ski.js"></script>
```

Then add the widget markup anywhere in your `<body>`:

```html
<div class="wallet-widget" id="wallet-widget">
  <div id="wk-widget"></div>
  <button class="wallet-ski-btn" id="wallet-ski-btn" style="display:none"></button>
  <div id="wallet-menu-root"></div>
</div>
<div id="ski-modal-root"></div>
```

The script auto-initializes on load — no further JS required.

## Embed via bundler

```ts
import 'sui.ski';
```

Same DOM markup as above is required.

## Events

Listen for wallet connection state changes:

```ts
window.addEventListener('ski:wallet-connected', (e: CustomEvent) => {
  const { address, walletName } = e.detail;
  // user is now connected — address is the Sui address, walletName is e.g. "Phantom"
});

window.addEventListener('ski:wallet-disconnected', () => {
  // user disconnected or session expired
});
```

## Opening the Key-In modal programmatically

The `.SKI` button opens the modal automatically. To open it from your own code:

```ts
// The modal is exported from the module entry point
window.dispatchEvent(new CustomEvent('ski:open-modal'));
```

Or if you're importing the module directly and have access to the export:

```ts
import { openModal } from 'sui.ski/src/ui.js';
openModal();
```

The modal:
- Pre-populates with the currently connected wallet's detail on open
- Shows all keys ever seen through each wallet extension (SuiNS names resolved)
- Floats the active key to the top of the key list
- Lets users switch wallets with one click
- Handles race conditions — fast switching between wallets won't bleed SuiNS names across panels

## Session layer

Once connected and signed, .SKI stores a session in `localStorage` under `ski:session`. On reload it automatically attempts to restore the session silently. If the session has expired (24h default), it prompts for a new signature.

Session key format: `deviceFingerprint:walletAddress` — ties the proof to both the device and the key.

The included Cloudflare Durable Object session agent (`src/server/agents/session.ts`) can be used to verify sessions server-side if you deploy your own worker.

## Supported wallets

Any wallet implementing the [Sui Wallet Standard](https://docs.sui.io/standards/wallet-standard):

- Phantom
- Backpack
- Slush
- Suiet
- Any other Sui Wallet Standard extension

## Self-hosting / Cloudflare Worker deploy

This package includes the full Cloudflare Worker source. Deploy your own instance:

```bash
bun install
npx wrangler login
bun run deploy   # builds + deploys in one step
```

`bun run deploy` runs `bun run build` (compiles `src/ski.ts` → `public/dist/ski.js`) then `npx wrangler deploy`.

## Local development

```bash
bun install
bun run dev          # watches src/ski.ts and rebuilds on change
# in a second terminal:
bun run dev:wrangler # wrangler dev with hot reload
```

Open `http://localhost:8787` — always use `http://localhost` (not `file://`) so wallet extensions have a valid origin.

## License

MIT
