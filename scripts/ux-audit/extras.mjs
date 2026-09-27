// Second pass: the screens the view walk cannot reach — settings sub-pages, the Glass's sheets,
// the chart's pickers, the Log/Plan menus, the passage strip, onboarding, landscape.
import { webkit } from '/Users/shanestratton/Projects/thalassa-marine-weather/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { SCAN } from './scan.mjs';

const ORIGIN = 'http://127.0.0.1:4173';
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

const OUT = process.argv[2];
const MODE = process.argv[3] || 'dark';
fs.mkdirSync(OUT, { recursive: true });
const SECTIONS = process.argv[4] || 'ABCD';
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
const now = new Date().toISOString();
const follow = {
    isFollowing: true,
    voyageId: 'ux-1',
    voyagePlan: { origin: 'Gladstone', destination: 'Mackay', waypoints: [], departureDate: now },
    routeCoords: [
        { lat: -23.85, lon: 151.45 },
        { lat: -23.3, lon: 151.95 },
        { lat: -22.0, lon: 151.0 },
        { lat: -21.05, lon: 149.6 },
    ],
    startedAt: now,
    lastRefresh: now,
};
const base = [
    ['thalassa_disclaimer_v1.0', 'accepted'],
    ['thalassa_v3_onboarded::anonymous', 'true'],
    ['thalassa_install_dismissed', 'true'],
    ['thalassa_chart_key_seen_v1', 'e2e'],
    ['thalassa_settings_mirror::anonymous', settingsValue],
    ['CapacitorStorage.thalassa_settings::anonymous', settingsValue],
];
const withStrip = [
    ...base,
    ['thalassa_passage_hud_enabled_v1', '1'],
    ['thalassa_passage_hud_open_v1', '1'],
    ['thalassa_follow_route::anonymous', JSON.stringify(follow)],
];

const summaryPrev = {};
const browser = await webkit.launch();
const summary = summaryPrev;
if (fs.existsSync(path.join(OUT, '_summary.json')))
    Object.assign(summary, JSON.parse(fs.readFileSync(path.join(OUT, '_summary.json'), 'utf8')));
const consoleLog = [];
let current = '';
const ctx = async (ls, viewport) => {
    const c = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        // Gladstone Marina, matching the seeded home port: now that fixes are
        // accepted (the timestamp fix), an offshore point switched the Glass to
        // its offshore model and a coordinate name.
        geolocation: { latitude: -23.8434, longitude: 151.2553 },
        permissions: ['geolocation'],
        colorScheme: MODE === 'light' ? 'light' : 'dark',
        storageState: {
            cookies: [],
            origins: [{ origin: ORIGIN, localStorage: ls.map(([name, value]) => ({ name, value })) }],
        },
    });
    await c.addInitScript(GEO_TIMESTAMP_FIX);
    const p = await c.newPage();
    p.on('console', (m) => {
        if (m.type() === 'error') consoleLog.push({ view: current, text: m.text().slice(0, 240) });
    });
    p.on('pageerror', (e) => consoleLog.push({ view: current, text: 'PAGEERROR ' + String(e).slice(0, 300) }));
    await p.goto(ORIGIN + '/');
    await p.waitForTimeout(3500);
    return { c, p };
};
const capture = async (p, name) => {
    current = name;
    await p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const scan = await p.evaluate(SCAN);
    fs.writeFileSync(path.join(OUT, `${name}.scan.json`), JSON.stringify(scan, null, 1));
    try {
        fs.writeFileSync(path.join(OUT, `${name}.aria.txt`), (await p.locator('body').ariaSnapshot()).slice(0, 40000));
    } catch {}
    summary[name] = scan;
};
const go = async (p, view, ms = 2200) => {
    await p.evaluate((v) => window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: v } })), view);
    await p.waitForTimeout(ms);
};
const tap = async (p, name, ms = 1200) => {
    const b = p.getByRole('button', { name, exact: false }).first();
    if (!(await b.count())) return false;
    await b.click({ timeout: 2500 }).catch(() => {});
    await p.waitForTimeout(ms);
    return true;
};
const scrollEnd = async (p) => {
    await p.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20)
                el.scrollTop = el.scrollHeight;
        }
        window.scrollTo(0, document.body.scrollHeight);
    });
    await p.waitForTimeout(600);
};
const dismiss = async (p) => {
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(400);
};

