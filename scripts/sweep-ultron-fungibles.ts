// Regigigas Slack Off — fungible asset sweep from old Ultron to new Ultron.
//
// Signed with the legacy SHADE_KEEPER_PRIVATE_KEY (still in Worker env).
// Transfers IKA, DEEP, NS, USDC, and any iUSD (if > 0) to the new Ultron
// address (read from wrangler.jsonc account_id-agnostic lookup or passed
// as SWEEP_TO arg). Keeps ~0.05 SUI on old for later ceremony gas.
//
// Explicitly does NOT touch:
//   - DWalletCaps                 → re-encrypt ceremony (#170, separate PTB)
//   - BalanceManager              → needs withdraw_all first, separate PTB
//   - iusd::RedeemRequest         → inspect before moving (could be pending)
//
// Dry-run by default — prints the planned transfers and builds the PTB
// bytes without signing. Pass `--execute` to sign + submit.
//
// Usage:
//   bun run scripts/sweep-ultron-fungibles.ts                      # dry-run
//   bun run scripts/sweep-ultron-fungibles.ts --execute            # live
//   bun run scripts/sweep-ultron-fungibles.ts --to 0xNEW_ULTRON    # override target
//
// The CLOUDFLARE_API_TOKEN env var is NOT required — this script does
// NOT touch wrangler secrets. It reads SHADE_KEEPER_PRIVATE_KEY directly
// from the shell env (pass via `read -s` pattern for one-shot safety).

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const TO_ARG_IDX = args.indexOf('--to');
const NEW_ULTRON = TO_ARG_IDX >= 0 ? args[TO_ARG_IDX + 1] : '0x9872c1f5edf4daffbdcf5f577567ce997a00db9d63a8a8fac4feb8b135b285f7';

const OLD_ULTRON = '0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3';
const GAS_DUST_MIST = 50_000_000n; // 0.05 SUI reserved on old Ultron for cleanup

const SUI_TYPE = '0x2::sui::SUI';
const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
const NS_TYPE = '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS';
const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const IUSD_TYPE = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
const DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';

const secret = process.env.SHADE_KEEPER_PRIVATE_KEY ?? process.env.ULTRON_OLD_PRIVATE_KEY;
if (!secret) {
    console.error('[sweep] no SHADE_KEEPER_PRIVATE_KEY in env — export the old Ultron secret before running');
    process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(secret);
const derivedAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
if (derivedAddr !== OLD_ULTRON) {
    console.error(`[sweep] secret derives to ${derivedAddr}, expected old Ultron ${OLD_ULTRON}`);
    process.exit(2);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(NEW_ULTRON)) {
    console.error(`[sweep] invalid target address: ${NEW_ULTRON}`);
    process.exit(3);
}
if (NEW_ULTRON === OLD_ULTRON) {
    console.error('[sweep] target equals source — nothing to sweep');
    process.exit(4);
}

const gql = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });

interface CoinObj { objectId: string; version: string; digest: string; balance: string; }
async function listCoinsOfType(owner: string, coinType: string): Promise<CoinObj[]> {
    const res = await gql.core.listOwnedObjects({
        address: owner,
        type: `0x2::coin::Coin<${coinType}>`,
        limit: 100,
    } as never) as unknown as { objects: Array<{ objectId: string; version: string; digest: string; content?: { json?: { balance?: string } } }> };
    return (res.objects ?? []).map((o) => ({
        objectId: o.objectId,
        version: o.version,
        digest: o.digest,
        balance: o.content?.json?.balance ?? '0',
    }));
}

interface Sweep { type: string; label: string; coins: CoinObj[]; total: bigint; keepOnSource: bigint; }
async function gatherSweeps(): Promise<Sweep[]> {
    const specs: Array<{ type: string; label: string; keepOnSource: bigint }> = [
        { type: IKA_TYPE, label: 'IKA', keepOnSource: 0n },
        { type: DEEP_TYPE, label: 'DEEP', keepOnSource: 0n },
        { type: NS_TYPE, label: 'NS', keepOnSource: 0n },
        { type: USDC_TYPE, label: 'USDC', keepOnSource: 0n },
        { type: IUSD_TYPE, label: 'iUSD', keepOnSource: 0n },
        // SUI swept at the end, minus gas dust
        { type: SUI_TYPE, label: 'SUI', keepOnSource: GAS_DUST_MIST },
    ];
    const out: Sweep[] = [];
    for (const s of specs) {
        const coins = await listCoinsOfType(OLD_ULTRON, s.type);
        const total = coins.reduce((acc, c) => acc + BigInt(c.balance), 0n);
        if (total === 0n) continue;
        out.push({ ...s, coins, total });
    }
    return out;
}

const sweeps = await gatherSweeps();

console.log(`\n[sweep] plan (old=${OLD_ULTRON.slice(0, 10)}… → new=${NEW_ULTRON.slice(0, 10)}…)`);
for (const s of sweeps) {
    const toMove = s.total - s.keepOnSource;
    console.log(`  ${s.label.padEnd(6)} ${s.coins.length} coin(s) total=${s.total} keepOnSource=${s.keepOnSource} transfer=${toMove > 0n ? toMove : 0n}`);
}

if (sweeps.length === 0) {
    console.log('[sweep] nothing to sweep.');
    process.exit(0);
}

// Build PTB
const tx = new Transaction();
tx.setSender(OLD_ULTRON);

for (const s of sweeps) {
    if (s.type === SUI_TYPE) {
        // SUI: keep GAS_DUST_MIST on source. Merge SUI coins into gas, then split
        // the transferable amount from gas coin.
        const toMove = s.total - s.keepOnSource;
        if (toMove <= 0n) continue;
        // Merge all non-primary SUI coins into gas if multiple
        const nonPrimary = s.coins.slice(1).map((c) => tx.object(c.objectId));
        if (nonPrimary.length > 0) tx.mergeCoins(tx.gas, nonPrimary);
        const [transferable] = tx.splitCoins(tx.gas, [tx.pure.u64(toMove.toString())]);
        tx.transferObjects([transferable], tx.pure.address(NEW_ULTRON));
    } else {
        // Non-SUI: merge all coins of this type into first, transfer whole object
        const [primary, ...rest] = s.coins;
        if (rest.length > 0) tx.mergeCoins(tx.object(primary.objectId), rest.map((c) => tx.object(c.objectId)));
        tx.transferObjects([tx.object(primary.objectId)], tx.pure.address(NEW_ULTRON));
    }
}

const txBytes = await tx.build({ client: gql as never });
console.log(`\n[sweep] PTB built: ${txBytes.length} bytes`);

if (!EXECUTE) {
    console.log('[sweep] dry-run (pass --execute to sign + submit)');
    process.exit(0);
}

console.log('[sweep] signing + submitting…');
const { signature } = await keypair.signTransaction(txBytes);
const exec = await gql.core.executeTransaction({
    transaction: toBase64(txBytes),
    signatures: [signature],
} as never);
const inner = (exec as { $kind?: string } & Record<string, { digest?: string }>).$kind === 'Transaction'
    ? (exec as Record<string, { digest?: string }>).Transaction
    : (exec as Record<string, { digest?: string }>).FailedTransaction;
const digest = inner?.digest ?? '';
console.log(`[sweep] tx digest: ${digest}`);
console.log(`[sweep] https://suiscan.xyz/mainnet/tx/${digest}`);
