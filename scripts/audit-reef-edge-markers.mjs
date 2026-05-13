#!/usr/bin/env node
/**
 * audit-reef-edge-markers.mjs — find candidates for `_class: 'isolated'` retag
 *
 * The inshore router pairs port/starboard markers into channel midpoints and
 * generates FAIRWY ribbons between them. Reef-edge markers tagged as 'starboard'
 * or 'port' get sucked into this pipeline incorrectly — they become "fake
 * channel" endpoints and A* routes right through the reef they're supposed to
 * protect (Scarborough Reef beacon was the canonical case before we retagged
 * it 2026-05-13).
 *
 * This script downloads the live nav_markers.geojson from Supabase, runs the
 * same clustering + pairing logic the iOS router uses, and lists every
 * port/starboard marker that DIDN'T pair. These are the strongest candidates
 * for "should actually be 'isolated' (reef-edge), not a channel side":
 *
 *   - Genuine solo reef-edge markers (the ones we want to retag)
 *   - Markers in narrow chains where the partner is just out of reach
 *   - Markers where the partner exists but happens to be > PAIR_MAX_DIST_M away
 *
 * Output is a sortable table you can cross-reference against Navionics or
 * AHO charts. For each one, decide: real channel marker or hazard? If hazard,
 * retag _class from 'starboard'/'port' to 'isolated' in Supabase.
 *
 * Usage:
 *   node scripts/audit-reef-edge-markers.mjs
 *   node scripts/audit-reef-edge-markers.mjs --json   # machine-readable
 *   node scripts/audit-reef-edge-markers.mjs --region au_se_qld
 *
 * No Supabase credentials needed — reads from the public storage bucket.
 */

import { writeFile } from 'node:fs/promises';

const SUPABASE_URL = 'https://pcisdplnodrphauixcau.supabase.co';
const REGIONS = {
    au_se_qld: 'australia_se_qld',
};

// Keep these in lockstep with services/InshoreRouter.ts.
const CLUSTER_LINK_M = 350;
const PAIR_MAX_DIST_M = 600;

// ── CLI parsing ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
    region: 'au_se_qld',
    json: false,
};
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--region') flags.region = args[++i];
    else if (args[i] === '--json') flags.json = true;
    else if (args[i] === '--help' || args[i] === '-h') {
        console.log(
            'Usage: node scripts/audit-reef-edge-markers.mjs [--region au_se_qld] [--json]\n\n' +
                'Lists solo (unpaired) port/starboard markers — reef-edge candidates for retag.',
        );
        process.exit(0);
    }
}
const regionSlug = REGIONS[flags.region];
if (!regionSlug) {
    console.error(`Unknown region: ${flags.region}. Known: ${Object.keys(REGIONS).join(', ')}`);
    process.exit(1);
}

// ── Haversine ────────────────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6_371_000;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dphi = ((lat2 - lat1) * Math.PI) / 180;
    const dlam = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── BFS clustering (matches clusterMarkers in InshoreRouter.ts) ──
