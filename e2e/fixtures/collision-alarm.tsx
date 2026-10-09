/**
 * The collision alarm, rendered for real (build 125, 125-01): the app-wide
 * card stack (components/map/AisGuardAlert.tsx) with a close-quarters card, a
 * network-AIS DANGER card, a lost contact (CPA UNKNOWN), a guard-ring card and
 * a watch notice ('blind', or ?notice= another, e.g. the longest, or 125-01b's
 * 'stopped' at a berth, 'stopped-elsewhere', 'at-anchor' and 'blind-at-anchor'); or
 * (?view=check) the sound check the shield opens before arming. The app's CSS
 * and the real stores; the tab bar's real geometry. No network.
 *
 * Build 126 (126-04a): ?pi=1 adds an alarm the Pi raised that this phone has
 * not carded (a card 'from the Pi'); ?view=key renders the chart's AIS key
 * (components/map/AisLegend.tsx, embedded as the layer key embeds it) with the
 * shield armed and a paired Pi watching too, so the 'who is watching' row
 * shows under the shield. &key=anchor: at anchor on this phone while the Pi
 * keeps no anchor watch (the amber row asking for the hand-over);
 * &key=standdown: this phone's shield off while the Pi watches (the row's
 * 'Stand the Pi down' for everyone).
 *
 * Fictional vessels only (MID 123 MMSIs): this repository is public.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The collision-alarm fixture is available only through the development server.');

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
    new Response(JSON.stringify({ error: 'Collision-alarm fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
// Verdana on a Mac, DejaVu Sans on the Linux runner: the same wraps on both.
if (params.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent =
        ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } body, button { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}

const [
    { AisGuardAlert },
    { SoundCheckModal },
    { AisGuardAlertStore },
    { AisLegend },
    { AisGuardZone },
    { PiNightWatchStatus },
] = await Promise.all([
    import('../../components/map/AisGuardAlert'),
    import('../../components/anchor-watch/SoundCheckModal'),
    import('../../services/aisGuardAlertStore'),
    import('../../components/map/AisLegend'),
    import('../../services/AisGuardZone'),
    import('../../services/piNightWatchStatus'),
]);

const now = Date.now();
const view = params.get('view');

/** The Pi's own ais_watch, as its /api/telemetry hands it over (pi-cache/src/aisWatch.ts). */
function piSays(alarms: unknown[], atAnchor = false) {
    PiNightWatchStatus.setPaired(true);
    PiNightWatchStatus.ingestLan(
        {
            v: 1,
            state: 'armed',
            armed: true,
            armedAt: now - 3_600_000,
            lastPassAt: now - 1_000,
            servedAt: now,
            atAnchor,
            own: 'stopped',
            devices: 1,
            alarms,
        },
        { nowMs: now, answeredVia: 'lan-host' },
    );
}

if (view === 'key') {
    const key = params.get('key');
    if (key !== 'standdown') AisGuardZone.armAfterSoundCheck();
    piSays([], key !== 'anchor');
    // As services/piNightWatch.ts does while it runs.
    if (key === 'anchor') PiNightWatchStatus.setPhoneAnchorWatch('at-anchor');
    if (key === 'standdown') {
        PiNightWatchStatus.setStandDownHandler(() => {
            document.body.dataset.piStoodDown = 'yes';
        });
    }
}

if (params.get('pi') === '1') {
    piSays([
        {
            key: `close-quarters:123400309:${now - 40_000}`,
            kind: 'close-quarters',
            mmsi: 123400309,
            name: 'FICTIONAL FAST FERRY WITH A LONG NAME',
            cpaNm: 0.03,
            tcpaMin: 1.6,
            rangeNm: 0.42,
            bearingDeg: 351,
            lat: null,
            lon: null,
            raisedAt: now - 40_000,
            ackedAt: null,
        },
    ]);
}

if (view !== 'check' && view !== 'key') {
    const notice = (params.get('notice') ?? 'blind') as
        | 'blind'
        | 'unchecked'
        | 'no-motion'
        | 'stopped'
        | 'stopped-elsewhere'
        | 'at-anchor'
        | 'blind-at-anchor';
    AisGuardAlertStore.setWatchNotice({ state: notice, since: now });
    AisGuardAlertStore.setCollision(
        [
            {
                mmsi: 123400301,
                name: 'FICTIONAL CONTAINER CARRIER',
                distanceNm: 0.31,
                bearing: 44,
                sog: 18.4,
                cog: 231,
                shipType: '70',
                timestamp: now,
                collision: { cpaNm: 0.04, tcpaMin: 1.1, closeQuarters: true, reportAgeSec: 6, source: 'local' },
            },
            {
                mmsi: 123400302,
                name: 'FICTIONAL TUG WITH A LONG NAME',
                distanceNm: 2.6,
                bearing: 312,
                sog: 9.1,
                cog: 120,
                shipType: '52',
                timestamp: now,
                collision: { cpaNm: 0.35, tcpaMin: 12.4, closeQuarters: false, reportAgeSec: 240, source: 'cloud' },
            },
            {
                mmsi: 123400304,
                name: 'FICTIONAL COASTER OF SOMEWHERE FAR',
                distanceNm: 1.2,
                bearing: 98,
                sog: 11,
                cog: 275,
                shipType: '70',
                timestamp: now,
                collision: {
                    cpaNm: 0.12,
                    tcpaMin: 6.5,
                    closeQuarters: false,
                    reportAgeSec: 640,
                    source: 'local',
                    lost: { reason: 'report-too-old', sinceMs: now - 30_000, lastCpaAt: now - 130_000 },
                },
            },
        ],
        now,
    );
    window.dispatchEvent(
        new CustomEvent('ais-guard-alert', {
            detail: [
                {
                    mmsi: 123400303,
                    name: 'FICTIONAL DRIFTER',
                    distanceNm: 1.8,
                    bearing: 175,
                    sog: null,
                    cog: null,
                    shipType: '0',
                    timestamp: now,
                },
            ],
        }),
    );
}

function Fixture() {
    return (
        <main className="min-h-screen bg-slate-950 p-4 text-white">
            <h1 className="text-lg font-bold">Chart</h1>
            {view === 'check' ? (
                <SoundCheckModal purpose="collision" onConfirm={() => undefined} onCancel={() => undefined} />
            ) : view === 'key' ? (
                // As the chart's layer key embeds it (components/map/ObsLayerKey.tsx), in a panel of its width.
                <section
                    aria-label="AIS key"
                    data-testid="ais-key-panel"
                    className="mt-4 space-y-2 rounded-2xl border border-white/10 bg-slate-900/90 p-3 text-xs leading-relaxed text-slate-300"
                    style={{ width: 'calc(100vw - 32px)', maxWidth: 380 }}
                >
                    <h3 className="font-bold text-sky-200">AIS</h3>
                    <AisLegend visible embedded />
                </section>
            ) : (
                <AisGuardAlert />
            )}
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
