// Silvally — client-side PTB builders for the dWallet-native SuiNS jacket.
//
// On-chain package (mainnet): 0x85abbe7ca8a197b2fd6b5eed2920d4b93effffb56a1502844ed3822297f63816
// Module: ski::dwallet_subname_policy
//
// Ship order (issue #195 Machamp Dynamic Punch):
//   M1  buildInitSilvallyPolicyTx         — consume a DWalletCap, share the SubnamePolicy
//   M2  buildDelegateApproveAndSignTx     — approve + IKA request_sign in one PTB
//   M3  pollSignSession                   — read signature off-chain
//   M4  verifySilvallySig                 — ECDSA secp256k1 off-chain verify
//
// Once M4 returns valid=true on mainnet, the Silvally pattern is proven and
// every Crowds disc variant (#172–#191) composes.

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

export const SILVALLY_PACKAGE =
  '0x85abbe7ca8a197b2fd6b5eed2920d4b93effffb56a1502844ed3822297f63816';

export const SILVALLY_MODULE = 'dwallet_subname_policy';

/** IKA DWalletCoordinator shared singleton on mainnet. */
export const IKA_COORDINATOR_ID =
  '0x5ea59bce034008a006425df777da925633ef384ce25761657ea89e2a08ec75f3';

/** Convenience default: one year from now. */
export function oneYearFromNowMs(): bigint {
  return BigInt(Date.now() + 365 * 24 * 60 * 60 * 1000);
}

/**
 * M1 — Init a `SubnamePolicy` from an existing IKA `DWalletCap`.
 *
 * The cap is consumed (moved into the shared policy). The returned `OwnerCap`
 * is transferred to `sender` so they can later call `owner_approve` or
 * `retire`. Delegate-signing rights flow through the shared policy object.
 *
 * @param sender             Sui address that owns the DWalletCap and will receive the OwnerCap.
 * @param dwalletCapObjectId Object id of the DWalletCap (post-rumble).
 * @param maxSubnames        Quota for delegate-issuance. 0 = owner-only.
 * @param expirationMs       Unix ms past which delegate_approve_spike aborts (E_EXPIRED).
 */
export function buildInitSilvallyPolicyTx(
  sender: string,
  dwalletCapObjectId: string,
  maxSubnames: bigint,
  expirationMs: bigint = oneYearFromNowMs(),
): Transaction {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(sender));

  const [ownerCap] = tx.moveCall({
    target: `${SILVALLY_PACKAGE}::${SILVALLY_MODULE}::init_policy`,
    arguments: [
      tx.object(dwalletCapObjectId),
      tx.pure.u64(maxSubnames.toString()),
      tx.pure.u64(expirationMs.toString()),
    ],
  });

  tx.transferObjects([ownerCap], tx.pure.address(normalizeSuiAddress(sender)));
  return tx;
}