function clusterMarkers(markers, linkM) {
    const n = markers.length;
    const visited = new Uint8Array(n);
    const clusters = [];
    for (let i = 0; i < n; i++) {
        if (visited[i]) continue;
        visited[i] = 1;
        const queue = [i];
        const cluster = [];
        while (queue.length) {
            const k = queue.shift();
            cluster.push(k);
            const mi = markers[k];
            for (let j = 0; j < n; j++) {
                if (visited[j]) continue;
                const mj = markers[j];
                if (haversineM(mi.lat, mi.lon, mj.lat, mj.lon) <= linkM) {
                    visited[j] = 1;
                    queue.push(j);
                }
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
    const url = `${SUPABASE_URL}/storage/v1/object/public/regions/${regionSlug}/nav_markers.geojson?bust=${Date.now()}`;
    if (!flags.json) console.error(`Fetching ${url}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching nav_markers`);
    const data = await res.json();

    const markers = [];
    for (const f of data.features ?? []) {
        if (f?.geometry?.type !== 'Point' || !f.geometry.coordinates) continue;
        const [lon, lat] = f.geometry.coordinates;
        const cls = f.properties?._class ?? '';
        if (cls === 'port' || cls === 'starboard') {
            markers.push({ lat, lon, kind: cls, props: f.properties ?? {} });
        }
    }
    if (!flags.json) {
        console.error(
            `Loaded ${markers.length} lateral markers (port + starboard) from ${data.features?.length ?? 0} total features.`,
        );
    }

    const clusters = clusterMarkers(markers, CLUSTER_LINK_M);

    // Pair within each cluster: same greedy port-starboard matching as InshoreRouter.
    const paired = new Set();
    let pairCount = 0;
    for (const cluster of clusters) {
        const ports = cluster.filter((idx) => markers[idx].kind === 'port');
        const stbds = cluster.filter((idx) => markers[idx].kind === 'starboard');
        const stbdAvail = new Set(stbds);
        for (const pIdx of ports) {
            const p = markers[pIdx];
            let bestSIdx = -1;
            let bestDist = Infinity;
            for (const sIdx of stbdAvail) {
                const s = markers[sIdx];
                const d = haversineM(p.lat, p.lon, s.lat, s.lon);
                if (d < bestDist && d <= PAIR_MAX_DIST_M) {
                    bestDist = d;
                    bestSIdx = sIdx;
                }
            }
            if (bestSIdx >= 0) {
                paired.add(pIdx);
                paired.add(bestSIdx);
                stbdAvail.delete(bestSIdx);
                pairCount++;
            }
        }
    }

    // Find every solo marker + extra context for review.
    const solos = [];
    const byClusterId = new Map();
    clusters.forEach((cluster, id) => cluster.forEach((idx) => byClusterId.set(idx, id)));
    for (let i = 0; i < markers.length; i++) {
        if (paired.has(i)) continue;
        const m = markers[i];
        const clusterId = byClusterId.get(i);
        const cluster = clusters[clusterId];
        // Nearest opposite-kind marker (might be > PAIR_MAX_DIST and so didn't pair)
        let nearestOppDist = Infinity;
        let nearestOppLatLon = null;
        for (const j of cluster) {
            if (j === i) continue;
            const other = markers[j];
            if (other.kind === m.kind) continue;
            const d = haversineM(m.lat, m.lon, other.lat, other.lon);
            if (d < nearestOppDist) {
                nearestOppDist = d;
                nearestOppLatLon = `${other.lat.toFixed(4)},${other.lon.toFixed(4)}`;
            }
        }
        solos.push({
            lat: m.lat,
            lon: m.lon,
            kind: m.kind,
            clusterId,
            clusterSize: cluster.length,
            nearestOppDistM: Number.isFinite(nearestOppDist) ? Math.round(nearestOppDist) : null,
            nearestOpp: nearestOppLatLon,
            name: m.props.name ?? m.props['seamark:name'] ?? null,
            osmType: m.props.type ?? null,
        });
    }

    if (!flags.json) {
        console.error(`Paired: ${pairCount * 2} markers (${pairCount} pairs).`);
        console.error(`Solo (unpaired) lateral markers: ${solos.length}. These are reef-edge candidates.\n`);
    }

    // Sort: solo markers in singleton clusters first (highest confidence
    // they're standalone hazards), then by descending shore-isolation
    // (nearestOppDist desc = no plausible partner = more likely solo).
    solos.sort((a, b) => {
        if (a.clusterSize !== b.clusterSize) return a.clusterSize - b.clusterSize;
        const an = a.nearestOppDistM ?? Infinity;
        const bn = b.nearestOppDistM ?? Infinity;
        return bn - an;
    });

    if (flags.json) {
        process.stdout.write(JSON.stringify(solos, null, 2) + '\n');
        return;
    }

    // Human-readable table
    const header = ['#', 'lat', 'lon', 'kind', 'cluster', 'size', 'oppDist', 'name', 'osmType'];
    const rows = solos.map((s, i) => [
        String(i + 1),
        s.lat.toFixed(4),
        s.lon.toFixed(4),
        s.kind,
        String(s.clusterId),
        String(s.clusterSize),
        s.nearestOppDistM == null ? '-' : `${s.nearestOppDistM}m`,
        (s.name ?? '').slice(0, 30),
        (s.osmType ?? '').slice(0, 18),
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const pad = (s, i) => s.padEnd(widths[i]);
    console.log(header.map(pad).join('  '));
    console.log(widths.map((w) => '─'.repeat(w)).join('──'));
    for (const r of rows) console.log(r.map(pad).join('  '));

    console.log(
        `\nNext step: open each in Navionics. If it's a reef-edge / isolated danger, retag\n` +
            `\`_class\` from \`${'<port|starboard>'}\` to \`isolated\` in Supabase.`,
    );
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
