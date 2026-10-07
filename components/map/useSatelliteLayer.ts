/**
 * useSatelliteLayer — the observed satellite cloud ("Sat cloud") on the Obs
 * chart. Source, colours and the measurements behind them: satelliteImagery.ts.
 *
 * ONE image source, ever. Frames swap in place through updateImage, so the GPU
 * holds one texture of one size however long the loop runs, and nothing grows
 * while the skipper pans (the 2 GB WebContent jetsam: see satelliteImagery.ts).
 *
 * EVERY FRAME IS FETCHED ONCE AND ANCHORED BEFORE IT IS SHOWN. The server
 * stretches each image by its own brightest pixel, which is not always cloud,
 * so the same grey can mean a different cloud-top temperature from one hour to
 * the next. The hook reads each frame's bytes once, measures them on the phone
 * (satIrPixels → satIrAnchor) and shows the frame with its own gain, or, when
 * its stretch is outside the measured band, never shows it. Mapbox gets the
 * same bytes as a data: URL, so nothing downloads twice and a loop that has
 * been round once keeps playing through a dropout.
 *
 * Which frame shows:
 *   - Rain up and its scrubber ready: the newest satellite frame taken by the
 *     moment the radar scrubber stands on (rainTimeAxis), so rain and cloud
 *     scrub together; a forecast moment holds the latest observation.
 *   - Otherwise the latest frame, or the skipper's own loop of up to six. The
 *     loop never runs ahead of the pixels: it steps only once the last frame
 *     has painted, and it stops after two failures in a row.
 *
 * A failed frame is asked for again after two minutes, so "retrying" on the
 * chip is true. Never moves the camera. Anchored with the other cloud overlays
 * above the opaque imagery and under the chart and ENC (imageryOrder), and
 * put back there if a restyle buries it or ENC mounts underneath it. Fetches
 * nothing in Satellite Mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { satelliteModeBlocks } from '../../services/networkPolicy';
import { useSettingsStore } from '../../stores/settingsStore';
import { createLogger } from '../../utils/createLogger';
import { cloudOverlayBeforeId, imageryTopIndex } from './imageryOrder';
import { latestFrameAtOrBefore } from './rainTimeAxis';
import { satIrDataUrl, satIrTropicalHistogram } from './satIrPixels';
import {
    SAT_IR_CAPABILITIES_URL,
    SAT_IR_FULL_COVERAGE,
    SAT_IR_LAYER_ID,
    SAT_IR_SOURCE_ID,
    parseGmgsiFrames,
    sameSatIrCoverage,
    satIrAnchor,
    satIrColorMix,
    satIrCoverage,
    satIrFrames,
    satIrImageCoordinates,
    satIrImageUrl,
    satIrPaint,
    type SatIrCoverage,
    type SatIrFrame,
} from './satelliteImagery';

const log = createLogger('SatelliteLayer');

export type SatIrStatus = 'off' | 'blocked' | 'loading' | 'ready' | 'unavailable';

export interface SatIrState {
    status: SatIrStatus;
    /** Valid time of the frame actually PAINTED — not the one last requested. */
    frameTimeMs: number | null;
    /** Frames listed and not set aside by their anchor. */
    frameCount: number;
    coverage: SatIrCoverage;
    playing: boolean;
    /** The rain scrubber is choosing the frame. */
    following: boolean;
}

const CAPS_TIMEOUT_MS = 10_000;
/**
 * The server publishes hourly and drops its oldest frame. It advertises
 * nearestValue=1, so a stale list naming a dropped frame does NOT get a blank
 * image: it gets the nearest kept frame's pixels (measured: 09Z returned 10Z's
 * bytes), which would be shown under the dropped frame's earlier time. Hence a
 * fresh list every 10 minutes and again whenever a loop starts.
 */
const CAPS_REFRESH_MS = 10 * 60_000;
/** After a failure: capabilities, a frame that would not download, a frame Mapbox could not draw. */
const RETRY_MS = 2 * 60_000;
const FRAME_TIMEOUT_MS = 30_000;
const LOOP_STEP_MS = 1000;
/** Failures in a row that stop the loop: on a dead link it would otherwise ask once a second, for ever. */
const LOOP_MAX_FAILURES = 2;
const ORDER_HEAL_MS = 250;

