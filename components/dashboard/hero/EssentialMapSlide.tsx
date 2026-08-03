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

export const EssentialMapSlide: React.FC<EssentialMapSlideProps> = ({
    slideIdx: _slideIdx,
    isGolden,
    isCardDay,
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
    const [mapLoaded, setMapLoaded] = useState(false);
    const [timeline, setTimeline] = useState<RadarTimeline | null>(null);
    const [loadedIds, setLoadedIds] = useState<ReadonlySet<string>>(new Set());
    const [radarFailed, setRadarFailed] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [posSec, setPosSec] = useState(0);
    const posRef = useRef(0);
    const [refreshNonce, setRefreshNonce] = useState(0);

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
                if (entries.some((e) => e.isIntersecting)) setInView(true);
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
    const token = getMapboxKey();
    const basemapUrl = view && token && inView ? buildBasemapUrl(view, token) : '';
    useEffect(() => {
        if (!basemapUrl) return;
        setMapLoaded(false);
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.onload = () => setMapLoaded(true);
        img.src = basemapUrl;
    }, [basemapUrl]);

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
        if (a === b || b.time <= a.time) {
            ctx.globalAlpha = RADAR_OPACITY;
            ctx.drawImage(ca, 0, 0);
        } else {
            const frac = Math.min(1, Math.max(0, (pos - a.time) / (b.time - a.time)));
            ctx.globalAlpha = RADAR_OPACITY * (1 - frac);
            ctx.drawImage(ca, 0, 0);
            ctx.globalAlpha = RADAR_OPACITY * frac;
            ctx.drawImage(cb, 0, 0);
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

    // Repaint whenever a frame lands or the timeline/view changes.
    useEffect(() => {
        paint();
    }, [paint, loadedIds]);

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

    // Range rings: 300 nm = half the smaller dimension by construction.
    const rings = useMemo(() => {
        if (!size) return null;
        const half = Math.min(size.w, size.h) / 2;
        return { cx: size.w / 2, cy: size.h / 2, radii: [half / 3, (2 * half) / 3, half] };
    }, [size]);

    return (
        <div className="relative w-full h-full flex flex-col">
            <div
                ref={containerRef}
                className={`relative flex-1 min-h-0 w-full rounded-2xl overflow-hidden border bg-slate-900/60 ${isGolden ? 'border-amber-400/[0.15]' : isCardDay ? 'border-white/[0.08]' : 'border-sky-300/[0.08]'}`}
            >
                {/* Layer 1: basemap — rendered at the exact container size/zoom */}
                {basemapUrl && (
                    <SafeImage
                        src={basemapUrl}
                        alt="Location map"
                        className="absolute inset-0 w-full h-full"
                        style={{ opacity: mapLoaded ? 1 : 0, transition: 'opacity 600ms ease-in' }}
                        loading="eager"
                        draggable={false}
                    />
                )}

                {/* Layer 2: radar crossfade canvas */}
                <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

                {/* Layer 3: range rings — 100/200/300 nm */}
                {rings && (
                    <svg
                        className="absolute inset-0 pointer-events-none"
                        width={size?.w}
                        height={size?.h}
                        viewBox={`0 0 ${size?.w} ${size?.h}`}
                        aria-hidden="true"
                    >
                        {rings.radii.map((r, i) => (
                            <circle
                                key={i}
                                cx={rings.cx}
                                cy={rings.cy}
                                r={r}
                                fill="none"
                                stroke="rgba(255,255,255,0.07)"
                                strokeWidth={1}
                                strokeDasharray={i === 2 ? 'none' : '3 5'}
                            />
                        ))}
                        <text
                            x={rings.cx}
                            y={rings.cy - rings.radii[2] + 14}
                            textAnchor="middle"
                            fill="rgba(255,255,255,0.25)"
                            style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}
                        >
                            300 nm
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
                        <div
                            className="absolute -inset-2 rounded-full border border-sky-400/25 animate-ping"
                            style={{ animationDuration: '3s' }}
                        />
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
                                className="w-7 h-7 shrink-0 rounded-full bg-white/10 backdrop-blur-md border border-white/[0.12] flex items-center justify-center active:scale-90 transition-all"
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
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            <span className="text-[11px] text-emerald-300/80 font-bold tracking-wider">LIVE</span>
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
