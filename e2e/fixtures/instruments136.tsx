/** Synthetic local fixture: real panel/store, no boat position, provider credential or backend. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only');

// Never read a saved gateway/session/profile or persist fictional receiver data.
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

const [
    { TheGlassPage },
    { InstrumentPanelSettings },
    { NmeaStore },
    { snapshotFromWire },
    { resolveEffectiveVessel },
    { useSettingsStore },
    { setAuthIdentityScope },
    { confirmUnderSail },
    { saveInstrumentPanelPreferences },
] = await Promise.all([
    import('../../components/nmea/TheGlassPage'),
    import('../../components/settings/InstrumentPanelSettings'),
    import('../../services/NmeaStore'),
    import('../../services/telemetryWire'),
    import('../../utils/defaultVessel'),
    import('../../stores/settingsStore'),
    import('../../services/authIdentityScope'),
    import('../../services/instruments/underSail'),
    import('../../services/instruments/panelPreferences'),
]);
let mode: 'qualified' | 'legacy' | 'empty' | 'engine' = 'qualified';
setAuthIdentityScope('fictional-instrument-a');
const original = useSettingsStore.getState().settings;
useSettingsStore.setState({
    settings: {
        ...original,
        polarSource: 'factory',
        vessel: {
            ...resolveEffectiveVessel(original.vessel),
            name: 'Fictional fixture boat',
            type: 'sail',
            length: 12,
        },
    },
});
function feed() {
    if (mode === 'empty') {
        NmeaStore.clearRemote();
        return;
    }
    const now = Date.now();
    const extra =
        mode === 'legacy'
            ? {}
            : {
                  heading_true_deg: 0,
                  heading_true_at_ms: now,
                  position_at: now,
                  wind_twd_at_ms: now,
                  wind_history_identity: 'fictional-instrument-boat',
                  instrument_times_v1: JSON.stringify([now, now, now, now, now, now, null, null]),
                  ...(mode === 'engine'
                      ? { engine_metrics_v1: JSON.stringify([1, 'main', now, 36000, 1000, 80, 2000, 300, 3000]) }
                      : {}),
              };
    const snapshot = snapshotFromWire(
        {
            source: 'pi',
            reported_at: new Date(now).toISOString(),
            lat: 30,
            lon: -60,
            sog_kts: Math.sqrt(26),
            cog_deg: (Math.atan2(1, 5) * 180) / Math.PI,
            stw_kts: 5,
            heading_deg: 0,
            tws_kts: 15,
            twa_deg: 60,
            twd_deg: 60,
            rpm: mode === 'engine' ? 900 : 0,
            depth_m: 10,
            water_temp_c: 20,
            extra,
        },
        'lan',
    )!;
    NmeaStore.ingestRemote(snapshot.snapshot);
}
feed();
setInterval(feed, 2000);
Object.assign(window, {
    __instruments136: {
        mode: (next: typeof mode) => {
            mode = next;
            feed();
        },
        account: (id: string) => setAuthIdentityScope(id),
        prefs: saveInstrumentPanelPreferences,
        confirm: () => confirmUnderSail('fictional-instrument-boat'),
    },
});
function Fixture() {
    const [settings, setSettings] = React.useState(false);
    React.useEffect(() => {
        // Child subscriptions are mounted before test actions change the source.
        document.body.dataset.ready = 'true';
        return () => {
            delete document.body.dataset.ready;
        };
    }, []);
    return (
        <div
            className="h-dvh bg-slate-950 text-white"
            style={{ '--thalassa-tabbar-height': '0px' } as React.CSSProperties}
        >
            <nav className="flex h-11 gap-2">
                <button onClick={() => setSettings((v) => !v)}>Preferences</button>
                <span>Fictional fixture</span>
            </nav>
            <div className="h-[calc(100dvh-44px)]">
                {settings ? (
                    <div className="h-full overflow-y-auto">
                        <InstrumentPanelSettings />
                    </div>
                ) : (
                    <TheGlassPage onBack={() => undefined} />
                )}
            </div>
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