type ImageSourceLike = { updateImage: (options: { url: string }) => unknown };
type SourceEvent = { sourceId?: string; sourceDataType?: string; error?: unknown };

/** A frame once its bytes have been read: shown with its gain, set aside, or to be asked for again. */
type Prepared = { kind: 'ok'; src: string; scale: number } | { kind: 'skip' } | { kind: 'failed' };

function removeSatLayer(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(SAT_IR_LAYER_ID)) map.removeLayer(SAT_IR_LAYER_ID);
    } catch (error) {
        log.warn('[sat-ir] layer cleanup failed', error);
    }
    try {
        if (map.getSource(SAT_IR_SOURCE_ID)) map.removeSource(SAT_IR_SOURCE_ID);
    } catch (error) {
        log.warn('[sat-ir] source cleanup failed', error);
    }
}

const sameFrames = (a: readonly SatIrFrame[], b: readonly SatIrFrame[]) =>
    a.length === b.length && a.every((f, i) => f.iso === b[i].iso);

/**
 * The cloud belongs above the opaque imagery and under the chart. Misplaced
 * means below the imagery (a restyle buried it) or above an ENC layer (ENC
 * mounted underneath it after it was added). Returns where to move it, or null
 * when it is where it should be — or already as low as the anchor allows,
 * which ends the loop while the imagery itself still sits above the ENC.
 */
export function satIrHealTarget(layers: readonly { id: string; type?: string }[]): string | undefined | null {
    const at = layers.findIndex((l) => l.id === SAT_IR_LAYER_ID);
    if (at < 0) return null;
    const buried = at < imageryTopIndex(layers);
    const enc = layers.findIndex((l) => l.id.startsWith('enc-vec-'));
    const overChart = enc >= 0 && enc < at;
    if (!buried && !overChart) return null;
    const before = cloudOverlayBeforeId(layers);
    if (before === SAT_IR_LAYER_ID || (before !== undefined && layers[at + 1]?.id === before)) return null;
    return before;
}

