#!/usr/bin/env node

/**
 * Fail a build when a server-only provider credential is placed in Vite's
 * public environment or survives in a generated browser/native bundle.
 *
 * Vite deliberately embeds every VITE_ value it exposes. Checking source code
 * alone is insufficient: an ignored .env file can still leak a secret during
 * a local/TestFlight build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const CHECK_DIST = process.argv.includes('--dist') || process.argv.includes('--artifacts');
const CHECK_NATIVE = process.argv.includes('--artifacts');

export const FORBIDDEN_CLIENT_SECRET_NAMES = [
    'VITE_ANTHROPIC_API_KEY',
    'VITE_APNS_KEY_P8',
    'VITE_DEEPGRAM_API_KEY',
    'VITE_ELEVENLABS_API_KEY',
    'VITE_GEMINI_API_KEY',
    'VITE_MUSICKIT_PRIVATE_KEY',
    'VITE_OPEN_METEO_API_KEY',
    'VITE_RAINBOW_API_KEY',
    'VITE_SPOONACULAR_KEY',
    'VITE_STORMGLASS_API_KEY',
    'VITE_STRIPE_SECRET_KEY',
    'VITE_SUPABASE_SECRET_KEY',
    'VITE_SUPABASE_SERVICE_ROLE_KEY',
    'VITE_CREW_PHONE_HMAC_KEY',
    'VITE_TWILIO_ACCOUNT_SID',
    'VITE_TWILIO_API_KEY',
    'VITE_TWILIO_API_KEY_SECRET',
    'VITE_TWILIO_API_KEY_SID',
    'VITE_TWILIO_API_SECRET',
    'VITE_TWILIO_AUTH_TOKEN',
    'VITE_TWILIO_VERIFY_SERVICE_SID',
    // The Transistorsoft licence lives ONLY in Info.plist (TSLocationManager
    // reads it natively). A VITE_ copy served no code path — two dead
    // underscore-prefixed reads inlined the 66-char key into the public
    // bundle for nothing (audit 2026-08-02).
    'VITE_TRANSISTOR_LICENSE_KEY',
    'VITE_WEATHERKIT_PRIVATE_KEY',
    'VITE_WORLDTIDES_API_KEY',
    'VITE_WORLD_TIDES_API_KEY',
];

// Twilio provider configuration belongs exclusively in the Edge-function
// environment. Keep the prefix blocked as well as the known names above so a
// newly introduced Twilio credential cannot silently cross the Vite boundary.
export const FORBIDDEN_CLIENT_SECRET_PREFIXES = ['VITE_TWILIO_'];

export const FORBIDDEN_CLIENT_ARTIFACT_IDENTIFIERS = [
    'CREW_PHONE_HMAC_KEY',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_API_KEY',
    'TWILIO_API_KEY_SECRET',
    'TWILIO_API_KEY_SID',
    'TWILIO_API_SECRET',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_VERIFY_SERVICE_SID',
];

const forbidden = new Set(FORBIDDEN_CLIENT_SECRET_NAMES);
const violations = [];
const CLIENT_SUPABASE_KEY_NAMES = new Set(['VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_KEY']);

function isForbiddenClientSecretName(name) {
    return forbidden.has(name) || FORBIDDEN_CLIENT_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isPublishableSupabaseClientKey(value) {
    const key = String(value ?? '')
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
    if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) return true;
    const parts = key.split('.');
    if (parts.length !== 3) return false;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload?.role === 'anon';
    } catch {
        return false;
    }
}

for (const name of Object.keys(process.env)) {
    if (isForbiddenClientSecretName(name)) violations.push(`process environment: ${name}`);
}
for (const name of CLIENT_SUPABASE_KEY_NAMES) {
    const value = process.env[name];
    if (value && !isPublishableSupabaseClientKey(value)) {
        violations.push(`process environment: ${name} is not a publishable/anon Supabase key`);
    }
}

function activeEnvFiles() {
    return fs
        .readdirSync(ROOT, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isFile() &&
                (entry.name === '.env' ||
                    (entry.name.startsWith('.env.') &&
                        !entry.name.endsWith('.example') &&
                        !entry.name.endsWith('.sample'))),
        )
        .map((entry) => path.join(ROOT, entry.name));
}

for (const file of activeEnvFiles()) {
    const relative = path.relative(ROOT, file);
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
        const name = match?.[1];
        if (name && isForbiddenClientSecretName(name)) violations.push(`${relative}: ${name}`);
        if (name && CLIENT_SUPABASE_KEY_NAMES.has(name) && !isPublishableSupabaseClientKey(match?.[2] ?? '')) {
            violations.push(`${relative}: ${name} is not a publishable/anon Supabase key`);
        }
    }
}

function artifactFiles(root, output = []) {
    if (!fs.existsSync(root)) return output;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            artifactFiles(full, output);
        } else if (/\.(?:css|html|js|json|map|txt)$/i.test(entry.name)) {
            output.push(full);
        }
    }
    return output;
}

if (CHECK_DIST) {
    const roots = [path.join(ROOT, 'dist'), ...(CHECK_NATIVE ? [path.join(ROOT, 'ios', 'App', 'App', 'public')] : [])];
    const files = roots.flatMap((root) => artifactFiles(root));
    if (files.length === 0) {
        console.error('❌ No generated client artifacts found to scan.');
        process.exit(1);
    }

    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const name of [...FORBIDDEN_CLIENT_SECRET_NAMES, ...FORBIDDEN_CLIENT_ARTIFACT_IDENTIFIERS]) {
            if (source.includes(name)) violations.push(`${path.relative(ROOT, file)}: ${name}`);
        }
        if (/sb_secret_[A-Za-z0-9_-]{20,}/.test(source)) {
            violations.push(`${path.relative(ROOT, file)}: Supabase sb_secret_ credential value`);
        }
        for (const token of source.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []) {
            const parts = token.split('.');
            try {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                if (payload?.role === 'service_role') {
                    violations.push(`${path.relative(ROOT, file)}: Supabase service_role JWT value`);
                    break;
                }
            } catch {
                /* unrelated JWT-shaped text */
            }
        }
    }
}

if (violations.length > 0) {
    console.error('❌ Server-only credentials crossed the public Vite boundary:');
    for (const violation of violations) console.error(`   ${violation}`);
    console.error('Move provider credentials to Supabase/worker secrets; never print their values.');
    process.exit(1);
}

console.log(
    CHECK_DIST
        ? '✅ Client env and generated artifacts contain no forbidden provider-secret names.'
        : '✅ Client env contains no forbidden provider-secret names.',
);
