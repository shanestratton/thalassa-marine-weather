import React from 'react';
import type mapboxgl from 'mapbox-gl';
import { useSettingsStore } from '../../stores/settingsStore';
import { satelliteModeBlocks } from '../../services/networkPolicy';
import {
    prepareSatelliteFrame,
    readSatelliteTimes,
    satelliteImagePlan,
    satelliteProductAt,
    type PreparedSatelliteFrame,
    type SatelliteImagePlan,
    type SatelliteTimesLease,
} from '../../services/weather/satelliteView';
import {
    SATELLITE_VIEW_PRODUCTS,
    satelliteViewCredit,
    type SatelliteViewProduct,
} from '../../services/weather/satelliteViewContract';
import { useOwnedImageOverlay } from './useOwnedImageOverlay';
import type { AtmosCredit } from './atmosPresentation';
interface Props {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    active: boolean;
    onCredit: (credit: AtmosCredit | null) => void;
    onControls?: (controls: React.ReactNode | null) => void;
    onFallback?: () => void;
}
type Viewport = { map: mapboxgl.Map; plan: SatelliteImagePlan; automatic: SatelliteViewProduct; clipped: boolean };
const stamp = (iso: string, daily: boolean) =>
    daily ? `${iso} · daily night composite` : `Listed frame ${iso.replace('T', ' ').replace('Z', ' UTC')}`;

