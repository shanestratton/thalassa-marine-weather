#!/usr/bin/env node
/**
 * Upload the hidden production source maps to Sentry, then delete them.
 *
 * Runs in CI after `npm run build` with SENTRY_SOURCEMAPS=1. Zero dependencies
 * on purpose: Sentry's release-files API is two HTTP calls, and adding a build
 * plugin for that is a supply-chain surface the dependency audit would have to
 * carry for ever.
 *
 * The delete is NOT optional and does not depend on the upload succeeding.
 * 'hidden' maps still land in dist/, and dist/ is what Vercel serves and what
 * cap copy ships inside the app; a map left behind is the whole source tree
 * on a public URL. No token → skip the upload, still delete, exit 0.
 *
 * Env: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, VITE_APP_VERSION,
 *      VITE_APP_BUILD (optional), SENTRY_URL (optional, default sentry.io).
 */
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';
const token = process.env.SENTRY_AUTH_TOKEN?.trim();
const org = process.env.SENTRY_ORG?.trim();
const project = process.env.SENTRY_PROJECT?.trim();
const base = (process.env.SENTRY_URL?.trim() || 'https://sentry.io').replace(/\/$/, '');
const version = (process.env.VITE_APP_VERSION || '0.0.0').trim();
const build = (process.env.VITE_APP_BUILD || '').trim();
export const release = build ? `thalassa@${version}+${build}` : `thalassa@${version}`;

export function listMaps(dir = DIST) {
    const out = [];
    const walk = (d) => {
        for (const entry of readdirSync(d)) {
            const full = join(d, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (full.endsWith('.map')) out.push(full);
        }
    };
    try {
        walk(dir);
    } catch {
        /* no dist — nothing to do */
    }
    return out;
}

async function sentry(path, init) {
    const res = await fetch(`${base}/api/0${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok && res.status !== 409) {
        throw new Error(
            `Sentry ${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
    }
    return res;
}

async function upload(maps) {
    await sentry(`/organizations/${org}/releases/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: release, projects: [project] }),
    });
    for (const map of maps) {
        // Sentry matches "~/assets/x.js" to any host; upload the map and the
        // JS it describes so stack frames resolve without a debug id.
        for (const file of [map, map.slice(0, -'.map'.length)]) {
            let bytes;
            try {
                bytes = readFileSync(file);
            } catch {
                continue;
            }
            const name = `~/${relative(DIST, file).split('\\').join('/')}`;
            const form = new FormData();
            form.append('name', name);
            form.append('file', new Blob([bytes]), file.split('/').pop());
            await sentry(`/organizations/${org}/releases/${encodeURIComponent(release)}/files/`, {
                method: 'POST',
                body: form,
            });
        }
    }
}

export function deleteMaps(maps) {
    for (const map of maps) unlinkSync(map);
}

async function main() {
    const maps = listMaps();
    if (maps.length === 0) {
        console.log('[sourcemaps] no .map files in dist — nothing to upload or delete');
        return;
    }
    if (!token || !org || !project) {
        console.log(
            `[sourcemaps] SENTRY_AUTH_TOKEN/SENTRY_ORG/SENTRY_PROJECT not set — skipping upload, deleting ${maps.length} map(s)`,
        );
        deleteMaps(maps);
        return;
    }
    try {
        await upload(maps);
        console.log(`[sourcemaps] uploaded ${maps.length} map(s) for ${release}`);
    } finally {
        deleteMaps(maps);
        console.log(`[sourcemaps] deleted ${maps.length} map(s) from dist`);
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error('[sourcemaps]', err.message);
        // A failed upload must not fail the build — but the maps are gone
        // either way (finally above), so nothing ships.
        process.exit(0);
    });
}
