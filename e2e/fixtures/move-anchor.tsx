import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import type { RemoteFeed } from '../../services/NmeaStore';
import '../../index.css';

if (!import.meta.env.DEV) throw new Error('The move-anchor fixture is available only through the development server.');

// Isolation BEFORE any application service loads: page-only storage, and no
// network at all. The watch itself is a fictional one off Marseille.
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
    new Response(JSON.stringify({ error: 'Move-anchor fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
// Large text: the root size the Shore Watch and draft fixtures use for the same check.
document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';

// A real browser shows no mobile keyboard under automation. Model the visual
// viewport (as e2e/fixtures/keyboard.tsx does) with the real app CSS and the
// real app-wide keyboard guard, and paint the keyboard so hit-tests see it.
const viewport = new EventTarget();
const keyboardCover = document.createElement('div');
keyboardCover.textContent = 'Keyboard (simulated)';
keyboardCover.setAttribute('data-testid', 'keyboard');
Object.assign(keyboardCover.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    right: '0',
    height: '0',
    display: 'none',
    background: '#334155',
    color: '#cbd5e1',
    textAlign: 'center',
    paddingTop: '20px',
    zIndex: '2147483647',
});
document.body.append(keyboardCover);
Object.assign(viewport, { height: window.innerHeight, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
window.addEventListener('test:keyboard', ((event: CustomEvent<number>) => {
    Object.assign(viewport, { height: window.innerHeight - event.detail });
    keyboardCover.style.height = `${event.detail}px`;
    keyboardCover.style.display = event.detail ? 'block' : 'none';
    viewport.dispatchEvent(new Event('resize'));
}) as EventListener);

const [
    { initGlobalKeyboardScroll },
    { MoveAnchorSheet },
    { AnchorAlarmOverlay },
    { NmeaStore },
    service,
    settingsModule,
    { destinationPoint },
    { judgeLateSet },
] = await Promise.all([
    import('../../utils/keyboardScroll'),
    import('../../components/anchor-watch/MoveAnchorSheet'),
    import('../../components/anchor-watch/AnchorAlarmOverlay'),
    import('../../services/NmeaStore'),
    import('../../services/AnchorWatchService'),
    import('../../stores/settingsStore'),
    import('../../utils/navigationCalculations'),
    import('../../services/anchorLateSet'),
]);
initGlobalKeyboardScroll();

await settingsModule.awaitSettingsLoaded();
const settings = settingsModule.useSettingsStore.getState().settings;
settingsModule.useSettingsStore.setState({
    settings: { ...settings, units: { ...settings.units, length: params.get('units') === 'ft' ? 'ft' : 'm' } },
});

// The boat's true heading, 3 s old, so the bearing prefills as it would aboard,
// and the instruments keep sending it (the sheet stops using a heading more
// than 10 s old, and a slow browser run can take that long).
const heading = NmeaStore.getState().headingTrue;
heading.value = 212;
heading.lastUpdated = Date.now() - 3_000;
window.setInterval(() => {
    heading.lastUpdated = Date.now() - 3_000;
}, 1_000);

// The watch was armed at the boat, so the anchor sits under her: the late-set case.
const boat = { latitude: 43.295, longitude: 5.36 };
const config = { rodeLength: 40, waterDepth: 8, scopeRatio: 5, rodeType: 'chain' as const, safetyMargin: 10 };
// &antenna (126-07c): the boat's own GPS marked the anchor, its antenna 12 m
// aft of the bow (Settings → Vessel), with a heading: the circle allows the
// 12 m once, and the sheet's distance is her lie plus those 12 m, and says so.
const antenna = params.has('antenna');
if (antenna) {
    const current = settingsModule.useSettingsStore.getState().settings;
    settingsModule.useSettingsStore.setState({
        settings: {
            ...current,
            vessel: { ...current.vessel!, name: 'Kotare', type: 'sail', length: 14 / 0.3048, gpsToBow: 39.37 },
        },
    });
}
const antennaConfig = { ...config, antennaAllowanceM: 12 };
const watchSnapshot: AnchorWatchSnapshot = {
    state: 'watching',
    anchorPosition: { ...boat, timestamp: Date.now() - 600_000 },
    vesselPosition: { ...boat, accuracy: 4, heading: 212, speed: 0, timestamp: Date.now() },
    swingRadius: service.calculateSwingRadius(config),
    distanceFromAnchor: 0,
    maxDistanceRecorded: 3,
    bearingToAnchor: 0,
    config,
    positionHistory: [],
    alarmTriggeredAt: null,
    alarmCause: null,
    watchStartedAt: Date.now() - 600_000,
    gpsAccuracy: 4,
    gpsQuality: 'standard',
    gpsQualityLabel: 'Standard GPS',
    guardianStatus: 'idle',
    setupError: null,
    ...(antenna
        ? {
              gpsSource: 'nmea' as const,
              config: antennaConfig,
              swingRadius: service.calculateSwingRadius(antennaConfig),
          }
        : {}),
};

// ?mode=pi: the same boat, her watch kept by the Pi and moved from Shore Watch
// (build 126, 126-07a). The Pi's report fills the sheet: her fix, the circle,
// the rode. &ashore=1: the phone reaches the Pi over its VPN, so the sheet adds
// the caution line and the heading reads "via the cloud". &piAnswer=refused or
// unknown: the Pi says no, or nothing answers (the longest lines the sheet
// shows); otherwise it says yes and its next report, a second later, shows the
// new point.
const piMode = params.get('mode') === 'pi';
const ashore = params.has('ashore');
const piAnswer = params.get('piAnswer');
if (piMode) {
    const remote: RemoteFeed = {
        source: 'pi',
        via: ashore ? 'cloud' : 'lan',
        deviceLabel: null,
        reportedAt: Date.now(),
        receivedAt: Date.now(),
    };
    NmeaStore.getState().remote = remote;
}

// ?alarm: the same boat with the drag alarm sounding (build 125, 125-03). The
// watch was armed 33 m off the real anchor; a 120° wind shift over 16 minutes
// swung her round it and out of that circle. Her trail fits the swing, so the
// sheet, opened from the alarm screen, offers to move the mark and stop it.
// &restarted: the app restarted five minutes ago, so this phone has only four
// minutes of her track before the alarm: the longest refusal the sheet shows.
const alarm = params.has('alarm');
const restarted = params.has('restarted');
const lie = Math.sqrt(40 ** 2 - 8 ** 2) * 0.85;
const toward = (from: { latitude: number; longitude: number }, bearingDeg: number, metres: number) => {
    const p = destinationPoint(from.latitude, from.longitude, bearingDeg, metres / 1852);
    return { latitude: p.lat, longitude: p.lon };
};
const realAnchor = toward(boat, 212, lie);
const setAt = toward(realAnchor, 272, lie);
const trailStart = Date.now() - 30 * 60_000;
const trail = Array.from({ length: 451 }, (_, i) => {
    const minutes = (i * 4) / 60;
    const swung = minutes < 14 ? 0 : (120 * (minutes - 14)) / 16;
    return {
        ...toward(realAnchor, 272 + swung, lie),
        accuracy: 4,
        heading: 212,
        speed: 0,
        timestamp: trailStart + i * 4_000,
    };
});
const snapshot: AnchorWatchSnapshot = alarm
    ? {
          ...watchSnapshot,
          state: 'alarm',
          alarmCause: 'drag',
          alarmTriggeredAt: Date.now() - 60_000,
          anchorPosition: { ...setAt, timestamp: trailStart },
          watchStartedAt: trailStart,
          positionHistory: trail,
          distanceFromAnchor: 57.7,
          maxDistanceRecorded: 57.7,
          bearingToAnchor: 152,
      }
    : watchSnapshot;

// The watch is the service's to move; here it only records what it was asked.
const fixture = { moves: [] as Array<[number, number]> };
Object.assign(window, { __moveAnchorFixture: fixture });
service.AnchorWatchService.relocateAnchor = async (lat: number, lon: number) => {
    fixture.moves.push([lat, lon]);
    return { ok: true };
};
service.AnchorWatchService.relocateAnchorFromAlarm = async (lat: number, lon: number) => {
    fixture.moves.push([lat, lon]);
    return { ok: true };
};
// The live verdict is the real judgement on the fixture's track; the boat holds
// where the track ends.
service.AnchorWatchService.checkMoveFromAlarm = (lat: number, lon: number) =>
    judgeLateSet({
        now: Date.now(),
        fix: { ...boat, accuracy: 4, timestamp: Date.now() },
        target: { latitude: lat, longitude: lon },
        setAt,
        watchStartedAt: trailStart,
        alarmAt: snapshot.alarmTriggeredAt,
        rodeLength: config.rodeLength,
        waterDepth: config.waterDepth,
        swingRadiusM: snapshot.swingRadius,
        trail: restarted ? trail.filter((p) => p.timestamp >= trailStart + 25 * 60_000) : trail,
    });

function Fixture() {
    const [open, setOpen] = useState(false);
    const [outcome, setOutcome] = useState('waiting');
    // Pi mode: where the Pi says it is watching. Its report follows a yes.
    const [piAnchor, setPiAnchor] = useState<{ latitude: number; longitude: number }>(boat);
    // The boat's GPS keeps reporting, as it does aboard: the sheet waits for a
    // fix no more than 30 s old.
    const [watch, setWatch] = useState(snapshot);
    useEffect(() => {
        const timer = window.setInterval(
            () => setWatch((s) => ({ ...s, vesselPosition: { ...s.vesselPosition!, timestamp: Date.now() } })),
            2_000,
        );
        return () => window.clearInterval(timer);
    }, []);
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 p-4 text-white">
            <h1 className="ui-page-title">Anchor Deployed</h1>
            <button type="button" className="mt-4 min-h-11 rounded-xl bg-white/10 px-4" onClick={() => setOpen(true)}>
                Open Move anchor
            </button>
            <output data-testid="outcome" className="mt-4 block text-sm text-slate-300">
                {outcome}
            </output>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row
                above the home-indicator inset, opaque. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span>PLAN</span>
                    <span className="text-sky-300">VESSEL</span>
                </div>
            </nav>
            {/* The real alarm screen, as GlobalAnchorAlarmGate draws it: the
                sheet must open over it, and its Move anchor is what opens it. */}
            {alarm && outcome !== 'moved' && (
                <AnchorAlarmOverlay
                    snapshot={watch}
                    onAcknowledge={() => undefined}
                    onMoveAnchor={() => setOpen(true)}
                />
            )}
            {open && piMode && (
                <MoveAnchorSheet
                    mode="pi"
                    pi={{
                        anchor: piAnchor,
                        boatFix: { ...boat, timestamp: watch.vesselPosition!.timestamp },
                        swingRadius: watch.swingRadius,
                        rodeLength: config.rodeLength,
                        waterDepth: config.waterDepth,
                        centreAtSet: boat,
                        ashore,
                        alarm: false,
                        gpsLost: false,
                    }}
                    onPiMove={async (lat, lon) => {
                        fixture.moves.push([lat, lon]);
                        if (piAnswer === 'refused')
                            return {
                                ok: false,
                                outcome: 'refused',
                                error: 'The Pi is still watching the old point. Nothing was moved.',
                            };
                        if (piAnswer === 'unknown')
                            return {
                                ok: false,
                                outcome: 'unknown',
                                error: 'The Pi didn’t answer. It is watching either the old or the new point; Shore Watch will show which within a minute.',
                            };
                        window.setTimeout(() => setPiAnchor({ latitude: lat, longitude: lon }), 1_000);
                        return { ok: true, ashore };
                    }}
                    onClose={() => setOpen(false)}
                    onMoved={() => {
                        setOpen(false);
                        setOutcome('moved');
                    }}
                />
            )}
            {open && !piMode && (
                <MoveAnchorSheet
                    mode={alarm ? 'alarm' : 'watch'}
                    snapshot={watch}
                    onClose={() => setOpen(false)}
                    onMoved={() => {
                        setOpen(false);
                        setOutcome('moved');
                    }}
                />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
