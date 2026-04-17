// One-shot: generate a fresh secp256k1 private key, pipe it to
// `wrangler secret put ENS_SIGNER_PRIVATE_KEY`, and print only the
// public ETH address. The private key never touches stdout, the
// process environment, or disk.
//
// Usage: `bun run scripts/rotate-ens-signer.ts`

import { spawn } from 'node:child_process';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const pk = generatePrivateKey();
const address = privateKeyToAccount(pk).address;

const proc = spawn('./node_modules/.bin/wrangler', ['secret', 'put', 'ENS_SIGNER_PRIVATE_KEY'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` },
});
proc.stdin.write(pk);
proc.stdin.end();

proc.on('exit', (code) => {
    if (code === 0) {
        console.log('');
        console.log(`New ENS_SIGNER public address: ${address}`);
        console.log('Update reference_ens_signer_addresses.md and the OffchainResolver constructor args to this.');
    } else {
        process.exit(code ?? 1);
    }
});
