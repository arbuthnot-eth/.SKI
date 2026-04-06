# .SKI Security Posture

> **Last audit:** 2026-04-06 | **Branch:** `security/hardening-q2-2026`

## What this branch fixes

| # | Fix | Issue | Severity |
|---|-----|-------|----------|
| 1 | CSP + security response headers on all Worker routes | #53 | P1 |
| 2 | Auth guards on SessionAgent mutating callables + sanitized state broadcast | #56 | P0 |
| 3 | Auth guards on SponsorAgent mutating callables + sanitized state broadcast | #56 | P0 |
| 4 | Shell restore XSS sanitization in index.html | #55 | P1 |
| 5 | Session nonce validation — server checks message expiry | #57 | P1 |
| 6 | localStorage cleanup on disconnect (session tokens, IKA addrs, balances) | #54 | P2 |
| 7 | Pass real signed message to `authenticate()` (was empty string) | #57 | P1 |

## Open issues (tracked, not yet fixed)

| Issue | Title | Severity |
|-------|-------|----------|
| #53 | CSP headers (nonce-based `script-src` upgrade) | P1 |
| #54 | localStorage TTL expiry + encrypted sponsor auth | P2 |
| #55 | QR SVG innerHTML + showToast footgun | P1 |
| #56 | TreasuryAgents + ShadeExecutor DO auth (attestCollateral, mintIusd) | P0 |
| #57 | HttpOnly cookie via server-set `Set-Cookie` | P1 |
| #58 | Rate limiting + slippage protection | P2 |

## Architecture notes

### Client-side storage
- `ski:session:{address}` — session tokens. Cleared on disconnect (this branch).
- `ski:waap-proof` — AES-256-GCM encrypted, device-fingerprint-bound. Sound.
- `ski:gas-sponsor` — plaintext sponsor auth. TODO: encrypt like waap-proof (#54).
- `ski:shell` — cached HTML for FOUC prevention. Sanitized on restore (this branch).

### Cross-domain cookie
- `ski_xdomain` — `Secure; SameSite=Lax; domain=sui.ski`. Not HttpOnly (set via JS). TODO: migrate to server `Set-Cookie` (#57).

### DO authentication pattern
- `SessionAgent.authenticate()` — verifies personal message signature + `.SKI` format + expiry.
- `SponsorAgent.register()` — verifies personal message signature + `.SKI Splash` format.
- All other mutating callables now require `callerAddress` matching the authenticated owner.
- `getSponsorState()` strips `authSignature`, `authMessage`, and redacts `txBytes` on non-ready requests.
- `getSession()` strips `signature` and `message` fields.

### What still needs auth (P0, #56)
- `TreasuryAgents.attestCollateral()` — any caller can report false collateral
- `TreasuryAgents.mintIusd()` — any caller can mint to arbitrary recipient
- `ShadeExecutorAgent` — schedule/cancel methods
