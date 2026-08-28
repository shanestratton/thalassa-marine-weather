/**
 * EssentialMapSlide — Rainbow.ai rain radar card for the HeroSlide carousel.
 *
 * Frames the punter's position ~300 nm in every direction on a static Mapbox
 * basemap, with observed radar (RainViewer) and Rainbow.ai nowcast frames
 * pre-composited by radarGlassEngine into container-sized canvases. The
 * scrubber and playback crossfade between adjacent frames on a plain 2D
 * canvas — zero WebGL, per this card's no-GPU-heating design.
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { UnitPreferences } from '../../../types';
import { convertSpeed, degreesToCardinal } from '../../../utils';
import { getMapboxKey } from '../../../services/weather/keys';
import { SafeImage } from '../../ui/SafeImage';
import {
    RADAR_OPACITY,
    RADAR_RADIUS_NM,
    RadarTimeline,
    RadarView,
    buildBasemapUrl,
    computeRadarView,
    getFrameCanvas,
    loadRadarFrames,
    planRadarFrames,
} from './radarGlassEngine';

interface EssentialMapSlideProps {
    slideIdx: number;
    isGolden: boolean;
    isCardDay: boolean;
    /**
     * Is this card sitting on a FORECAST day rather than today?
     *
     * The radar is always a live sweep — this component takes no date and
     * planRadarFrames() opens at Date.now(). On today's card that is exactly
     * right. On Thursday's card an unqualified "LIVE" badge is true about the
     * frame and misleading about the day, so it has to say which.
     */
    isForecastDay?: boolean;
    coordinates?: { lat: number; lon: number };
    windSpeed?: number | null;
    windDirection?: number | null;
    windGust?: number | null;
    condition?: string | null;
    units?: UnitPreferences;
    onMapTap?: () => void;
}

/** Full-range playback duration in real seconds. */
const PLAY_SWEEP_SECONDS = 10;
/** Re-plan cadence while the card stays mounted (new snapshot every ~10 min). */
const REFRESH_MS = 5 * 60 * 1000;
/** Pinch ceiling: 6× ≈ a 50 nm view radius from the 300 nm base frame. */
const MAX_ZOOM_FACTOR = 6;

