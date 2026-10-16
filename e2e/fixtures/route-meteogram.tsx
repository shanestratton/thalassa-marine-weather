import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only.');
class FixtureStorage implements Storage {
    private data = new Map<string, string>();
    get length() {
        return this.data.size;
    }
    clear() {
        this.data.clear();
    }
    getItem(key: string) {
        return this.data.get(key) ?? null;
    }
    setItem(key: string, value: string) {
        this.data.set(key, String(value));
    }
    removeItem(key: string) {
        this.data.delete(key);
    }
    key(index: number) {
        return [...this.data.keys()][index] ?? null;
    }
}
Object.defineProperty(window, 'localStorage', { value: new FixtureStorage(), configurable: true });
Object.defineProperty(window, 'sessionStorage', { value: new FixtureStorage(), configurable: true });
window.fetch = async () => new Response('Synthetic fixture: network disabled.', { status: 503 });
const wide = document.createElement('style');
wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
document.head.append(wide);
const [{ TraceReportModal }, settings, { WindStore }, fixture, { traceGeometryKey }] = await Promise.all([
    import('../../components/map/TraceReportModal'),
    import('../../stores/settingsStore'),
    import('../../stores/WindStore'),
    import('../../tests/fixtures/routeWeatherFixture'),
    import('../../services/traceVerification'),
]);
await settings.awaitSettingsLoaded();
const start = fixture.routeWeatherFixtureStart,
    pins = fixture.routeWeatherFixturePins;
settings.useSettingsStore.setState({
    settings: {
        ...settings.useSettingsStore.getState().settings,
        vessel: fixture.routeWeatherFixtureVessel,
        forecastModel: 'dwd_icon',
        polarSource: 'factory',
        polarSource_type: 'manual',
        polarData: fixture.routeWeatherFixturePolar.polar,
        polarBoatModel: 'Synthetic polar',
        smartPolarsEnabled: false,
    },
});
const frames = (value: number) =>
    Array.from({ length: 96 }, (_, hour) => new Float32Array(4).fill(hour === 30 ? NaN : value));
WindStore.setState({
    model: 'icon',
    field: 'wind',
    isGlobalMode: true,
    grid: {
        width: 2,
        height: 2,
        north: 2,
        south: -1,
        west: -1,
        east: 5,
        lats: [-1, 2],
        lons: [-1, 5],
        totalHours: 96,
        refTime: new Date(start).toISOString(),
        stepHours: Array.from({ length: 96 }, (_, i) => i),
        u: frames(-6),
        v: frames(0),
        speed: frames(6),
    },
});
function Fixture() {
    const [open, setOpen] = useState(true);
    return (
        <main className="h-dvh bg-slate-950 text-white">
            <TraceReportModal
                open={open}
                onClose={() => setOpen(false)}
                pins={pins}
                routeName="Fictional route weather"
                verdicts={pins.slice(1).map(() => ({
                    grade: 'caution' as const,
                    issues: [{ severity: 'caution' as const, message: 'Synthetic fixture only; no real chart check.' }],
                    minDepthM: null,
                    minAt: null,
                    needsTide: false,
                    nudge: null,
                    nudgeTo: null,
                }))}
                tideLabels={{}}
                departureLabel=""
                ackedLegs={new Set()}
                releaseGate={{
                    allowed: true,
                    reason: '',
                    verification: {
                        version: 1,
                        graderVersion: 'route-tracer-v1',
                        geometryKey: traceGeometryKey(pins),
                        checkedAt: new Date(start).toISOString(),
                        result: 'verified',
                        legGrades: ['caution', 'caution'],
                        acknowledgedDangerLegs: [],
                        draftM: 1.8,
                        draftAssumed: false,
                        encRegistryVersion: 0,
                        encRegistryFingerprint: '',
                        departureMs: start,
                        tideWindowLabel: '',
                    },
                }}
                fixBusy={null}
                onAckLeg={() => undefined}
                cruisingSpeedKts={6}
                departureMs={start}
                vesselName="Fictional vessel"
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
