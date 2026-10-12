#!/usr/bin/env node
// Creates .env from .env.example and the devnet deployment records, with fresh random secrets.
//   node scripts/make-env.mjs            create .env (refuses to overwrite)
//   node scripts/make-env.mjs --force    overwrite
// No dependencies; works on Windows, macOS and Linux.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
if (existsSync(envPath) && !process.argv.includes('--force')) {
  console.error('.env already exists; pass --force to overwrite it.');
  process.exit(1);
}

const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const deployment = read('programs/groundgraph/deployments/devnet.json');
if (!deployment.deployed) {
  console.error('programs/groundgraph/deployments/devnet.json says deployed:false. Deploy and bootstrap first.');
  process.exit(1);
}
const bootstrap = read('programs/groundgraph/deployments/devnet-bootstrap.json');

const set = {
  PROGRAM_ID: deployment.programId,
  USDC_MINT: bootstrap.usdcMint,
  SESSION_SECRET: randomBytes(32).toString('hex'),
  POSTGRES_PASSWORD: randomBytes(16).toString('hex'),
  // Demo data (clearly labelled in the UI) is what the radar shows until a Helius key lets the scorer read real wallets.
  DEMO_MODE: 'true',
  SCORER_SOURCE: 'synthetic',
  FAUCET_KEYPAIR: './.keys/faucet.json',
  KEEPER_KEYPAIR: './.keys/keeper.json',
  // The keeper only pays fees; the bootstrap funds it with 0.1 SOL, which covers thousands of settlements.
  KEEPER_MIN_SOL: '0.05',
  // Devnet test USDC has no value, so US visitors (hackathon judges, reviewers) are allowed in; comprehensively sanctioned
  // countries stay blocked. Set the full list you need before pointing this at anything real.
  BLOCKED_COUNTRIES: 'CU,IR,KP,SY',
};

let text = readFileSync(join(root, '.env.example'), 'utf8');
for (const [key, value] of Object.entries(set)) {
  const line = new RegExp(`^${key}=.*$`, 'm');
  text = line.test(text) ? text.replace(line, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}
writeFileSync(envPath, text);
console.log(`wrote ${envPath}`);
console.log(`  PROGRAM_ID=${set.PROGRAM_ID}`);
console.log(`  USDC_MINT=${set.USDC_MINT}`);
console.log('  random SESSION_SECRET and POSTGRES_PASSWORD generated; DEMO_MODE=true (labelled demo data)');
