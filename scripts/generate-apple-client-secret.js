#!/usr/bin/env node
/**
 * Generate the Apple Sign-In OAuth client secret JWT for Supabase.
 *
 * Why this exists: Supabase's "Secret Key (for OAuth)" field on the
 * Apple provider page wants a ES256-signed JWT, not the raw .p8
 * private key. The JWT max-expiry is 6 months, so this script needs
 * to be re-run periodically — calendar entry recommended.
 *
 * Inputs: path to the AuthKey_*.p8 file you downloaded from
 * developer.apple.com → Keys.
 *
 * Usage:
 *   node scripts/generate-apple-client-secret.js ~/Downloads/AuthKey_CPLT5FAXQZ.p8
 *
 * Then paste the printed JWT into Supabase → Authentication →
 * Sign In / Providers → Apple → Secret Key (for OAuth) → Save.
 *
 * The Team/Key/Client IDs below are the ones registered for the
 * Thalassa app at developer.apple.com — they are NOT secrets, they
 * are identifiers. Only the .p8 file is sensitive.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

// ── Apple identifiers (not secrets — checked into git) ─────────
const TEAM_ID = 'D4TW8A23QZ'; // top-right of developer.apple.com
const KEY_ID = 'CPLT5FAXQZ'; // 10-char ID shown after creating the Sign in with Apple key
const CLIENT_ID = 'com.thalassa.weather'; // iOS bundle ID

// ── Arg parsing ────────────────────────────────────────────────
const keyPath = process.argv[2];
if (!keyPath) {
    console.error('\nUsage: node scripts/generate-apple-client-secret.js <path-to-.p8>\n');
    console.error('Example:');
    console.error('  node scripts/generate-apple-client-secret.js ~/Downloads/AuthKey_CPLT5FAXQZ.p8\n');
    process.exit(1);
}

const resolved = path.resolve(keyPath.replace(/^~/, os.homedir()));
if (!fs.existsSync(resolved)) {
    console.error(`\nFile not found: ${resolved}\n`);
    process.exit(1);
}

const privateKey = fs.readFileSync(resolved, 'utf8');

// ── Build JWT ──────────────────────────────────────────────────
// Apple's max expiry for a Sign in with Apple client secret is
// 6 months (15777000 seconds). We pick 180 days to leave a few
// days' headroom against drift.
const now = Math.floor(Date.now() / 1000);
const expiry = now + 60 * 60 * 24 * 180;

const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
const payload = {
    iss: TEAM_ID,
    iat: now,
    exp: expiry,
    aud: 'https://appleid.apple.com',
    sub: CLIENT_ID,
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const signingInput = `${b64url(header)}.${b64url(payload)}`;

// JWT requires raw r||s signature format (IEEE P1363), not DER.
// Node 15+ supports the dsaEncoding option.
const signer = crypto.createSign('SHA256');
signer.update(signingInput);
signer.end();
const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

const jwt = `${signingInput}.${signature}`;

// ── Output ─────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
console.log('Apple Sign-In Client Secret JWT');
console.log('════════════════════════════════════════════════════════════\n');
console.log(jwt);
console.log('\n────────────────────────────────────────────────────────────');
console.log(`Expires: ${new Date(expiry * 1000).toISOString()}`);
console.log(`          (~${Math.round((expiry - now) / 86400)} days from now)`);
console.log('────────────────────────────────────────────────────────────');
console.log('Paste the JWT above into:');
console.log('  Supabase → Authentication → Sign In / Providers → Apple');
console.log('  → Secret Key (for OAuth) → Save');
console.log('════════════════════════════════════════════════════════════\n');