// A: portrait, main flows
if (SECTIONS.includes('A')) {
    const { c, p } = await ctx(base, { width: 393, height: 852 });
    // Settings sub-pages
    for (const row of [
        'Preferences',
        'Vessel Profile',
        'Locations',
        'Notifications',
        'Account & Cloud',
        'Voyage Log',
    ]) {
        await go(p, 'settings', 1500);
        if (await tap(p, `Open ${row} settings`, 1500)) {
            const slug = row.toLowerCase().replace(/[^a-z]+/g, '-');
            await capture(p, `settings-${slug}`);
            // Long pages: a second shot scrolled to the bottom shows the tail.
            await scrollEnd(p);
            await capture(p, `settings-${slug}-end`);
            // The tab screens use PageHeader: the 'Go back' chevron. The old
            // 'Back to Settings' crumb is now the title caption, not a button.
            await tap(p, 'Go back', 900);
        }
    }
    // The Glass's sheets
    await go(p, 'dashboard', 4000);
    if (await tap(p, 'Open rain forecast detail')) {
        await capture(p, 'glass-rain-detail');
        await dismiss(p);
    }
    if (await tap(p, /^Temperature.*Tap to pin/)) {
        await capture(p, 'glass-pin-sheet');
        await dismiss(p);
    }
    // The model pill by its name, whichever model the Glass opens on.
    const model = p.getByRole('button', { name: /forecast model/i }).first();
    if (await model.count()) {
        await model.click({ timeout: 2000 }).catch(() => {});
        await p.waitForTimeout(1200);
        await capture(p, 'glass-model-picker');
        await dismiss(p);
    }
    if (await tap(p, 'Systems and GPS source')) {
        await capture(p, 'glass-system-status');
        await dismiss(p);
    }
    if (await tap(p, 'Saved locations')) {
        await capture(p, 'glass-saved-locations');
        await dismiss(p);
    }
    await go(p, 'dashboard', 800);
    await scrollEnd(p);
    await capture(p, 'dashboard-end');
    // Chart pickers
    await go(p, 'map', 4500);
    if (await tap(p, 'Map base:')) {
        await capture(p, 'map-base-picker');
        await dismiss(p);
    }
    if (await tap(p, 'Locate me', 1500)) {
        await capture(p, 'map-located');
    }
    // Log + Plan menus
    await go(p, 'details', 2500);
    if (await tap(p, 'Page actions')) {
        await capture(p, 'log-menu');
        await dismiss(p);
    }
    if (await tap(p, 'Voyage stats')) {
        await capture(p, 'log-voyage-stats');
        await dismiss(p);
    }
    await go(p, 'voyage', 3000);
    // The Plan kebab is named after its page since run 6.
    if ((await tap(p, 'Route Planner actions', 900)) || (await tap(p, 'Page actions', 900))) {
        await capture(p, 'plan-actions');
        await dismiss(p);
    }
    if (await tap(p, 'Saved routes')) {
        await capture(p, 'plan-saved-routes');
        await dismiss(p);
    }
    await go(p, 'voyage', 800);
    await scrollEnd(p);
    await capture(p, 'voyage-end');
    // Vessel hub: expand the two collapsed sections
    await go(p, 'vessel', 2000);
    // The one collapsed Vessel group since run 7 (Settings is always shown and
    // Music moved into this group). Anchored, so it hits the section header.
    for (const sec of ['Connections & music']) {
        const b = p.getByRole('button', { name: new RegExp('^' + sec + '$', 'i') }).first();
        if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {});
        await p.waitForTimeout(600);
    }
    await capture(p, 'vessel-expanded');
    await scrollEnd(p);
    await capture(p, 'vessel-expanded-end');
    await c.close();
}
// B: the passage strip, live and looking ahead
if (SECTIONS.includes('B')) {
    const { c, p } = await ctx(withStrip, { width: 393, height: 852 });
    await go(p, 'map', 5000);
    await p.waitForTimeout(4000);
    await capture(p, 'map-strip-live');
    const look = p.getByTestId('hud-look-ahead');
    if ((await look.count()) && !(await look.isDisabled())) {
        await look.click();
        await p.waitForTimeout(4000);
        await capture(p, 'map-strip-ahead');
        const m = p.getByTestId('route-scrub-model');
        if (await m.count()) {
            await m.click();
            await p.waitForTimeout(900);
            await capture(p, 'map-strip-model-dialog');
            await dismiss(p);
        }
    }
    await c.close();
}
// C: onboarding, from nothing
if (SECTIONS.includes('C')) {
    const { c, p } = await ctx([['thalassa_install_dismissed', 'true']], { width: 393, height: 852 });
    await capture(p, 'onboarding-0');
    for (let i = 1; i <= 10; i++) {
        await scrollEnd(p);
        const buttons = p.getByRole('button');
        const n = await buttons.count();
        let pick = null,
            label = '';
        for (let k = n - 1; k >= 0; k--) {
            const b = buttons.nth(k);
            const name = ((await b.getAttribute('aria-label')) || (await b.textContent()) || '').trim();
            if (!name || /skip to main|back|system status|close|dismiss/i.test(name)) continue;
            if (!(await b.isVisible().catch(() => false)) || (await b.isDisabled().catch(() => true))) continue;
            pick = b;
            label = name.slice(0, 40);
            break;
        }
        if (!pick) break;
        await pick.click({ timeout: 2500 }).catch(() => {});
        await p.waitForTimeout(1400);
        await capture(p, `onboarding-${i}`);
        summary[`onboarding-${i}`].clicked = label;
        // Onboarding is over once the tab bar is up.
        if (await p.getByRole('navigation', { name: 'Main', exact: true }).first().count()) break;
    }
    await c.close();
}
// D: landscape phone
if (SECTIONS.includes('D')) {
    const { c, p } = await ctx(base, { width: 852, height: 393 });
    await go(p, 'dashboard', 3500);
    await capture(p, 'land-dashboard');
    await go(p, 'map', 4500);
    await capture(p, 'land-map');
    await go(p, 'voyage', 2500);
    await capture(p, 'land-voyage');
    await go(p, 'compass', 2000);
    await capture(p, 'land-compass');
    await c.close();
}
fs.writeFileSync(path.join(OUT, '_summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, '_console.json'), JSON.stringify(consoleLog, null, 1));
await browser.close();
console.log('captured', Object.keys(summary).length, 'extra screens →', OUT);
