# .SKI

Standalone two-button wallet controls using real Sui wallet runtime.

## Includes
- Left pill button with connected state (name/address, SUI, USD)
- Right `.SKI` menu button with dropdown under it
- Real wallet modal via `SuiWalletKit.renderModal(...)`
- Extension wallet detection + WaaP support

## Run
```bash
cd /home/brandon/Dev/workspace/wallet-buttons-product
python3 -m http.server 4173
```

Open: `http://localhost:4173/index.html`

## Cloudflare Worker Deploy
This repo is configured for Cloudflare Worker static assets with `wrangler.jsonc`.

```bash
cd /home/brandon/Dev/workspace/wallet-buttons-product
bun install
bunx wrangler login
bunx wrangler dev
```

Deploy:

```bash
bunx wrangler deploy
```

Important: do not open the app via `file://...`; use `http://localhost` (or deployed `https://...`) so wallet/session calls have a valid origin.

## Transport
- App-level read queries in `app.js` use Sui `GraphQL` (`https://graphql.mainnet.sui.io/graphql`).
- Wallet modal/runtime code in `generated/wallet-runtime.js` is generated from upstream wallet kit modules and may still include internal RPC client paths.

## Notes
- Browser wallet connections work without backend APIs.
- Session cookie endpoints (`/api/wallet/*`) are optional; calls are best-effort.
