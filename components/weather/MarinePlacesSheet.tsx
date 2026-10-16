import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { useWeather } from '../../context/WeatherContext';
import { useSettings } from '../../context/SettingsContext';
import { buildSaveLocationPatch, disambiguateSavedName } from '../../utils/savedLocations';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { satelliteModeActive } from '../../services/networkPolicy';
import { catalogueCacheStats, clearCatalogueCache } from '../../services/marineCatalogue/cache';
import { loadMarineArea, searchMarinePlaces, type CatalogueResult } from '../../services/marineCatalogue/service';
import { LICENCES, placeSourceUrl, type MarinePlace } from '../../services/marineCatalogue/schema';
const ObservedNearbyCard = React.lazy(() => import('../observations/ObservedNearbyCard'));
const SpotTides = React.lazy(() => import('./MarineSpotTides'));
const NoaaAgreementSheet = React.lazy(() => import('../map/NoaaAgreementSheet'));
const button = 'min-h-[44px] rounded-lg border border-white/15 px-3 py-2 text-sm text-sky-200 disabled:opacity-40';

export default function MarinePlacesSheet({ onClose }: { onClose: () => void }) {
    const { weatherData, selectLocation } = useWeather();
    const { settings, updateSettings } = useSettings();
    return (
        <MarinePlacesView
            onClose={onClose}
            near={weatherData?.coordinates}
            satelliteMode={settings.satelliteMode === true}
            onForecast={(spot) => {
                void selectLocation(`${spot.name}${spot.country ? `, ${spot.country}` : ''}`, {
                    lat: spot.lat,
                    lon: spot.lon,
                });
            }}
            onSave={(spot) => {
                const name = disambiguateSavedName(
                    settings.savedLocations,
                    settings.savedLocationCoords,
                    `${spot.name}${spot.country ? `, ${spot.country}` : ''}`,
                    spot.lat,
                    spot.lon,
                );
                const patch = buildSaveLocationPatch(
                    settings.savedLocations,
                    settings.savedLocationCoords,
                    `${name} (${spot.lat}, ${spot.lon})`,
                );
                if (patch) updateSettings(patch);
                return patch ? `Saved ${name}` : 'Could not save this spot';
            }}
        />
    );
}
/** Shared public-data view; the wrapper alone changes the selected account's location. */
export function MarinePlacesView({
    onClose,
    near,
    onForecast,
    onSave,
    satelliteMode,
}: {
    onClose: () => void;
    near?: { lat: number; lon: number };
    onForecast: (spot: MarinePlace) => void;
    onSave: (spot: MarinePlace) => string;
    satelliteMode: boolean;
}) {
    const [query, setQuery] = React.useState('');
    const [result, setResult] = React.useState<CatalogueResult | null>(null);
    const [spot, setSpot] = React.useState<MarinePlace | null>(null);
    const [message, setMessage] = React.useState(
        'Search at least three letters. Names are representative points, not boundaries or navigational marks.',
    );
    const [busy, setBusy] = React.useState(false);
    const [stats, setStats] = React.useState({ entries: 0, bytes: 0 });
    const [detail, setDetail] = React.useState<'observed' | 'tides' | null>(null);
    const [agreementOpen, setAgreementOpen] = React.useState(false);
    const request = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        let live = true;
        void catalogueCacheStats().then((s) => {
            if (live) setStats(s);
        });
        const unsubscribe = subscribeAuthIdentityScope(() => {
            request.current?.abort();
            onClose();
        });
        return () => {
            live = false;
            request.current?.abort();
            unsubscribe();
        };
    }, [onClose]);
    React.useEffect(() => {
        if (satelliteMode) request.current?.abort();
    }, [satelliteMode]);
    async function run(area: boolean) {
        request.current?.abort();
        const controller = new AbortController(),
            scope = getAuthIdentityScope();
        request.current = controller;
        setBusy(true);
        setResult(null);
        setSpot(null);
        setDetail(null);
        setMessage(area ? 'Reading public area tiles…' : 'Searching marine places…');
        try {
            const found =
                area && near
                    ? await loadMarineArea(near.lat, near.lon, undefined, controller.signal)
                    : await searchMarinePlaces(query, near, controller.signal);
            if (controller.signal.aborted || !isAuthIdentityScopeCurrent(scope)) return;
            setResult(found);
            setMessage(
                `${found.records.length} records shown. ${found.cachedOnly ? 'Saved data only. ' : ''}${area ? (found.offlineComplete ? 'Area saved for offline use. ' : 'Area cache incomplete. ') : ''}${found.partial ? 'Less data here: some source tiles are unavailable. ' : ''}A mapped place does not establish anchoring permission, availability or safety.`,
            );
            setStats(await catalogueCacheStats());
        } catch (error) {
            if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope))
                setMessage(error instanceof Error ? error.message : 'Catalogue unavailable');
        } finally {
            if (request.current === controller) setBusy(false);
        }
    }
    const source = spot?.id.startsWith('geonames:') ? 'places' : spot?.id.startsWith('noaa:') ? 'noaa' : 'osm';
    return (
        <>
            <ModalSheet isOpen onClose={onClose} title="Marine places" maxWidth="max-w-lg" zIndex="z-10060">
                <div className="space-y-3 min-w-0 text-sm text-slate-200">
                    {spot ? (
                        <>
                            <button
                                className={button}
                                onClick={() => {
                                    setSpot(null);
                                    setDetail(null);
                                }}
                            >
                                Back to results
                            </button>
                            <h3 className="text-lg font-bold wrap-break-word">{spot.name}</h3>
                            <p>
                                {spot.kind} · {spot.country || 'Country not recorded'} · {spot.lat.toFixed(4)},{' '}
                                {spot.lon.toFixed(4)}
                            </p>
                            <p className="text-xs text-amber-200">
                                Representative location. Island, reef and headland points may be on land. Forecast uses
                                the provider’s sea-cell selection; it does not locate a safe berth. Local depth, shelter
                                and permissions remain unassessed.
                            </p>
                            <p className="text-xs">
                                {spot.access || 'Access / permission unknown.'} {spot.restrictions?.join(' · ')}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <button
                                    className={button}
                                    onClick={() => {
                                        onForecast(spot);
                                        onClose();
                                    }}
                                >
                                    Forecast in The Glass
                                </button>
                                <button
                                    className={button}
                                    onClick={() => {
                                        setMessage(onSave(spot));
                                    }}
                                >
                                    Save spot
                                </button>
                                <button className={button} onClick={() => setDetail('observed')}>
                                    Nearby buoy / observations
                                </button>
                                <button className={button} onClick={() => setDetail('tides')}>
                                    Nearby tides
                                </button>
                            </div>
                            <a
                                className="block text-xs text-sky-300 underline"
                                href={placeSourceUrl(spot)}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {LICENCES[source].label} · {spot.id}
                            </a>
                            <React.Suspense fallback={<p>Opening details…</p>}>
                                {detail === 'observed' && <ObservedNearbyCard point={spot} />}
                                {detail === 'tides' && <SpotTides point={spot} />}
                            </React.Suspense>
                        </>
                    ) : (
                        <>
                            <form
                                className="flex flex-wrap gap-2"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void run(false);
                                }}
                            >
                                <label className="w-full">
                                    Bay, island, reef or headland
                                    <input
                                        className="mt-1 w-full min-w-0 rounded-lg bg-slate-950 p-3"
                                        value={query}
                                        maxLength={100}
                                        onChange={(e) => {
                                            request.current?.abort();
                                            setBusy(false);
                                            setQuery(e.target.value);
                                            setResult(null);
                                        }}
                                    />
                                </label>
                                <button className={button} disabled={busy || Array.from(query.trim()).length < 3}>
                                    Search marine places
                                </button>
                                <button
                                    type="button"
                                    className={button}
                                    disabled={busy || !near}
                                    onClick={() => void run(true)}
                                >
                                    Read / save shown area
                                </button>
                                {busy && (
                                    <button
                                        type="button"
                                        className={button}
                                        onClick={() => {
                                            request.current?.abort();
                                            setBusy(false);
                                            setMessage('Cancelled. Previously saved tiles remain.');
                                        }}
                                    >
                                        Cancel
                                    </button>
                                )}
                            </form>
                            <p className="text-xs">
                                Area downloads cover up to 50 NM around the location shown in The Glass, at most16
                                public two-degree cells per source. Satellite Mode reads saved data only. Storage is
                                capped at24 MiB; oldest downloaded tiles are replaced.
                            </p>
                            <ul className="divide-y divide-white/10">
                                {result?.records.slice(0, 300).map((p) => (
                                    <li key={p.id}>
                                        <button
                                            className="w-full min-h-[44px] py-3 text-left"
                                            onClick={() => {
                                                setSpot(p);
                                                setDetail(null);
                                            }}
                                        >
                                            <span className="block font-semibold wrap-break-word">{p.name}</span>
                                            <span className="text-xs text-slate-400">
                                                {p.kind} · {p.country || `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`} ·{' '}
                                                {p.id.startsWith('geonames:')
                                                    ? 'GeoNames'
                                                    : p.id.startsWith('noaa:')
                                                      ? 'NOAA'
                                                      : 'OpenStreetMap'}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                            {(result?.records.length ?? 0) > 300 && (
                                <p>Showing the first300 records. Search a name to narrow the list.</p>
                            )}
                        </>
                    )}
                    <p role="status" className="text-xs text-amber-200 wrap-break-word">
                        {message}
                    </p>
                    {result?.noaaConsentRequired && (
                        <p className="text-xs">
                            NOAA-derived references are withheld until you accept their user agreement.
                        </p>
                    )}
                    <button className={button} onClick={() => setAgreementOpen(true)}>
                        NOAA-derived data · user agreement
                    </button>
                    {result?.manifests.map((m) => (
                        <p className="text-xs text-slate-400" key={m.dataset}>
                            <a
                                href={LICENCES[m.dataset].url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline"
                            >
                                {LICENCES[m.dataset].label}
                            </a>{' '}
                            · source {m.sourceAt.slice(0, 10)} · {m.coverage}
                            {Date.now() - Date.parse(m.sourceAt) > 45 * 86400000 ? ' · Old snapshot' : ''}
                        </p>
                    ))}
                    <div className="border-t border-white/10 pt-2 text-xs">
                        <p>
                            Saved public data: {(stats.bytes / 1048576).toFixed(1)} /24 MiB · {stats.entries} files. No
                            chart data is included.
                        </p>
                        <button
                            className={button}
                            onClick={() => {
                                request.current?.abort();
                                setBusy(false);
                                void clearCatalogueCache()
                                    .then(() => {
                                        setStats({ entries: 0, bytes: 0 });
                                        setResult(null);
                                        setMessage('Saved public catalogue deleted.');
                                    })
                                    .catch(() => setMessage('Could not delete the saved catalogue. Try again.'));
                            }}
                        >
                            Delete saved catalogue
                        </button>
                    </div>
                    {satelliteModeActive() && <p className="text-xs">Satellite Mode: downloads paused.</p>}
                </div>
            </ModalSheet>
            {agreementOpen && (
                <React.Suspense fallback={<p role="status">Opening NOAA agreement…</p>}>
                    <NoaaAgreementSheet
                        onClose={() => setAgreementOpen(false)}
                        onAccepted={() => {
                            setAgreementOpen(false);
                            setMessage('NOAA agreement accepted. Read/save the shown area to load derived references.');
                        }}
                    />
                </React.Suspense>
            )}
        </>
    );
}
