#!/usr/bin/env node
/**
 * mock-signalk-server.js
 * 
 * A lightweight mock Signal K server that serves real NOAA nautical chart tiles
 * for testing the Thalassa Signal K chart integration without a Raspberry Pi.
 * 
 * Usage:  node scripts/mock-signalk-server.js
 * Then:   In Thalassa Settings → Signal K → Host: localhost, Port: 3000 → Connect
 */

const http = require('http');
const https = require('https');

const PORT = 3100;
const HOST = '127.0.0.1';

// ── Chart Definitions ──
// These point to real, free public tile servers
const CHARTS = {
    'osm-nautical': {
        identifier: 'osm-nautical',
        name: 'OpenStreetMap Base',
        description: 'Test chart layer — proves Signal K pipeline is working',
        tilemapUrl: `/tiles/osm-nautical/{z}/{x}/{y}`,
        type: 'tilelayer',
        format: 'png',
        minzoom: 3,
        maxzoom: 18,
        bounds: [-180, -90, 180, 90],
        scale: 1,
    },
    'openseamap': {
        identifier: 'openseamap',
        name: 'OpenSeaMap Seamark Overlay',
        description: 'Community-maintained sea marks, lights, and buoys',
        tilemapUrl: `/tiles/openseamap/{z}/{x}/{y}`,
        type: 'tilelayer',
        format: 'png',
        minzoom: 6,
        maxzoom: 18,
        bounds: [-180, -90, 180, 90],
        scale: 1,
    },
};

// Upstream tile sources (the actual tile servers we proxy)
const TILE_SOURCES = {
    'osm-nautical': 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    'openseamap': 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
};

// ── Signal K API Responses ──
const SIGNALK_DISCOVERY = {
    endpoints: {
        v1: {
            version: '1.46.0',
            'signalk-http': `http://localhost:${PORT}/signalk/v1/api`,
            'signalk-ws': `ws://localhost:${PORT}/signalk/v1/stream`,
        },
    },
    server: {
        id: 'thalassa-mock-signalk',
        version: '1.46.0',
    },
};

function buildChartsResponse() {
    const result = {};
    for (const [id, chart] of Object.entries(CHARTS)) {
        result[id] = {
            identifier: chart.identifier,
            name: chart.name,
            description: chart.description,
            tilemapUrl: chart.tilemapUrl,
            type: chart.type,
            format: chart.format,
            minzoom: chart.minzoom,
            maxzoom: chart.maxzoom,
            bounds: chart.bounds,
            scale: chart.scale,
        };
    }
    return result;
}

// ── Tile Proxy ──
function proxyTile(sourceId, z, x, y, res) {
    const template = TILE_SOURCES[sourceId];
    if (!template) {
        res.writeHead(404);
        res.end('Unknown chart source');
        return;
    }

    const url = template
        .replace('{z}', z)
        .replace('{x}', x)
        .replace('{y}', y);

    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, { 
        headers: { 'User-Agent': 'Thalassa-Mock-SignalK/1.0' },
        timeout: 15000,
    }, (upstream) => {
        if (upstream.statusCode === 200) {
            res.writeHead(200, {
                'Content-Type': upstream.headers['content-type'] || 'image/png',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400',
            });
            upstream.pipe(res);
        } else {
            console.log(`  ⚠️  Tile ${sourceId}/${z}/${x}/${y} → ${upstream.statusCode}`);
            // Return a transparent 1x1 PNG for missing tiles
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
                'Nl7BcQAAAABJRU5ErkJggg==',
                'base64'
            ));
        }
    });
    req.on('error', (err) => {
        console.log(`  ❌ Tile fetch error ${sourceId}/${z}/${x}/${y}: ${err.message}`);
        res.writeHead(500);
        res.end('Tile fetch failed');
    });
    req.on('timeout', () => {
        console.log(`  ⏰ Tile timeout ${sourceId}/${z}/${x}/${y}`);
        req.destroy();
    });
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const path = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Signal K Discovery
    if (path === '/signalk') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(SIGNALK_DISCOVERY));
        console.log('  📡 Discovery endpoint hit');
        return;
    }

    // Signal K API root (version probe)
    if (path === '/signalk/v1/api') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            version: '1.46.0',
            self: 'vessels.self',
            resources: {
                charts: { href: '/signalk/v1/api/resources/charts' }
            }
        }));
        console.log('  📡 API v1 probe — responded OK');
        return;
    }

    // Signal K API — Charts
    if (path === '/signalk/v1/api/resources/charts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildChartsResponse()));
        console.log(`  📡 Chart discovery request — served ${Object.keys(CHARTS).length} charts`);
        return;
    }

    // Signal K API — Individual chart
    const chartMatch = path.match(/^\/signalk\/v1\/api\/resources\/charts\/(.+)$/);
    if (chartMatch) {
        const chartId = chartMatch[1];
        const chart = CHARTS[chartId];
        if (chart) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(chart));
        } else {
            res.writeHead(404);
            res.end('Chart not found');
        }
        return;
    }

    // Tile proxy: /tiles/{source}/{z}/{x}/{y}
    const tileMatch = path.match(/^\/tiles\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)/);
    if (tileMatch) {
        const [, source, z, x, y] = tileMatch;
        proxyTile(source, z, x, y, res);
        return;
    }

    // Health check
    if (path === '/health' || path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <html>
            <head><title>Mock Signal K Server</title></head>
            <body style="background:#0a0f14;color:#94a3b8;font-family:monospace;padding:40px;">
                <h1 style="color:#34d399;">⚓ Mock Signal K Server</h1>
                <p>Running on port ${PORT}</p>
                <h3 style="color:#38bdf8;">Available Endpoints:</h3>
                <ul>
                    <li><a href="/signalk" style="color:#38bdf8;">/signalk</a> — Discovery</li>
                    <li><a href="/signalk/v1/api/resources/charts" style="color:#38bdf8;">/signalk/v1/api/resources/charts</a> — Chart list</li>
                    <li>/tiles/{source}/{z}/{x}/{y} — Tile proxy</li>
                </ul>
                <h3 style="color:#38bdf8;">Available Charts:</h3>
                <ul>
                    ${Object.values(CHARTS).map(c => `<li><strong>${c.name}</strong> — ${c.description}</li>`).join('')}
                </ul>
                <h3 style="color:#34d399;">How to test:</h3>
                <ol>
                    <li>Open Thalassa</li>
                    <li>Go to Settings → Signal K</li>
                    <li>Host: <code>localhost</code>, Port: <code>${PORT}</code></li>
                    <li>Tap Connect</li>
                    <li>Go to MAP → Layer menu → toggle charts on</li>
                </ol>
            </body>
            </html>
        `);
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ⚓ ═══════════════════════════════════════════════════');
    console.log('  ⚓  Mock Signal K Server');
    console.log(`  ⚓  Running on http://localhost:${PORT}`);
    console.log('  ⚓ ═══════════════════════════════════════════════════');
    console.log('');
    console.log('  Available charts:');
    for (const chart of Object.values(CHARTS)) {
        console.log(`    🗺️  ${chart.name}`);
        console.log(`       ${chart.description}`);
        console.log(`       Zoom: ${chart.minzoom}–${chart.maxzoom}`);
    }
    console.log('');
    console.log('  To test in Thalassa:');
    console.log(`    1. Settings → Signal K → Host: localhost, Port: ${PORT}`);
    console.log('    2. Tap Connect');
    console.log('    3. MAP → Layer menu → toggle charts on');
    console.log('');
});