export const EssentialMapSlide: React.FC<EssentialMapSlideProps> = ({
    slideIdx: _slideIdx,
    isGolden,
    isCardDay,
    isForecastDay = false,
    coordinates,
    windSpeed,
    windDirection,
    windGust: _windGust,
    condition,
    units,
    onMapTap,
}) => {
    const lon = coordinates?.lon ?? 153.02;
    const lat = coordinates?.lat ?? -27.47;

    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const scrubberRef = useRef<HTMLDivElement>(null);

    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
    const [inView, setInView] = useState(false);
    /**
     * Live on-screen state — NOT latched, unlike `inView`.
     *
     * The Glass hero is a carousel of ~226 slides (every day × every hour),
     * and in essential mode EVERY slide mounts this card. A CSS animation
     * runs whether or not its element is on screen, so the pulsing location
     * halo registered ~226 accelerated animations with the compositor at
     * once — WebKit kills the WebContent process past 129 queued
     * AcceleratedAnimationDidStart messages, which is the crash that threw
     * Shane out to the Glass (measured 2026-08-04: "ping×226").
     */
    const [onScreen, setOnScreen] = useState(false);
    const [mapLoaded, setMapLoaded] = useState(false);
    const [timeline, setTimeline] = useState<RadarTimeline | null>(null);
    const [loadedIds, setLoadedIds] = useState<ReadonlySet<string>>(new Set());
    const [radarFailed, setRadarFailed] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [posSec, setPosSec] = useState(0);
    const posRef = useRef(0);
    const [refreshNonce, setRefreshNonce] = useState(0);

    // Pinch zoom-in. 1 = the 300 nm base frame, which is also the hard
    // zoom-OUT floor. Always north-up, always centred on the punter — zoom
    // only, no pan, no rotation. Radar zoom is a painter crop of the already-
    // composited frames (instant, zero refetch); the basemap CSS-scales
    // during the gesture and re-renders crisp once the factor settles.
    const [zoomFactor, setZoomFactor] = useState(1);
    const zoomFactorRef = useRef(1);
    const [settledFactor, setSettledFactor] = useState(1);
    const [displayedBasemap, setDisplayedBasemap] = useState<{ url: string; factor: number } | null>(null);

    // ── Measure the card + defer work until it scrolls into view ──
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (!rect) return;
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            if (w >= 50 && h >= 50) {
                setSize((prev) => (prev && Math.abs(prev.w - w) < 8 && Math.abs(prev.h - h) < 8 ? prev : { w, h }));
            }
        });
        ro.observe(el);
        const io = new IntersectionObserver(
            (entries) => {
                const intersecting = entries.some((e) => e.isIntersecting);
                // `inView` LATCHES (once loaded, keep the frames warm so
                // scrolling back is instant); `onScreen` tracks live
                // visibility and gates anything that costs while offscreen.
                if (intersecting) setInView(true);
                setOnScreen(intersecting);
            },
            { threshold: 0.2 },
        );
        io.observe(el);
        return () => {
            ro.disconnect();
            io.disconnect();
        };
    }, []);

    const view: RadarView | null = useMemo(
        () => (size ? computeRadarView(lat, lon, size.w, size.h) : null),
        // Round coords so GPS jitter doesn't rebuild the frame cache.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [size, lat.toFixed(3), lon.toFixed(3)],
    );

    // ── Basemap ───────────────────────────────────────────────
    // Preload the target URL and only then swap it in, so a zoom settle never
    // blanks the img while the sharper render is still in flight.
    const token = getMapboxKey();
    const targetBasemapUrl = view && token && inView ? buildBasemapUrl(view, token, Math.log2(settledFactor)) : '';
    useEffect(() => {
        if (!targetBasemapUrl) return;
        let cancelled = false;
        const factor = settledFactor;
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.onload = () => {
            if (cancelled) return;
            setDisplayedBasemap({ url: targetBasemapUrl, factor });
            setMapLoaded(true);
        };
        img.src = targetBasemapUrl;
        return () => {
            cancelled = true;
        };
    }, [targetBasemapUrl, settledFactor]);

    // ── Painter: crossfade the two frames bracketing posRef ───
    const paint = useCallback(() => {
        const canvas = canvasRef.current;
        const v = view;
        if (!canvas || !v) return;
        if (canvas.width !== v.wCss || canvas.height !== v.hCss) {
            canvas.width = v.wCss;
            canvas.height = v.hCss;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const frames = timeline?.frames ?? [];
        if (frames.length === 0) return;

        const t0 = frames[0].time;
        const tN = frames[frames.length - 1].time;
        const pos = Math.min(tN, Math.max(t0, posRef.current));
        let i = 0;
        while (i < frames.length - 1 && frames[i + 1].time <= pos) i++;

        // Nearest loaded frame at or below i, and the next loaded one above.
        let below = -1;
        for (let k = i; k >= 0; k--) {
            if (getFrameCanvas(frames[k], v)) {
                below = k;
                break;
            }
        }
        let above = -1;
        for (let k = i + 1; k < frames.length; k++) {
            if (getFrameCanvas(frames[k], v)) {
                above = k;
                break;
            }
        }
        if (below === -1 && above === -1) return;

        const a = below !== -1 ? frames[below] : frames[above];
        const b = above !== -1 ? frames[above] : frames[below];
        const ca = getFrameCanvas(a, v);
        const cb = getFrameCanvas(b, v);
        if (!ca || !cb) return;

        // Pinch zoom = crop a centred sub-rect of the composited frame. The
        // frames themselves never re-render for zoom; radar data is coarser
        // than css pixels so the upscale reads as normal radar softness.
        const f = zoomFactorRef.current;
        const drawFrame = (c: HTMLCanvasElement, alpha: number) => {
            ctx.globalAlpha = alpha;
            if (f > 1.001) {
                const sw = canvas.width / f;
                const sh = canvas.height / f;
                ctx.drawImage(
                    c,
                    (canvas.width - sw) / 2,
                    (canvas.height - sh) / 2,
                    sw,
                    sh,
                    0,
                    0,
                    canvas.width,
                    canvas.height,
                );
            } else {
                ctx.drawImage(c, 0, 0);
            }
        };
        if (a === b || b.time <= a.time) {
            drawFrame(ca, RADAR_OPACITY);
        } else {
            const frac = Math.min(1, Math.max(0, (pos - a.time) / (b.time - a.time)));
            drawFrame(ca, RADAR_OPACITY * (1 - frac));
            drawFrame(cb, RADAR_OPACITY * frac);
        }
        ctx.globalAlpha = 1;
    }, [view, timeline]);

    const setPos = useCallback(
        (sec: number) => {
            posRef.current = sec;
            setPosSec(sec);
            paint();
        },
        [paint],
    );

    // ── Pinch zoom ────────────────────────────────────────────
    const applyZoomFactor = useCallback(
        (next: number) => {
            const clamped = Math.min(MAX_ZOOM_FACTOR, Math.max(1, next));
            zoomFactorRef.current = clamped;
            setZoomFactor(clamped);
            paint();
        },
        [paint],
    );

    // Re-render the basemap crisp shortly after the fingers settle.
    useEffect(() => {
        const timer = setTimeout(() => setSettledFactor(zoomFactorRef.current), 350);
        return () => clearTimeout(timer);
    }, [zoomFactor]);

    // A location/size change re-frames at the 300 nm base.
    useEffect(() => {
        zoomFactorRef.current = 1;
        setZoomFactor(1);
        setSettledFactor(1);
    }, [view?.key]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        let gestureStartFactor = 1;

        // WKWebView reports pinches through WebKit's proprietary gesture
        // events with a ready-made scale — use them when present.
        type WebKitGestureEvent = Event & { scale?: number };
        if (typeof window !== 'undefined' && 'GestureEvent' in window) {
            const onStart = (e: WebKitGestureEvent) => {
                e.preventDefault();
                gestureStartFactor = zoomFactorRef.current;
            };
            const onChange = (e: WebKitGestureEvent) => {
                e.preventDefault();
                if (typeof e.scale === 'number') applyZoomFactor(gestureStartFactor * e.scale);
            };
            const onEnd = (e: WebKitGestureEvent) => e.preventDefault();
            el.addEventListener('gesturestart', onStart as EventListener);
            el.addEventListener('gesturechange', onChange as EventListener);
            el.addEventListener('gestureend', onEnd as EventListener);
            return () => {
                el.removeEventListener('gesturestart', onStart as EventListener);
                el.removeEventListener('gesturechange', onChange as EventListener);
                el.removeEventListener('gestureend', onEnd as EventListener);
            };
        }

        // Pointer-pair fallback for dev browsers. Single-pointer input is
        // deliberately untouched so the hero carousel still swipes.
        const pointers = new Map<number, { x: number; y: number }>();
        let startDist = 0;
        const currentDist = () => {
            const [a, b] = [...pointers.values()];
            return Math.hypot(a.x - b.x, a.y - b.y);
        };
        const onDown = (e: PointerEvent) => {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) {
                startDist = currentDist();
                gestureStartFactor = zoomFactorRef.current;
            }
        };
        const onMove = (e: PointerEvent) => {
            if (!pointers.has(e.pointerId)) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2 && startDist > 0) {
                applyZoomFactor((gestureStartFactor * currentDist()) / startDist);
            }
        };
        const onUp = (e: PointerEvent) => {
            pointers.delete(e.pointerId);
            startDist = 0;
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        return () => {
            el.removeEventListener('pointerdown', onDown);
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
        };
    }, [applyZoomFactor]);

    // ── Plan + load frames ────────────────────────────────────
    useEffect(() => {
        if (!view || !inView) return;
        let cancelled = false;
        const abort = new AbortController();
        (async () => {
            const tl = await planRadarFrames();
            if (cancelled) return;
            if (tl.frames.length === 0) {
                setRadarFailed(true);
                return;
            }
            setRadarFailed(false);
            setTimeline(tl);
            // Land on NOW (keep the user's scrub position across refreshes).
            const nowTime = tl.frames[tl.nowIdx].time;
            const prev = posRef.current;
            const keepPos =
                refreshNonce > 0 && prev >= tl.frames[0].time && prev <= tl.frames[tl.frames.length - 1].time;
            posRef.current = keepPos ? prev : nowTime;
            setPosSec(posRef.current);
            await loadRadarFrames(tl, view, abort.signal, (frame) => {
                if (cancelled) return;
                setLoadedIds((prevIds) => {
                    const next = new Set(prevIds);
                    next.add(frame.id);
                    return next;
                });
            });
        })();
        return () => {
            cancelled = true;
            abort.abort();
        };
    }, [view, inView, refreshNonce]);

    // Repaint whenever a frame lands, the timeline/view changes, or the
    // canvas remounts on scroll-back (`onScreen` — it only exists while the
    // slide is visible; frames come straight from the module cache).
    useEffect(() => {
        if (!onScreen) return;
        paint();
    }, [paint, loadedIds, onScreen]);

    // Periodic refresh — picks up new Rainbow snapshots / radar history.
    useEffect(() => {
        if (!inView) return;
        const timer = setInterval(() => {
            if (!document.hidden) setRefreshNonce((n) => n + 1);
        }, REFRESH_MS);
        return () => clearInterval(timer);
    }, [inView]);

    // ── Playback ──────────────────────────────────────────────
    useEffect(() => {
        if (!isPlaying || !timeline || timeline.frames.length < 2) return;
        const t0 = timeline.frames[0].time;
        const tN = timeline.frames[timeline.frames.length - 1].time;
        const speed = (tN - t0) / PLAY_SWEEP_SECONDS;
        let raf = 0;
        let last = performance.now();
        const step = (now: number) => {
            const dt = (now - last) / 1000;
            last = now;
            if (!document.hidden) {
                let next = posRef.current + dt * speed;
                if (next > tN) next = t0;
                posRef.current = next;
                setPosSec(next);
                paint();
            }
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [isPlaying, timeline, paint]);

    // ── Scrubber ──────────────────────────────────────────────
    const range = useMemo(() => {
        const frames = timeline?.frames ?? [];
        if (frames.length < 2) return null;
        return { t0: frames[0].time, tN: frames[frames.length - 1].time };
    }, [timeline]);

    const handleScrub = useCallback(
        (clientX: number) => {
            if (!scrubberRef.current || !range) return;
            const rect = scrubberRef.current.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            setIsPlaying(false);
            setPos(range.t0 + pct * (range.tN - range.t0));
        },
        [range, setPos],
    );

    const nowSec = Date.now() / 1000;
    const progressPct = range ? ((posSec - range.t0) / (range.tN - range.t0)) * 100 : 0;
    const nowPct =
        range && timeline ? ((timeline.frames[timeline.nowIdx].time - range.t0) / (range.tN - range.t0)) * 100 : 0;

    const activeFrame = useMemo(() => {
        const frames = timeline?.frames ?? [];
        if (frames.length === 0) return null;
        let best = frames[0];
        for (const f of frames) {
            if (Math.abs(f.time - posSec) < Math.abs(best.time - posSec)) best = f;
        }
        return best;
    }, [timeline, posSec]);
    const isLive = !!timeline && !!activeFrame && activeFrame === timeline.frames[timeline.nowIdx];

    const relativeLabel = useMemo(() => {
        if (!activeFrame) return '';
        const diffMin = Math.round((posSec - nowSec) / 60);
        if (Math.abs(diffMin) < 3) return 'NOW';
        const sign = diffMin < 0 ? '-' : '+';
        const abs = Math.abs(diffMin);
        return abs < 60 ? `${sign}${abs}m` : `${sign}${(abs / 60).toFixed(1).replace(/\.0$/, '')}h`;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeFrame, posSec]);
    const clockLabel = useMemo(() => {
        if (!range) return '';
        return new Date(posSec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }, [range, posSec]);

    // ── Wind + misc display ───────────────────────────────────
    const displaySpeed = useMemo(() => {
        if (windSpeed == null) return null;
        const s = units?.speed ?? 'knots';
        return Math.round(convertSpeed(windSpeed, s) || 0);
    }, [windSpeed, units?.speed]);
    const speedUnit = units?.speed === 'mph' ? 'mph' : units?.speed === 'kmh' ? 'km/h' : 'kts';
    const windLabel = windDirection != null ? degreesToCardinal(windDirection) : '';

    // Range rings adapt to zoom: the smaller dimension's edge is 300/zoom nm
    // out, and the spacing steps down (100→50→25→10) so at least two rings
    // stay visible however far in the punter pinches.
    const rings = useMemo(() => {
        if (!size) return null;
        const half = Math.min(size.w, size.h) / 2;
        const visibleNm = RADAR_RADIUS_NM / zoomFactor;
        const spacing = [100, 50, 25, 10].find((s) => s * 2 <= visibleNm) ?? 10;
        const radii: { nm: number; px: number }[] = [];
        for (let nm = spacing; nm <= visibleNm * 1.02 && radii.length < 6; nm += spacing) {
            radii.push({ nm, px: (nm / visibleNm) * half });
        }
        return { cx: size.w / 2, cy: size.h / 2, radii };
    }, [size, zoomFactor]);

    return (
        <div className="relative w-full h-full flex flex-col">
            <div
                ref={containerRef}
                className={`relative flex-1 min-h-0 w-full rounded-2xl overflow-hidden border bg-slate-900/60 ${isGolden ? 'border-amber-400/[0.15]' : isCardDay ? 'border-white/[0.08]' : 'border-sky-300/[0.08]'}`}
            >
                {/* Layer 1: basemap — rendered at the exact container size/zoom.
                    Mid-pinch it CSS-scales from the last rendered factor; once
                    settled, the crisp re-render swaps in at scale(1). */}
                {displayedBasemap && (
                    <SafeImage
                        src={displayedBasemap.url}
                        alt="Location map"
                        className="absolute inset-0 w-full h-full"
                        style={{
                            opacity: mapLoaded ? 1 : 0,
                            transition: 'opacity 600ms ease-in',
                            transform: `scale(${(zoomFactor / displayedBasemap.factor).toFixed(4)})`,
                            transformOrigin: 'center center',
                        }}
                        loading="eager"
                        draggable={false}
                    />
                )}

                {/* Layer 2: radar crossfade canvas — exists ONLY while this
                    slide is actually on screen. A canvas allocates ~600KB of
                    UNPURGEABLE backing store the moment the painter sizes it,
                    and the hero carousel mounts ~226 of these cards; sizing
                    them all in one mount burst was ~130MB of renderer memory
                    — a jetsam kill wearing the animation flood's clothing.
                    Composited frames live in the module cache, so remounting
                    the canvas on return repaints instantly with no refetch. */}
                {onScreen && <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />}

                {/* Layer 3: range rings — spacing adapts to pinch zoom */}
                {rings && rings.radii.length > 0 && (
                    <svg
                        className="absolute inset-0 pointer-events-none"
                        width={size?.w}
                        height={size?.h}
                        viewBox={`0 0 ${size?.w} ${size?.h}`}
                        aria-hidden="true"
                    >
                        {rings.radii.map((r, i) => (
                            <circle
                                key={r.nm}
                                cx={rings.cx}
                                cy={rings.cy}
                                r={r.px}
                                fill="none"
                                stroke="rgba(255,255,255,0.07)"
                                strokeWidth={1}
                                strokeDasharray={i === rings.radii.length - 1 ? 'none' : '3 5'}
                            />
                        ))}
                        <text
                            x={rings.cx}
                            y={rings.cy - rings.radii[rings.radii.length - 1].px + 14}
                            textAnchor="middle"
                            fill="rgba(255,255,255,0.25)"
                            style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}
                        >
                            {rings.radii[rings.radii.length - 1].nm} nm
                        </text>
                    </svg>
                )}

                {/* Layer 4: vignette */}
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{ background: 'radial-gradient(ellipse at 50% 50%, transparent 30%, rgba(0,0,0,0.6) 100%)' }}
                />

                {/* Layer 5: location dot */}
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="relative">
                        <div
                            className="w-2 h-2 rounded-full bg-sky-400"
                            style={{ boxShadow: '0 0 8px rgba(56,189,248,0.5)' }}
                        />
                        {/* Halo ONLY while this slide is actually on screen —
                            see the `onScreen` note above. Offscreen slides
                            kept ~226 of these animating at once and killed
                            the renderer. */}
                        {onScreen && (
                            <div
                                className="absolute -inset-2 rounded-full border border-sky-400/25 animate-ping"
                                style={{ animationDuration: '3s' }}
                            />
                        )}
                    </div>
                </div>

                {/* Tap-to-open overlay — covers map area but not scrubber controls */}
                {onMapTap && (
                    <button
                        aria-label="Open full map"
                        onClick={onMapTap}
                        className="absolute inset-0 bottom-12 cursor-pointer z-[1]"
                        style={{ background: 'transparent' }}
                    />
                )}

                {/* Layer 6: scrubber — play, buffered ticks, thumb, clock */}
                {range && timeline && (
                    <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-2" style={{ pointerEvents: 'auto' }}>
                        <div className="flex items-center gap-2">
                            <button
                                aria-label={isPlaying ? 'Pause radar animation' : 'Play radar animation'}
                                onClick={() => setIsPlaying((p) => !p)}
                                className="hit-target-44 w-7 h-7 shrink-0 rounded-full bg-white/10 backdrop-blur-md border border-white/[0.12] flex items-center justify-center active:scale-90 transition-all"
                            >
                                {isPlaying ? (
                                    <svg className="w-3 h-3 text-white/80" fill="currentColor" viewBox="0 0 24 24">
                                        <rect x="6" y="4" width="4" height="16" rx="1" />
                                        <rect x="14" y="4" width="4" height="16" rx="1" />
                                    </svg>
                                ) : (
                                    <svg
                                        className="w-3 h-3 text-white/80 ml-0.5"
                                        fill="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path d="M8 5v14l11-7z" />
                                    </svg>
                                )}
                            </button>

                            <div
                                ref={scrubberRef}
                                className="flex-1 relative h-9 flex items-center cursor-pointer"
                                style={{ touchAction: 'none' }}
                                onPointerDown={(e) => {
                                    e.currentTarget.setPointerCapture?.(e.pointerId);
                                    handleScrub(e.clientX);
                                }}
                                onPointerMove={(e) => {
                                    if (e.buttons > 0) handleScrub(e.clientX);
                                }}
                            >
                                <div className="w-full h-[3px] rounded-full bg-white/[0.08] relative overflow-visible">
                                    {/* Progress fill: sky for observed, amber past NOW */}
                                    <div
                                        className="absolute inset-y-0 left-0 rounded-full overflow-hidden"
                                        style={{ width: `${progressPct}%` }}
                                    >
                                        {/* Inner bar spans the full track so the sky→amber
                                            hard stop stays anchored at NOW while the outer
                                            div clips to the playhead. */}
                                        <div
                                            className="absolute inset-y-0 left-0"
                                            style={{
                                                width: progressPct > 0 ? `${(100 / progressPct) * 100}%` : '0%',
                                                background: `linear-gradient(90deg, rgba(56,189,248,0.35) 0%, rgba(56,189,248,0.6) ${nowPct}%, rgba(251,191,36,0.6) ${nowPct}%, rgba(251,191,36,0.45) 100%)`,
                                            }}
                                        />
                                    </div>
                                    {/* Buffered frame ticks */}
                                    {timeline.frames.map((f) => {
                                        const left = ((f.time - range.t0) / (range.tN - range.t0)) * 100;
                                        return (
                                            <div
                                                key={f.id}
                                                className="absolute top-1/2 -translate-y-1/2 w-[2px] h-[2px] rounded-full"
                                                style={{
                                                    left: `${left}%`,
                                                    background: loadedIds.has(f.id)
                                                        ? 'rgba(255,255,255,0.45)'
                                                        : 'rgba(255,255,255,0.12)',
                                                }}
                                            />
                                        );
                                    })}
                                    {/* NOW marker */}
                                    <div
                                        className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-white/30"
                                        style={{ left: `${nowPct}%` }}
                                    />
                                    {/* Thumb */}
                                    <div
                                        className="absolute top-1/2 w-3.5 h-3.5 rounded-full bg-sky-400 border-2 border-white/30"
                                        style={{
                                            left: `${progressPct}%`,
                                            transform: 'translateX(-50%) translateY(-50%)',
                                            boxShadow: '0 0 8px rgba(56,189,248,0.5)',
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="shrink-0 min-w-[44px] text-right">
                                <span className="text-[11px] text-white/50 font-mono font-semibold tabular-nums">
                                    {clockLabel}
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Layer 7: LIVE / FORECAST / history badge — top-left */}
                <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
                    {isLive && (
                        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/20">
                            <div
                                className={`w-1.5 h-1.5 rounded-full bg-emerald-400 ${onScreen ? 'animate-pulse' : ''}`}
                            />
                            <span className="text-[11px] text-emerald-300/80 font-bold tracking-wider">LIVE</span>
                        </div>
                    )}
                    {/* On a forecast day the sweep above is still NOW. Say so
                        next to the badge that would otherwise be read as "this
                        is what Thursday looks like". Amber, because it is a
                        caution about what you are looking at. */}
                    {isLive && isForecastDay && (
                        <div className="px-1.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/25">
                            <span className="text-[11px] text-amber-300/90 font-bold tracking-wider">NOT FORECAST</span>
                        </div>
                    )}
                    {!isLive && activeFrame?.kind === 'forecast' && (
                        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/20">
                            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                            <span className="text-[11px] text-amber-300/80 font-bold tracking-wider">FORECAST</span>
                            <span className="text-[11px] text-amber-300/50 font-mono font-semibold">
                                {relativeLabel}
                            </span>
                        </div>
                    )}
                    {!isLive && activeFrame?.kind === 'past' && (
                        <div className="px-1.5 py-0.5 rounded-md bg-black/40 backdrop-blur-sm border border-white/[0.06]">
                            <span className="text-[11px] text-white/50 font-mono font-semibold tabular-nums">
                                {relativeLabel}
                            </span>
                        </div>
                    )}
                    {radarFailed && (
                        <div className="px-1.5 py-0.5 rounded-md bg-black/40 backdrop-blur-sm border border-white/[0.06]">
                            <span className="text-[11px] text-white/40 font-medium">Radar unavailable</span>
                        </div>
                    )}
                </div>

                {/* Layer 8: wind badge — bottom-left, above scrubber */}
                {displaySpeed != null && (
                    <div className="absolute bottom-12 left-2.5 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/50 backdrop-blur-sm border border-white/[0.06]">
                        {windDirection != null && (
                            <div
                                className="w-3.5 h-3.5 flex items-center justify-center"
                                style={{ transform: `rotate(${windDirection + 180}deg)` }}
                            >
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                    <path d="M5 0L3 8h4L5 0z" fill="rgba(56,189,248,0.9)" />
                                </svg>
                            </div>
                        )}
                        <span className="text-[11px] text-white/70 font-semibold leading-none tracking-wide">
                            {windLabel} {displaySpeed}
                            <span className="text-white/50 ml-0.5">{speedUnit}</span>
                        </span>
                    </div>
                )}

                {/* Layer 9: condition — top-right */}
                {condition && (
                    <div className="absolute top-2.5 right-2.5 px-2 py-1 rounded-lg bg-black/50 backdrop-blur-sm border border-white/[0.06]">
                        <span className="text-[11px] text-white/50 font-medium tracking-wide">{condition}</span>
                    </div>
                )}

                {/* Attribution follows the active frame's source */}
                {activeFrame?.source === 'rainviewer' && (
                    <a
                        href="https://www.rainviewer.com/"
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="absolute bottom-12 right-2.5 z-[2] rounded-md bg-black/45 px-1.5 py-0.5 text-[9px] font-semibold text-white/45 backdrop-blur-sm"
                        aria-label="Rain radar data by RainViewer"
                    >
                        RainViewer
                    </a>
                )}
                {activeFrame?.source === 'rainbow' && (
                    <a
                        href="https://rainbow.ai/"
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="absolute bottom-12 right-2.5 z-[2] rounded-md bg-black/45 px-1.5 py-0.5 text-[9px] font-semibold text-white/45 backdrop-blur-sm"
                        aria-label="Nowcast data by Rainbow.ai"
                    >
                        Rainbow.ai
                    </a>
                )}
            </div>
        </div>
    );
};