export function useSatelliteLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabled: boolean,
    /** The rain scrubber's moment (epoch ms) while rain is up and ready; null otherwise. */
    followTimeMs: number | null,
): SatIrState & { setPlaying: (playing: boolean) => void } {
    // Subscribed so switching Satellite Mode re-renders; the policy decides.
    const satelliteMode = useSettingsStore((s) => s.settings?.satelliteMode === true);
    const active = enabled && mapReady;
    const blocked = active && satelliteModeBlocks('raster');
    const mounted = active && !blocked;

    const [frames, setFrames] = useState<SatIrFrame[]>([]);
    const [prepared, setPrepared] = useState<ReadonlyMap<string, Prepared>>(() => new Map());
    const [status, setStatus] = useState<SatIrStatus>('off');
    const [paintedMs, setPaintedMs] = useState<number | null>(null);
    const [coverage, setCoverage] = useState<SatIrCoverage>(SAT_IR_FULL_COVERAGE);
    const [playingState, setPlayingState] = useState(false);
    const [loopIdx, setLoopIdx] = useState(0);
    const loopIdxRef = useRef(0);
    loopIdxRef.current = loopIdx;
    const [capsNonce, setCapsNonce] = useState(0);
    const [remountNonce, setRemountNonce] = useState(0);
    const framesRef = useRef<SatIrFrame[]>([]);
    framesRef.current = frames;
    /** Frames whose bytes are being read, by time: the loop waits for them. */
    const inflightRef = useRef(new Map<string, AbortController>());
    /** Bumped on teardown, so a read that finishes afterwards changes nothing. */
    const generationRef = useRef(0);
    const failuresRef = useRef(0);
    const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The frame last handed to the source, its gain, and whether it has painted. */
    const requestedRef = useRef<{ frame: SatIrFrame; scale: number } | null>(null);
    const pendingRef = useRef(false);
    const shownIsoRef = useRef<string | null>(null);
    const appliedScaleRef = useRef<number | null>(null);

    // Frames whose anchor set them aside are not offered at all.
    const usable = useMemo(() => frames.filter((f) => prepared.get(f.iso)?.kind !== 'skip'), [frames, prepared]);
    const following = typeof followTimeMs === 'number' && Number.isFinite(followTimeMs);
    const playing = playingState && !following && usable.length > 1;
    let targetIdx = usable.length - 1;
    if (following) targetIdx = usable.length > 0 ? Math.max(0, latestFrameAtOrBefore(usable, followTimeMs)) : -1;
    else if (playing) targetIdx = Math.min(loopIdx, usable.length - 1);
    const target = targetIdx >= 0 ? usable[targetIdx] : null;
    const targetIso = target?.iso ?? null;
    const targetPrep = targetIso ? prepared.get(targetIso) : undefined;

    /** A frame failed: say so if nothing is on screen, stop a loop that keeps failing, ask again later. */
    const noteFailure = useCallback(() => {
        failuresRef.current += 1;
        setStatus((s) => (s === 'ready' ? s : 'unavailable'));
        if (failuresRef.current >= LOOP_MAX_FAILURES) setPlayingState(false);
        if (retryRef.current) return;
        retryRef.current = setTimeout(() => {
            retryRef.current = null;
            setPrepared((prev) => {
                if (![...prev.values()].some((p) => p.kind === 'failed')) return prev;
                return new Map([...prev].filter(([, p]) => p.kind !== 'failed'));
            });
            setRemountNonce((n) => n + 1);
        }, RETRY_MS);
    }, []);

    // ── Frame times: from the capabilities, never the clock ──
    useEffect(() => {
        if (!mounted) {
            setStatus(blocked ? 'blocked' : 'off');
            setFrames([]);
            setPaintedMs(null);
            setPlayingState(false);
            return;
        }
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), CAPS_TIMEOUT_MS);
        let disposed = false;
        let retry: ReturnType<typeof setTimeout> | undefined;
        if (framesRef.current.length === 0) setStatus('loading');
        void (async () => {
            try {
                const res = await fetch(SAT_IR_CAPABILITIES_URL, { signal: ctrl.signal });
                if (!res.ok) throw new Error(`capabilities HTTP ${res.status}`);
                const listed = parseGmgsiFrames(await res.text());
                const next = listed ? satIrFrames(listed, Date.now()) : [];
                if (disposed) return;
                if (next.length === 0) throw new Error('no frames listed');
                setFrames((prev) => (sameFrames(prev, next) ? prev : next));
                // A frame the server no longer lists takes its bytes with it.
                const listedNow = new Set(next.map((f) => f.iso));
                setPrepared((prev) =>
                    [...prev.keys()].every((iso) => listedNow.has(iso))
                        ? prev
                        : new Map([...prev].filter(([iso]) => listedNow.has(iso))),
                );
            } catch (error) {
                if (disposed) return;
                log.warn('[sat-ir] capabilities unavailable', error);
                // Frames already on screen stay, their age chip growing honestly;
                // with none, say so rather than paint an empty "clear sky".
                if (framesRef.current.length === 0) setStatus('unavailable');
                retry = setTimeout(() => setCapsNonce((n) => n + 1), RETRY_MS);
            } finally {
                clearTimeout(timeout);
            }
        })();
        const refresh = setInterval(() => setCapsNonce((n) => n + 1), CAPS_REFRESH_MS);
        return () => {
            disposed = true;
            ctrl.abort();
            clearTimeout(timeout);
            clearTimeout(retry);
            clearInterval(refresh);
        };
        // satelliteMode: re-decide when the setting flips (blocked reads it).
    }, [mounted, blocked, satelliteMode, capsNonce]);

    // Every listed frame set aside by its anchor: nothing honest to show.
    useEffect(() => {
        if (mounted && frames.length > 0 && usable.length === 0) setStatus((s) => (s === 'ready' ? s : 'unavailable'));
    }, [mounted, frames.length, usable.length]);

    // ── Teardown: switched off, blocked, or unmounted ──
    const teardown = useCallback(() => {
        generationRef.current += 1;
        for (const ctrl of inflightRef.current.values()) ctrl.abort();
        inflightRef.current.clear();
        if (retryRef.current) clearTimeout(retryRef.current);
        retryRef.current = null;
        failuresRef.current = 0;
        shownIsoRef.current = null;
        pendingRef.current = false;
        appliedScaleRef.current = null;
        const map = mapRef.current;
        if (map) removeSatLayer(map);
    }, [mapRef]);
    useEffect(() => {
        if (mounted) return;
        teardown();
        setPrepared((prev) => (prev.size > 0 ? new Map() : prev));
    }, [mounted, teardown]);
    useEffect(() => teardown, [teardown]);

    // ── Read the target frame's bytes once, and anchor them ──
    useEffect(() => {
        if (!mounted || !target || targetPrep || inflightRef.current.has(target.iso)) return;
        const frame = target;
        const generation = generationRef.current;
        const ctrl = new AbortController();
        inflightRef.current.set(frame.iso, ctrl);
        const timeout = setTimeout(() => ctrl.abort(), FRAME_TIMEOUT_MS);
        void (async () => {
            let result: Prepared;
            try {
                const res = await fetch(satIrImageUrl(frame), { signal: ctrl.signal });
                const type = res.headers.get('content-type') ?? '';
                // GeoServer answers some errors with HTTP 200 and an XML body.
                if (!res.ok || !type.startsWith('image/')) throw new Error(`frame HTTP ${res.status} ${type}`);
                const blob = await res.blob();
                const anchor = satIrAnchor(await satIrTropicalHistogram(blob));
                if (anchor.usable) {
                    result = { kind: 'ok', src: await satIrDataUrl(blob), scale: anchor.scale };
                } else {
                    log.warn('[sat-ir] frame set aside: its stretch cannot be anchored', frame.iso, anchor);
                    result = { kind: 'skip' };
                }
            } catch (error) {
                if (generationRef.current !== generation) return;
                log.warn('[sat-ir] frame failed', frame.iso, error);
                result = { kind: 'failed' };
            } finally {
                clearTimeout(timeout);
                if (inflightRef.current.get(frame.iso) === ctrl) inflightRef.current.delete(frame.iso);
            }
            if (generationRef.current !== generation) return;
            setPrepared((prev) => new Map(prev).set(frame.iso, result));
            if (result.kind === 'failed') noteFailure();
        })();
        // No abort when the target moves on: the loop and the scrubber come back
        // to this frame, and teardown aborts everything still in flight.
        // target is identified by its time.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mounted, targetIso, targetPrep, noteFailure]);

    // ── Show the target frame through the one source ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mounted || !target || targetPrep?.kind !== 'ok') return;
        const source = map.getSource(SAT_IR_SOURCE_ID) as unknown as ImageSourceLike | undefined;
        if (source && shownIsoRef.current === target.iso) return;
        try {
            requestedRef.current = { frame: target, scale: targetPrep.scale };
            pendingRef.current = true;
            if (source) {
                source.updateImage({ url: targetPrep.src });
            } else {
                map.addSource(SAT_IR_SOURCE_ID, {
                    type: 'image',
                    url: targetPrep.src,
                    coordinates: satIrImageCoordinates(),
                });
                map.addLayer(
                    {
                        id: SAT_IR_LAYER_ID,
                        type: 'raster',
                        source: SAT_IR_SOURCE_ID,
                        paint: satIrPaint(targetPrep.scale),
                    },
                    cloudOverlayBeforeId(map.getStyle()?.layers ?? []),
                );
                appliedScaleRef.current = targetPrep.scale;
            }
            shownIsoRef.current = target.iso;
        } catch (error) {
            // Style mid-swap: the styledata watcher below re-mounts.
            pendingRef.current = false;
            log.warn('[sat-ir] mount failed', error);
        }
        // target is identified by its time.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mounted, targetIso, targetPrep, remountNonce, mapRef]);

    // ── Painted, failed, panned, restyled ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mounted) return;
        // 'metadata' is what an image source fires once a requested image has
        // arrived and been decoded (its first fire, and again per updateImage).
        // The frame's gain goes on in the same render as its pixels.
        const onData = (e: SourceEvent) => {
            if (e?.sourceId !== SAT_IR_SOURCE_ID || e.sourceDataType !== 'metadata' || !pendingRef.current) return;
            pendingRef.current = false;
            const painted = requestedRef.current;
            if (painted && appliedScaleRef.current !== painted.scale) {
                try {
                    map.setPaintProperty(SAT_IR_LAYER_ID, 'raster-color-mix', satIrColorMix(painted.scale));
                    appliedScaleRef.current = painted.scale;
                } catch (error) {
                    log.warn('[sat-ir] gain not applied', error);
                }
            }
            if (painted) setPaintedMs(painted.frame.timeMs);
            failuresRef.current = 0;
            setStatus('ready');
        };
        const onError = (e: SourceEvent) => {
            if (e?.sourceId !== SAT_IR_SOURCE_ID) return;
            // The previous frame stays on screen (Mapbox keeps its texture) and
            // the chip keeps naming THAT frame; the retry hands this one over again.
            pendingRef.current = false;
            shownIsoRef.current = null;
            log.warn('[sat-ir] frame not drawn', e.error);
            noteFailure();
        };
        const onMove = () => {
            try {
                const bounds = map.getBounds();
                const next = satIrCoverage({
                    centreLat: map.getCenter().lat,
                    north: bounds?.getNorth(),
                    south: bounds?.getSouth(),
                });
                setCoverage((prev) => (sameSatIrCoverage(prev, next) ? prev : next));
            } catch {
                /* map mid-teardown */
            }
        };
        // Coalesced and conditional, like the rain and squall healers: a write
        // inside a styledata pass re-fires it, and mutating mid-render crashes
        // placement.
        let healTimer: ReturnType<typeof setTimeout> | null = null;
        const onStyle = () => {
            if (healTimer) return;
            healTimer = setTimeout(() => {
                healTimer = null;
                try {
                    const layers = map.getStyle()?.layers ?? [];
                    if (!layers.some((l) => l.id === SAT_IR_LAYER_ID)) {
                        if (shownIsoRef.current) {
                            shownIsoRef.current = null;
                            setRemountNonce((n) => n + 1);
                        }
                        return;
                    }
                    const before = satIrHealTarget(layers);
                    if (before !== null) map.moveLayer(SAT_IR_LAYER_ID, before);
                } catch {
                    /* style in transit: the next pass retries */
                }
            }, ORDER_HEAL_MS);
        };
        map.on('sourcedata', onData);
        map.on('error', onError);
        map.on('moveend', onMove);
        map.on('styledata', onStyle);
        onMove();
        return () => {
            if (healTimer) clearTimeout(healTimer);
            map.off('sourcedata', onData);
            map.off('error', onError);
            map.off('moveend', onMove);
            map.off('styledata', onStyle);
        };
    }, [mounted, mapRef, noteFailure]);

    // ── The loop: one step a second, never ahead of the paint ──
    useEffect(() => {
        if (!mounted || !playing) return;
        const count = usable.length;
        let held = false;
        const timer = setInterval(() => {
            if (pendingRef.current || inflightRef.current.size > 0 || document.hidden) return;
            const at = loopIdxRef.current;
            // The newest frame stays up a beat longer: it is the one that matters.
            if (at >= count - 1 && !held) {
                held = true;
                return;
            }
            held = false;
            setLoopIdx((at + 1) % count);
        }, LOOP_STEP_MS);
        return () => clearInterval(timer);
    }, [mounted, playing, usable.length]);

    // The rain scrubber takes the clock: the skipper's own loop ends.
    useEffect(() => {
        if (following) setPlayingState(false);
    }, [following]);

    const setPlaying = useCallback((next: boolean) => {
        if (next) {
            // From the oldest frame forward, so the motion reads the right way,
            // on a fresh list so a frame the server has just dropped is not asked for.
            setLoopIdx(0);
            failuresRef.current = 0;
            setCapsNonce((n) => n + 1);
        }
        setPlayingState(next);
    }, []);

    return {
        status,
        frameTimeMs: paintedMs,
        frameCount: usable.length,
        coverage,
        playing,
        following,
        setPlaying,
    };
}
