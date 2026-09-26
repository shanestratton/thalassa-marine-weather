// Walk every screen of the built app in WebKit at phone size; screenshot + aria snapshot +
// an automated scan (small text, tiny targets, overflow, truncation, contrast, unlabelled).
import { webkit } from '/Users/shanestratton/Projects/thalassa-marine-weather/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'http://127.0.0.1:4173';
const OUT = process.argv[2];
const MODE = process.argv[3] || 'dark'; // dark | light
const W = Number(process.argv[4] || 393),
    H = Number(process.argv[5] || 852);
const ONLY = (process.argv[6] || '').split(',').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const settings = {
    defaultLocation: 'Gladstone, QLD',
    displayMode: MODE,
    units: {
        speed: 'kts',
        temp: 'C',
        distance: 'nm',
        length: 'm',
        tideHeight: 'm',
        waveHeight: 'm',
        visibility: 'nm',
        volume: 'l',
    },
    vessel: {
        name: 'Serene Summer',
        type: 'sail',
        length: 42,
        beam: 13,
        draft: 6,
        displacement: 14000,
        cruisingSpeed: 6,
    },
    savedLocations: ['Gladstone, QLD'],
};
const settingsValue = JSON.stringify({ version: 2, owner_user_id: null, settings });
const ls = [
    ['thalassa_disclaimer_v1.0', 'accepted'],
    ['thalassa_v3_onboarded::anonymous', 'true'],
    ['thalassa_install_dismissed', 'true'],
    ['thalassa_chart_key_seen_v1', 'e2e'],
    ['thalassa_settings_mirror::anonymous', settingsValue],
    ['CapacitorStorage.thalassa_settings::anonymous', settingsValue],
];
// Every registered view, plus the two main pages. mob is visited but never armed.
const VIEWS = [
    'dashboard',
    'map',
    'voyage',
    'details',
    'vessel',
    'settings',
    'warnings',
    'chat',
    'voice',
    'music',
    'compass',
    'inventory',
    'maintenance',
    'polars',
    'nmea',
    'glass',
    'avnav',
    'gpx-import',
    'equipment',
    'documents',
    'diary',
    'crew',
    'checklists',
    'guardian',
    'radio',
    'mob',
    'galley',
];
const SETTLE = { dashboard: 5000, map: 5000, voyage: 3000 };

const browser = await webkit.launch();
// Playwright WebKit stamps geolocation fixes in microseconds, so the app read
// every fix as decades in the future and fell back to its no-fix states (UX
// scorecard run 7: the chart opened on the whole continent). A device stamps
// milliseconds; normalise before the app sees it.
const GEO_TIMESTAMP_FIX = () => {
    const g = navigator.geolocation;
    if (!g) return;
    const fix = (cb) => (p) =>
        cb({ coords: p.coords, timestamp: p.timestamp > 1e14 ? Math.floor(p.timestamp / 1000) : p.timestamp });
    const gcp = g.getCurrentPosition.bind(g);
    const wp = g.watchPosition.bind(g);
    g.getCurrentPosition = (ok, err, o) => gcp(fix(ok), err, o);
    g.watchPosition = (ok, err, o) => wp(fix(ok), err, o);
};
const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    geolocation: { latitude: -23.7, longitude: 151.6 },
    permissions: ['geolocation'],
    colorScheme: MODE === 'light' ? 'light' : 'dark',
    storageState: {
        cookies: [],
        origins: [{ origin: ORIGIN, localStorage: ls.map(([name, value]) => ({ name, value })) }],
    },
});
await context.addInitScript(GEO_TIMESTAMP_FIX);
const page = await context.newPage();
const consoleLog = [];
page.on('console', (m) => {
    if (m.type() === 'error') consoleLog.push({ view: current, text: m.text().slice(0, 240) });
});
page.on('pageerror', (e) => consoleLog.push({ view: current, text: 'PAGEERROR ' + String(e).slice(0, 300) }));
let current = 'boot';
await page.goto(ORIGIN + '/');
await page.waitForTimeout(3500);

import { SCAN } from './scan.mjs';

const capture = async (name) => {
    current = name;
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const scan = await page.evaluate(SCAN);
    fs.writeFileSync(path.join(OUT, `${name}.scan.json`), JSON.stringify(scan, null, 1));
    try {
        const aria = await page.locator('body').ariaSnapshot();
        fs.writeFileSync(path.join(OUT, `${name}.aria.txt`), aria.slice(0, 40000));
    } catch (e) {
        fs.writeFileSync(path.join(OUT, `${name}.aria.txt`), 'aria snapshot failed: ' + e);
    }
    return scan;
};
const go = async (view) => {
    await page.evaluate(
        (v) => window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: v } })),
        view,
    );
    await page.waitForTimeout(SETTLE[view] || 2200);
};
const summary = {};
for (const view of VIEWS) {
    if (ONLY.length && !ONLY.includes(view)) continue;
    await go(view);
    summary[view] = await capture(view);
    // Extra states worth scoring.
    if (view === 'map') {
        const fab = page
            .locator("button[aria-label*='ayer'], button[aria-label*='Helm'], button[aria-label*='menu']")
            .first();
        if (await fab.count()) {
            await fab.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1200);
            summary['map-layers'] = await capture('map-layers');
            await page.keyboard.press('Escape').catch(() => {});
            await page.mouse.click(W / 2, H / 2).catch(() => {});
            await page.waitForTimeout(600);
        }
    }
    if (view === 'settings') {
        const tabs = page.getByRole('tab');
        const n = await tabs.count();
        for (let i = 0; i < Math.min(n, 8); i++) {
            const t = tabs.nth(i);
            const label = ((await t.textContent()) || `tab${i}`)
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .slice(0, 20);
            await t.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(900);
            summary[`settings-${label}`] = await capture(`settings-${label}`);
        }
    }
}
fs.writeFileSync(path.join(OUT, '_summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, '_console.json'), JSON.stringify(consoleLog, null, 1));
await browser.close();
console.log('captured', Object.keys(summary).length, 'screens →', OUT);
