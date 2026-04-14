/**
 * Shim that the IKA SDK's wasm-loader imports as `@ika.xyz/ika-wasm` when
 * the `alias` in wrangler.jsonc redirects package resolution here.
 *
 * Why: the SDK's wasm-loader.js captures `isNode = typeof process !== "undefined" && !!process.versions?.node`
 * at module-load time. In Cloudflare Workers with `nodejs_compat`, that's
 * true — so the SDK always takes the Node branch, which does:
 *
 *   const normalized = mod.default ?? mod;
 *   if (typeof normalized.generate_secp_cg_keypair_from_seed !== "function") throw ...
 *   wasmModule = normalized;
 *
 * To satisfy this path we need to (a) eagerly initSync the WebAssembly
 * module at shim-module-load time, and (b) export a `default` namespace
 * object whose shape is `{generate_secp_cg_keypair_from_seed, decrypt_user_share, ...}`
 * — every function the SDK will call via `wasm.<fn>(...)`.
 *
 * We import the `/web` entry to get the JS bindings (the actual function
 * implementations), call its `initSync` with the pre-compiled
 * WebAssembly.Module that Wrangler bundles for us, then re-export each
 * function as a plain property on a `default` object.
 */

import * as webGlue from '@ika.xyz/ika-wasm/web';
// Wrangler's CompiledWasm rule turns this into a WebAssembly.Module at
// build time. Same binary used by UltronSigningAgent's smoke-test path.
import wasmModule from './dwallet_mpc_wasm_bg.wasm';

// Eager init — runs the moment this module is imported (i.e. the moment
// the IKA SDK's wasm-loader.js does `await import("@ika.xyz/ika-wasm")`).
// After this line, every function on webGlue has a live WebAssembly
// instance to call into. Idempotent at the wasm-bindgen layer.
webGlue.initSync({ module: wasmModule as unknown as WebAssembly.Module });

// The SDK's loader does `mod.default ?? mod`, so we bundle every WASM
// function it will call onto a single default-exported object. Each
// function is the real, already-initialized binding from `/web`.
const wasmExports = {
  create_dkg_centralized_output_v1: webGlue.create_dkg_centralized_output_v1,
  create_dkg_centralized_output_v2: webGlue.create_dkg_centralized_output_v2,
  public_key_from_dwallet_output: webGlue.public_key_from_dwallet_output,
  public_key_from_centralized_dkg_output: webGlue.public_key_from_centralized_dkg_output,
  network_key_version: webGlue.network_key_version,
  dwallet_version: webGlue.dwallet_version,
  generate_secp_cg_keypair_from_seed: webGlue.generate_secp_cg_keypair_from_seed,
  network_dkg_public_output_to_protocol_pp: webGlue.network_dkg_public_output_to_protocol_pp,
  reconfiguration_public_output_to_protocol_pp: webGlue.reconfiguration_public_output_to_protocol_pp,
  centralized_and_decentralized_parties_dkg_output_match: webGlue.centralized_and_decentralized_parties_dkg_output_match,
  encrypt_secret_share: webGlue.encrypt_secret_share,
  decrypt_user_share: webGlue.decrypt_user_share,
  verify_user_share: webGlue.verify_user_share,
  sample_dwallet_keypair: webGlue.sample_dwallet_keypair,
  verify_secp_signature: webGlue.verify_secp_signature,
  create_imported_dwallet_centralized_step: webGlue.create_imported_dwallet_centralized_step,
  create_sign_centralized_party_message: webGlue.create_sign_centralized_party_message,
  create_sign_centralized_party_message_with_centralized_party_dkg_output: webGlue.create_sign_centralized_party_message_with_centralized_party_dkg_output,
  parse_signature_from_sign_output: webGlue.parse_signature_from_sign_output,
};

// Default export: the SDK reads `mod.default` and stores it as
// `wasmModule`. Each property is a live, initialized WASM binding.
export default wasmExports;

// Also re-export at the top level so ESM consumers (like
// UltronSigningAgent's own smoke test) can import specific functions
// without reaching through `.default`.
export const {
  create_dkg_centralized_output_v1,
  create_dkg_centralized_output_v2,
  public_key_from_dwallet_output,
  public_key_from_centralized_dkg_output,
  network_key_version,
  dwallet_version,
  generate_secp_cg_keypair_from_seed,
  network_dkg_public_output_to_protocol_pp,
  reconfiguration_public_output_to_protocol_pp,
  centralized_and_decentralized_parties_dkg_output_match,
  encrypt_secret_share,
  decrypt_user_share,
  verify_user_share,
  sample_dwallet_keypair,
  verify_secp_signature,
  create_imported_dwallet_centralized_step,
  create_sign_centralized_party_message,
  create_sign_centralized_party_message_with_centralized_party_dkg_output,
  parse_signature_from_sign_output,
} = wasmExports;
export const initSync = webGlue.initSync;
