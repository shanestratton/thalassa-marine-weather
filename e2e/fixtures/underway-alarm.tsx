/**
 * The under-way alarms, rendered for real (build 126, 126-02a): the app-wide
 * alarm stack (components/map/AisGuardAlert.tsx) with a collision card, a
 * shoal card and an off-route card, in that order. The shoal and off-route
 * words come from the real rule (services/underway/underwayRule.ts) run over
 * fictional readings: Albatross (draft not set) 2.7 m below a transducer, the
 * longest a shoal card says, and Kestrel 0.4 NM off a Solent route. The
 * app's CSS and the real stores; the tab bar's real geometry. No network.
 *
 * ?muted=1: the off-route card muted ('Muted until'). ?notices=1: the strip's
 * two longest words under the cards (not yet on the route, a stale sounder).
 *
 * Fictional vessels only (MID 123 MMSIs): this repository is public.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The under-way alarm fixture is available only through the development server.');

class FixtureStorage implements Storage {
    private entries = new Map<string, string>();
    get length() {
        return this.entries.size;
    }
    clear() {
        this.entries.clear();
    }
    getItem(key: string) {
        return this.entries.get(String(key)) ?? null;
    }
    key(index: number) {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.entries.delete(String(key));
    }
    setItem(key: string, value: string) {
        this.entries.set(String(key), String(value));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Under-way alarm fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
// Verdana on a Mac, DejaVu Sans on the Linux runner: the same wraps on both.
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent =
        ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } body, button { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}

const [{ AisGuardAlert }, { AisGuardAlertStore }, { UnderwayAlarmStore }, rule] = await Promise.all([
    import('../../components/map/AisGuardAlert'),
    import('../../services/aisGuardAlertStore'),
    import('../../services/underway/underwayAlarmStore'),
    import('../../services/underway/underwayRule'),
]);

const now = Date.now();

AisGuardAlertStore.setCollision(
    [
        {
            mmsi: 123400311,
            name: 'FICTIONAL CONTAINER CARRIER',
            distanceNm: 0.31,
            bearing: 44,
            sog: 18.4,
            cog: 231,
            shipType: '70',
            timestamp: now,
            collision: { cpaNm: 0.04, tcpaMin: 1.1, closeQuarters: true, reportAgeSec: 6, source: 'local' },
        },
    ],
    now,
);

// Albatross, draft not set, 2.7 m below a transducer: three live readings.
let shoal = rule.SHOAL_START;
for (let i = 0; i < 3; i++) {
    shoal = rule.nextShoalState(shoal, {
        underWay: true,
        boatFeed: true,
        depthM: 2.7,
        reference: 'below-transducer',
        freshness: 'live',
        readingAt: now - (3 - i) * 2_000,
        draftM: 2.5,
        draftAssumed: true,
        marginM: 0.5,
    });
}

// Kestrel, 0.4 NM off a Solent leg, on two fixes 10 s apart after being on the route.
let xte = rule.XTE_START;
for (const [at, off] of [
    [now - 30_000, 0.05],
    [now - 20_000, 0.4],
    [now - 10_000, 0.4],
] as const) {
    xte = rule.nextXteState(xte, { fixAt: at, offTrackNm: off, limitNm: 0.25, offshore: false, still: false });
}
if (params.get('muted') === '1') xte = rule.muteXte(xte, now);

UnderwayAlarmStore.set(
    [
        { kind: 'shoal', ...rule.shoalLines(shoal), sounding: rule.shoalAudible(shoal), mutedUntil: null },
        {
            kind: 'off-route',
            ...rule.offRouteLines(xte),
            sounding: rule.xteAudible(xte, now),
            mutedUntil: xte.mutedUntil,
        },
    ],
    params.get('notices') === '1' ? [rule.UNDERWAY_NOTICES.arming, rule.UNDERWAY_NOTICES.shoalStale] : [],
);

function Fixture() {
    return (
        <main className="min-h-screen bg-slate-950 p-4 text-white">
            <h1 className="text-lg font-bold">Chart</h1>
            <AisGuardAlert />
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row
                above the home-indicator inset, opaque. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span className="text-sky-300">OBS</span>
                    <span>PLAN</span>
                    <span>VESSEL</span>
                </div>
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
