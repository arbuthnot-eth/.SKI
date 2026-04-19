#!/usr/bin/env node
/**
 * Bump the ?v= query param on public/index.html script/style tags so
 * browsers refetch after each deploy instead of serving stale ski.js.
 * Uses the git short-hash when available (stable per commit), falls back
 * to epoch seconds on a shallow clone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const indexPath = 'public/index.html';
let version;
try {
  version = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{4,}$/.test(version)) throw new Error('bad hash');
} catch {
  version = String(Math.floor(Date.now() / 1000));
}

const html = readFileSync(indexPath, 'utf8');
const bumped = html.replace(/(\.(?:js|css))\?v=[^"'\s>]+/g, `$1?v=${version}`);
if (bumped !== html) {
  writeFileSync(indexPath, bumped);
  console.log(`[cache-buster] bumped ?v= → ${version}`);
} else {
  console.log(`[cache-buster] no ?v= tags found in ${indexPath}`);
}
