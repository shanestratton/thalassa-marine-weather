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
    'VITE_WEATHERKIT_PRIVATE_KEY',
    'VITE_WORLDTIDES_API_KEY',
    'VITE_WORLD_TIDES_API_KEY',
];

const forbidden = new Set(FORBIDDEN_CLIENT_SECRET_NAMES);
const violations = [];

for (const name of FORBIDDEN_CLIENT_SECRET_NAMES) {
    if (Object.hasOwn(process.env, name)) violations.push(`process environment: ${name}`);
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
        const name = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)?.[1];
        if (name && forbidden.has(name)) violations.push(`${relative}: ${name}`);
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
        for (const name of FORBIDDEN_CLIENT_SECRET_NAMES) {
            if (source.includes(name)) violations.push(`${path.relative(ROOT, file)}: ${name}`);
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