/** Separately lazy/default-OFF display owner. Its UI belongs inside the existing capped layer key. */
export default function SharperSatelliteLayer({
    mapRef,
    mapReady,
    active: requested,
    onCredit,
    onControls,
    onFallback,
}: Props) {
    const admitted = import.meta.env.VITE_SHARPER_SATELLITE_ENABLED === 'true';
    const displayRequested = requested && admitted;
    const fallbackAction = React.useRef(onFallback);
    fallbackAction.current = onFallback;
    const useFallback = React.useCallback(() => fallbackAction.current?.(), []);
    const hasFallback = !!onFallback;
    const metered = useSettingsStore((state) => state.settings?.satelliteMode === true);
    const active = displayRequested && !metered;
    const [choice, setChoice] = React.useState<SatelliteViewProduct | 'auto'>('auto'),
        [viewport, setViewport] = React.useState<Viewport | null>(null);
    const [lease, setLease] = React.useState<SatelliteTimesLease | null>(null),
        [image, setImage] = React.useState<PreparedSatelliteFrame | null>(null);
    const [selected, setSelected] = React.useState<string | null>(null),
        [refresh, setRefresh] = React.useState(0),
        [playing, setPlaying] = React.useState(false),
        [details, setDetails] = React.useState(false);
    const [issue, setIssue] = React.useState<string | null>(null);
    const product = choice === 'auto' ? (viewport?.automatic ?? null) : choice;
    const latest = React.useRef({ active, product, viewport, selected });
    latest.current = { active, product, viewport, selected };
    const lastClaimed = React.useRef<PreparedSatelliteFrame | null>(null);
    React.useEffect(() => {
        const map = mapRef.current;
        if (!active || !mapReady || !map) {
            setViewport(null);
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = () => {
            try {
                const bounds = map.getBounds();
                if (!bounds) throw Error('Viewport unavailable');
                const box = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
                const plan = satelliteImagePlan(box),
                    automatic = satelliteProductAt(box),
                    clipped = box[1] < -85 || box[3] > 85;
                setViewport((previous) =>
                    previous?.map === map && previous.plan.key === plan.key && previous.automatic === automatic
                        ? previous
                        : { map, plan, automatic, clipped },
                );
            } catch {
                setViewport(null);
            }
        };
        const moved = () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = undefined;
                read();
            }, 250);
        };
        map.on('moveend', moved);
        read();
        return () => {
            if (timer !== undefined) clearTimeout(timer);
            map.off('moveend', moved);
        };
    }, [active, mapReady, mapRef]);
    React.useEffect(() => {
        if (!active) return;
        const renew = setInterval(() => setRefresh((value) => value + 1), 90000);
        return () => {
            clearInterval(renew);
        };
    }, [active]);
    React.useEffect(() => {
        setLease(null);
        setIssue(null);
        if (!active || !product || !viewport) return;
        const map = viewport.map,
            controller = new AbortController();
        let live = true,
            owned: SatelliteTimesLease | null = null;
        const current = () =>
            live &&
            latest.current.active &&
            latest.current.product === product &&
            mapRef.current === map &&
            !satelliteModeBlocks('raster');
        void readSatelliteTimes(product, controller.signal, current)
            .then((value) => {
                owned = value;
                if (!current()) {
                    value.close();
                    return;
                }
                setLease(value);
            })
            .catch(() => {
                if (current()) setIssue('Satellite times unavailable · original hourly mosaic remains available');
            });
        return () => {
            live = false;
            controller.abort();
            owned?.close();
        };
        // Viewport geometry changes reuse this source's listed times, without renewing their clocks.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, product, viewport?.map, refresh, mapRef]);
    const usable = lease?.times.product === product && lease.isCurrent() ? lease : null;
    const frame = usable
        ? selected === null
            ? usable.times.frames.at(-1)
            : usable.times.frames.find((frame) => frame.iso === selected)
        : undefined;
    const key =
        active && viewport && frame && usable
            ? `${product}:${frame.iso}:${viewport.plan.key}:${usable.times.readAtMs}`
            : '';
    const requestKey = React.useRef(key);
    requestKey.current = key;
    const currentLease = React.useRef(usable);
    currentLease.current = usable;
    React.useEffect(() => {
        setImage(null);
        if (!key || !usable || !frame || !viewport) return;
        const plan = viewport.plan,
            controller = new AbortController();
        let live = true,
            owned: PreparedSatelliteFrame | null = null;
        const current = () =>
            live &&
            requestKey.current === key &&
            currentLease.current === usable &&
            latest.current.active &&
            latest.current.viewport?.plan === plan;
        void prepareSatelliteFrame(usable, frame, plan, controller.signal, current)
            .then((value) => {
                owned = value;
                if (!current() || !value.isCurrent()) {
                    value.releaseUnclaimed();
                    return;
                }
                setImage(value);
                setIssue(null);
            })
            .catch(() => {
                if (current()) setIssue('Satellite image unavailable · coverage or listed frame may be missing');
            });
        return () => {
            live = false;
            controller.abort();
            owned?.releaseUnclaimed();
        };
        // The key captures exact original lease/time/window identities; a late selection never adopts.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, usable, frame, viewport?.plan]);
    const visible =
        image &&
        key &&
        image.product === product &&
        image.frame === frame &&
        image.plan === viewport?.plan &&
        image.isCurrent()
            ? image
            : null;
    const prepare = React.useCallback(
        (check: () => void) => {
            check();
            if (!visible) throw Error('Satellite image absent');
            const value = visible.claim();
            lastClaimed.current = visible;
            return value;
        },
        [visible],
    );
    const source = visible ?? lastClaimed.current;
    const status = useOwnedImageOverlay(mapRef, mapReady, {
        id: 'sharper-satellite-view',
        label: 'Satellite imagery',
        credit: source ? satelliteViewCredit(source.product, source.frame.timeMs) : 'Satellite source pending',
        enabled: active,
        owner: visible,
        revision: key,
        sourceCurrent: () => !!visible?.isCurrent(),
        prepare,
        maxEdge: 1024,
    });
    const index = frame && usable ? usable.times.frames.indexOf(frame) : -1;
    React.useEffect(() => {
        if (!playing) return;
        if (!active || !usable || index < 0 || issue) {
            setPlaying(false);
            return;
        }
        if (status !== 'ready') return;
        if (index >= usable.times.frames.length - 1) {
            setPlaying(false);
            return;
        }
        const timer = setTimeout(() => setSelected(usable.times.frames[index + 1].iso), 1000);
        return () => clearTimeout(timer);
    }, [playing, active, usable, index, status, issue]);
    React.useEffect(() => {
        if (!active) {
            setPlaying(false);
            setSelected(null);
            setDetails(false);
        }
    }, [active]);
    const held = status === 'stuck-visible';
    const inspected = held ? lastClaimed.current : visible;
    const inspectedProduct = inspected?.product ?? product;
    const inspectedMetadata = inspected?.metadataUrl ?? usable?.times.metadataUrl;
    const title = held
        ? 'Removal uncertain; satellite image may remain visible'
        : metered && displayRequested
          ? 'Sharper satellite paused in Satellite Mode'
          : (issue ??
            (!viewport
                ? 'Satellite viewport unavailable'
                : !usable
                  ? 'Reading original satellite frame list'
                  : !frame
                    ? 'Requested frame no longer listed'
                    : status === 'ready'
                      ? stamp(frame.iso, frame.daily)
                      : 'Loading listed satellite image'));
    React.useEffect(() => {
        if (!displayRequested && !held) {
            onCredit(null);
            return;
        }
        const original = inspected;
        const id = original?.product ?? product;
        const definition = id ? SATELLITE_VIEW_PRODUCTS[id] : null;
        onCredit({
            key: 'satellite-sharper',
            title: 'Sharper satellite',
            warning:
                held ||
                status !== 'ready' ||
                !!original?.frame.daily ||
                !!viewport?.clipped ||
                (!!original &&
                    (original.alphaFraction < 0.99 ||
                        Date.now() - original.frame.timeMs > 3 * 3600000 ||
                        original.frame.timeMs > Date.now() + 60000)),
            text: `${title}. ${id ? satelliteViewCredit(id, original?.frame.timeMs) : 'Source unavailable'}. ${definition?.detail ?? ''}. ${original ? stamp(original.frame.iso, original.frame.daily) + '. Metadata read ' + new Date(original.metadataReadAtMs).toISOString() + '. ' : ''}Metadata-listed time; image acquisition clock not embedded. Original palette at 72% opacity, viewport resampled; gaps and missing coverage are unknown, not clear sky.`,
        });
    }, [displayRequested, held, inspected, product, status, title, viewport?.clipped, onCredit]);
    React.useEffect(() => {
        if (!displayRequested && !held) {
            onControls?.(null);
            return;
        }
        onControls?.(
            <section
                aria-label="Sharper satellite controls"
                className="min-w-0 space-y-2 rounded-xl border border-white/10 p-2 text-[11px] text-slate-200"
            >
                <div className="font-bold">Satellite imagery</div>
                <p role="status" className={status === 'ready' ? 'text-sky-100' : 'text-amber-200'}>
                    {title}
                </p>
                <label className="block">
                    Picture
                    <select
                        style={{ colorScheme: 'dark', backgroundColor: '#0f172a', color: '#e2e8f0' }}
                        aria-label="Satellite picture source"
                        value={choice}
                        onChange={(event) => {
                            setChoice(event.target.value as SatelliteViewProduct | 'auto');
                            setSelected(null);
                            setPlaying(false);
                        }}
                        className="mt-1 block min-h-11 w-full min-w-0 rounded-lg bg-slate-900 p-1"
                    >
                        <option value="auto">Auto · regional / polar</option>
                        {Object.entries(SATELLITE_VIEW_PRODUCTS).map(([id, source]) => (
                            <option key={id} value={id}>
                                {source.label}
                            </option>
                        ))}
                    </select>
                </label>
                {usable && (
                    <>
                        <label className="block">
                            Listed frames
                            <input
                                type="range"
                                aria-label="Listed satellite frame"
                                min={0}
                                max={usable.times.frames.length - 1}
                                value={Math.max(0, index)}
                                disabled={!active}
                                onChange={(event) => {
                                    setPlaying(false);
                                    setSelected(usable.times.frames[Number(event.target.value)].iso);
                                }}
                                className="block min-h-11 w-full"
                            />
                        </label>
                        <p>
                            {frame
                                ? stamp(frame.iso, frame.daily)
                                : 'Requested frame missing; choose an original listed frame'}
                        </p>
                    </>
                )}
                <div className="flex flex-wrap gap-1">
                    <button
                        type="button"
                        className="min-h-11 rounded-lg bg-slate-800 px-2"
                        onClick={() => {
                            setSelected(null);
                            setPlaying(false);
                        }}
                    >
                        Latest
                    </button>
                    <button
                        type="button"
                        className="min-h-11 rounded-lg bg-slate-800 px-2"
                        disabled={!usable || usable.times.frames.length < 2 || !active}
                        onClick={() => {
                            if (playing) setPlaying(false);
                            else if (usable) {
                                setSelected(usable.times.frames[0].iso);
                                setPlaying(true);
                            }
                        }}
                    >
                        {playing ? 'Pause' : 'Play once'}
                    </button>
                    <button
                        type="button"
                        className="min-h-11 rounded-lg bg-slate-800 px-2"
                        onClick={() => {
                            setRefresh((value) => value + 1);
                            setPlaying(false);
                        }}
                    >
                        Retry
                    </button>
                    <button
                        type="button"
                        className="min-h-11 rounded-lg bg-slate-800 px-2"
                        aria-expanded={details}
                        onClick={() => setDetails((value) => !value)}
                    >
                        Info
                    </button>
                    {hasFallback && (
                        <button type="button" className="min-h-11 rounded-lg bg-slate-800 px-2" onClick={useFallback}>
                            Hourly mosaic
                        </button>
                    )}
                </div>
                {details && (
                    <div className="space-y-1">
                        <p>
                            {inspectedProduct ? SATELLITE_VIEW_PRODUCTS[inspectedProduct].detail : 'No source selected'}
                            . Source resolution is not the resampled viewport resolution.
                        </p>
                        <p>
                            Regional disks and polar swaths can be empty. Upper water vapour is mid/upper-air moisture,
                            not surface fog or visibility. A daily VIIRS composite has no single observation instant.
                            This display supplies no routing, depth or alarm authority.
                        </p>
                        <p>
                            Clocks are metadata-listed; provider nearest-time responses and scan timing need independent
                            image-clock validation.
                        </p>
                        {inspectedMetadata && (
                            <a
                                className="break-all underline"
                                href={inspectedMetadata}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Original frame-list metadata
                            </a>
                        )}
                    </div>
                )}
            </section>,
        );
    }, [
        displayRequested,
        held,
        onControls,
        title,
        status,
        choice,
        usable,
        index,
        frame,
        active,
        playing,
        details,
        hasFallback,
        useFallback,
        product,
        inspectedProduct,
        inspectedMetadata,
    ]);
    React.useEffect(
        () => () => {
            onControls?.(null);
            onCredit(null);
        },
        [onControls, onCredit],
    );
    return null;
}
