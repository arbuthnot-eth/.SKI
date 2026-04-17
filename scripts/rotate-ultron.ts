// One-shot: generate a fresh Ed25519 Sui keypair, pipe the bech32
// secret to `wrangler secret put ULTRON_PRIVATE_KEY`, and print only
// the public Sui address. The secret never touches stdout, the process
// environment, or disk.
//
// Runs ahead of the Regigigas rumble: a Path B rotation gives brando's
// browser a fresh Ed25519 private key to import-DKG with IKA, without
// ever exposing the prior Ultron secret over the network. Old Ultron
// address is retired; downstream references must be swept after rotation.
//
// Usage: `bun run scripts/rotate-ultron.ts`

import { spawn } from 'node:child_process';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const kp = Ed25519Keypair.generate();
const bech32 = kp.getSecretKey();
const address = kp.getPublicKey().toSuiAddress();

const proc = spawn('./node_modules/.bin/wrangler', ['secret', 'put', 'ULTRON_PRIVATE_KEY'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` },
});
proc.stdin.write(bech32);
proc.stdin.end();

proc.on('exit', (code) => {
    if (code === 0) {
        console.log('');
        console.log(`New Ultron public Sui address: ${address}`);
        console.log('Next steps:');
        console.log('  1. Delete legacy binding:  npx wrangler secret delete SHADE_KEEPER_PRIVATE_KEY');
        console.log('  2. Sweep references to the old Ultron address in docs/memory.');
        console.log('  3. Run the Regigigas rumble ceremony in brando.sui\u2019s browser session.');
    } else {
        process.exit(code ?? 1);
    }
});
