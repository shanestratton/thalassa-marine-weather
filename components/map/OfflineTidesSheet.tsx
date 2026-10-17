import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { useSettingsStore } from '../../stores/settingsStore';
import { loadSavedTraces } from '../../services/savedTraceStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { listSavedTideTables, removeSavedTideTable, type SavedTideTable } from '../../services/tides/offlineTideStore';
import { discoverTideStations, prefetchTideTable, tideDiscoveryPlan } from '../../services/tides/tidePrefetch';
import type { TideStation } from '../../services/tides/stationDetails';
import { satelliteModeActive } from '../../services/networkPolicy';
import NoaaHarmonicPanel from './NoaaHarmonicPanel';
const utc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const stationKey = (station: TideStation) => `${station.id}:${station.lat},${station.lon}`;
export default function OfflineTidesSheet({ onClose, station }: { onClose: () => void; station?: TideStation }) {
    const settings = useSettingsStore((s) => s.settings);
    const [tables, setTables] = React.useState<SavedTideTable[]>([]);
    const [stations, setStations] = React.useState<TideStation[]>(station ? [station] : []);
    const [selected, setSelected] = React.useState(station ? stationKey(station) : '');
    const [days, setDays] = React.useState<14 | 30>(14);
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState('');
    const [target, setTarget] = React.useState('');
    const controller = React.useRef<AbortController | null>(null);
    const scope = React.useRef(getAuthIdentityScope());
    const [identity, setIdentity] = React.useState(scope.current.key);
    const [online, setOnline] = React.useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
    React.useEffect(() => {
        let live = true;
        void listSavedTideTables().then((v) => {
            if (live && isAuthIdentityScopeCurrent(scope.current)) setTables(v);
        });
        const unsubscribe = subscribeAuthIdentityScope(() => {
            controller.current?.abort();
            setTables([]);
            setStations([]);
            setSelected('');
            setBusy(false);
            setMessage('Account changed. Reopen offline tides to continue.');
            setIdentity('closed');
        });
        return () => {
            live = false;
            controller.current?.abort();
            unsubscribe();
        };
    }, []);
    React.useEffect(() => {
        const update = () => setOnline(navigator.onLine !== false);
        window.addEventListener('online', update);
        window.addEventListener('offline', update);
        return () => {
            window.removeEventListener('online', update);
            window.removeEventListener('offline', update);
        };
    }, []);
    React.useEffect(() => {
        if (!online || settings.satelliteMode) {
            controller.current?.abort();
            setBusy(false);
        }
    }, [online, settings.satelliteMode]);
    async function refreshTables() {
        const value = await listSavedTideTables();
        if (isAuthIdentityScopeCurrent(scope.current)) setTables(value);
    }
    const targets = React.useMemo(
        () =>
            identity === 'closed'
                ? []
                : [
                      ...(settings.savedLocations ?? []).flatMap((name) => {
                          const point = settings.savedLocationCoords?.[name];
                          return point ? [{ id: `place:${name}`, name: `Saved place · ${name}`, points: [point] }] : [];
                      }),
                      ...loadSavedTraces().map((trace) => ({
                          id: `route:${trace.id}`,
                          name: `Route · ${trace.name}`,
                          points: trace.points,
                      })),
                  ],
        [settings.savedLocations, settings.savedLocationCoords, identity],
    );
    const chosen = targets.find((t) => t.id === target);
    const searchCount = chosen ? tideDiscoveryPlan(chosen.points).points.length : 0;
    const blocked = identity === 'closed' || satelliteModeActive() || !online;
    async function discover() {
        if (!chosen || blocked) return;
        controller.current?.abort();
        const c = new AbortController();
        controller.current = c;
        setBusy(true);
        setMessage('Finding tide stations…');
        try {
            const result = await discoverTideStations(chosen.points, c.signal);
            if (c.signal.aborted || !isAuthIdentityScopeCurrent(scope.current)) return;
            setStations(result.stations);
            setSelected(result.stations[0] ? stationKey(result.stations[0]) : '');
            setMessage(
                `${result.stations.length} stations found across ${result.searched} searches.${result.partial ? ' Search is partial; some of the route or station results remain unsearched.' : ''}`,
            );
        } finally {
            if (!c.signal.aborted && isAuthIdentityScopeCurrent(scope.current)) setBusy(false);
        }
    }
    async function save() {
        const s = stations.find((x) => stationKey(x) === selected);
        if (!s || blocked) return;
        controller.current?.abort();
        const c = new AbortController();
        controller.current = c;
        setBusy(true);
        setMessage('Downloading and verifying the saved table…');
        try {
            const result = await prefetchTideTable(s, days, c.signal);
            if (c.signal.aborted || !isAuthIdentityScopeCurrent(scope.current)) return;
            setMessage('error' in result ? result.error : 'Saved and verified on this device.');
            await refreshTables();
        } finally {
            if (!c.signal.aborted && isAuthIdentityScopeCurrent(scope.current)) setBusy(false);
        }
    }
    return (
        <ModalSheet isOpen onClose={onClose} title="Offline tide tables" maxWidth="max-w-lg" zIndex="z-1200">
            <div className="space-y-4 text-sm text-white/80 break-words">
                <p>
                    Save 14 or 30 days before leaving internet coverage. Tables are for this account on this device.
                    Heights are predictions, not measured water levels or safe route clearance.
                </p>
                <p>
                    WorldTides informational use only. Requests use credits: discovery about 1 credit per search; a
                    14-day table up to 3, a 30-day table up to 5. No automatic downloads.
                </p>
                {blocked && <p role="status">Saved tables only · downloads pause offline and in Satellite Mode.</p>}
                <label className="block">
                    Find stations along a route or at a saved place
                    <select
                        className="block w-full min-h-11 bg-slate-800 rounded mt-1"
                        value={target}
                        disabled={busy || blocked}
                        onChange={(e) => setTarget(e.target.value)}
                    >
                        <option value="">Choose a route or saved place</option>
                        {targets.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.name}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    className="min-h-11 underline"
                    disabled={!chosen || busy || blocked}
                    onClick={() => void discover()}
                >
                    Find stations{searchCount ? ` · up to ${searchCount} searches` : ''}
                </button>
                <label className="block">
                    Station
                    <select
                        className="block w-full min-h-11 bg-slate-800 rounded mt-1"
                        value={selected}
                        disabled={busy || blocked}
                        onChange={(e) => setSelected(e.target.value)}
                    >
                        <option value="">Choose a station</option>
                        {stations.map((s) => (
                            <option key={stationKey(s)} value={stationKey(s)}>
                                {s.name}
                            </option>
                        ))}
                    </select>
                </label>
                <div className="flex gap-3 items-center flex-wrap">
                    <label>
                        Period{' '}
                        <select
                            className="min-h-11 bg-slate-800 rounded px-2"
                            value={days}
                            disabled={busy}
                            onChange={(e) => setDays(Number(e.target.value) as 14 | 30)}
                        >
                            <option value={14}>14 days</option>
                            <option value={30}>30 days</option>
                        </select>
                    </label>
                    <button
                        type="button"
                        className="min-h-11 underline"
                        disabled={!selected || busy || blocked}
                        onClick={() => void save()}
                    >
                        Download table
                    </button>
                    {busy && (
                        <button
                            className="min-h-11 underline"
                            onClick={() => {
                                controller.current?.abort();
                                setBusy(false);
                                setMessage('Cancelled. An already-started provider request may use credits.');
                            }}
                        >
                            Cancel
                        </button>
                    )}
                </div>
                {message && <p role="status">{message}</p>}
                <h3 className="font-semibold text-white">Saved on this device · {tables.length}/24</h3>
                {!tables.length && <p>No saved tables for this account.</p>}
                {tables.map((t) => (
                    <article key={t.id} className="rounded border border-white/15 p-3 space-y-1">
                        <h4 className="font-semibold text-white">{t.station.name}</h4>
                        <p>
                            Saved {t.official ? 'official table' : 'WorldTides prediction'} · {t.provider} · Datum:{' '}
                            {t.datum ?? 'not supplied'}
                        </p>
                        <p>
                            Station ID: {t.station.id}
                            {t.predictionStationName && t.predictionStationName !== t.station.name
                                ? ` · Prediction at ${t.predictionStationName}`
                                : ''}
                        </p>
                        <p>
                            {t.predictionLocation
                                ? `Actual prediction position: ${t.predictionLocation.lat.toFixed(4)}, ${t.predictionLocation.lon.toFixed(4)}.`
                                : 'Provider did not identify its prediction position; the selected station is the request target.'}
                        </p>
                        <p>
                            Table covers {utc(t.coverageStartMs)} to {utc(t.coverageEndMs)}.
                        </p>
                        <p>
                            Retrieved {utc(t.fetchedAtMs)} · saved {utc(t.savedAtMs)}.
                            {t.generatedAt
                                ? ` Source generated ${t.generatedAt}.`
                                : ' Provider calculation date not supplied.'}
                        </p>
                        <p>
                            {t.coverageEndMs < Date.now() ? 'Coverage has ended. ' : ''}A saved table does not prove a
                            current official publisher or live conditions.
                        </p>
                        <details>
                            <summary className="min-h-11 cursor-pointer">
                                High and low events · {t.extremes.length}
                            </summary>
                            <div className="max-h-52 overflow-y-auto">
                                {t.extremes.map((e) => (
                                    <p key={e.timeMs}>
                                        {utc(e.timeMs)} · {e.type} · {e.heightM.toFixed(2)} m
                                    </p>
                                ))}
                            </div>
                        </details>
                        <p>{t.copyright}</p>
                        <a
                            className="underline min-h-11 inline-flex items-center"
                            href={t.licenceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Source copyright and licence
                        </a>
                        <button
                            type="button"
                            className="block min-h-11 underline"
                            onClick={() =>
                                void removeSavedTideTable(t.id)
                                    .then(refreshTables)
                                    .catch(() => {
                                        if (isAuthIdentityScopeCurrent(scope.current))
                                            setMessage('The saved table could not be removed.');
                                    })
                            }
                        >
                            Remove saved table
                        </button>
                    </article>
                ))}
                <NoaaHarmonicPanel />
            </div>
        </ModalSheet>
    );
}
