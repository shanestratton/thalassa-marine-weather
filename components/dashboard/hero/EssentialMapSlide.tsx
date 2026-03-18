/**
 * EssentialMapSlide — Radar map card for the HeroSlide carousel
 *
 * Static Mapbox basemap with looping RainViewer radar + Rainbow.ai nowcast.
 * Zero GPU — pure CSS transitions.
 *
 * Extracted from HeroSlide.tsx to reduce file complexity.
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { UnitPreferences } from '../../../types';
import { convertSpeed, degreesToCardinal } from '../../../utils';

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
}

type EssentialFrame = {
    path: string;
    time: number;
    type: 'radar' | 'forecast';
    forecastSecs?: number;
    snapshot?: number;
};

export const EssentialMapSlide: React.FC<EssentialMapSlideProps> = ({
    _slideIdx,
    isGolden,
    isCardDay,
    coordinates,
    windSpeed,
    windDirection,
    _windGust,
    condition,
    units,
}) => {
    const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    const lon = coordinates?.lon ?? 151.2;
    const lat = coordinates?.lat ?? -33.87;
    const zoom = 5;
    const tileSize = 256;

    // Progressive loading: show radar immediately, fade basemap in when ready
    const [mapLoaded, setMapLoaded] = useState(false);

    const staticUrl = token
        ? `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${lon},${lat},${zoom},0/600x400?access_token=${token}&attribution=false&logo=false`
        : '';

    // Prefetch the static image on mount so the browser cache has it ready
    useEffect(() => {
        if (!staticUrl) return;
        const img = new Image();
        img.onload = () => setMapLoaded(true);
        img.src = staticUrl;
    }, [staticUrl]);
    const [radarFrames, setRadarFrames] = useState<EssentialFrame[]>([]);
    const [activeFrame, setActiveFrame] = useState(0);
    const [nowIdx, setNowIdx] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const scrubberRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

        (async () => {
            try {
                // 1. RainViewer radar + nowcast
                const rvResp = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
                    cache: 'no-store',
                });
                const data = await rvResp.json();
                if (cancelled) return;

                const nowSec = Date.now() / 1000;
                const maxAge = 3 * 60 * 60;
                const allPast = (data?.radar?.past ?? []).map((f: { path: string; time: number }) => ({
                    path: f.path,
                    time: f.time,
                }));
                const fresh = allPast.filter((f: { time: number }) => nowSec - f.time < maxAge);
                const past = fresh.length > 0 ? fresh : allPast;
                const nowcast = (data?.radar?.nowcast ?? []).map((f: { path: string; time: number }) => ({
                    path: f.path,
                    time: f.time,
                }));

                const all: EssentialFrame[] = [
                    ...past.map((f: { path: string; time: number }) => ({ ...f, type: 'radar' as const })),
                    ...nowcast.map((f: { path: string; time: number }) => ({ ...f, type: 'radar' as const })),
                ];
                const ni = Math.max(0, past.length - 1);

                // 2. Rainbow.ai forecast (up to 4hr)
                if (supabaseUrl) {
                    try {
                        const snapResp = await fetch(`${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot`);
                        if (snapResp.ok && !cancelled) {
                            const snapData = await snapResp.json();
                            const snapshot = snapData.snapshot;
                            if (snapshot) {
                                const FORECAST_MINS = [10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 210, 240];
                                for (const mins of FORECAST_MINS) {
                                    all.push({
                                        path: '', // Not a RainViewer path — tile URL built from snapshot
                                        time: nowSec + mins * 60,
                                        type: 'forecast',
                                        forecastSecs: mins * 60,
                                        snapshot,
                                    });
                                }
                            }
                        }
                    } catch (_) {
                        /* Rainbow.ai optional — use radar only */
                    }
                }

                if (!cancelled) {
                    setRadarFrames(all);
                    setNowIdx(ni);
                    setActiveFrame(ni);
                }
            } catch (_) {
                /* silent fail */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Auto-play loop: only runs when user presses play — saves battery
    useEffect(() => {
        if (!isPlaying || radarFrames.length < 2) return;
        const timer = setInterval(() => {
            if (document.hidden) return;
            setActiveFrame((prev) => {
                const next = (prev + 1) % radarFrames.length;
                // Pause when looping back to start
                if (next === 0) {
                    setIsPlaying(false);
                    return nowIdx; // snap back to 'now'
                }
                return next;
            });
        }, 800);
        return () => clearInterval(timer);
    }, [isPlaying, radarFrames.length, nowIdx]);

    // Compute tile grid for rain overlay
    const tileGrid = useMemo(() => {
        const n = Math.pow(2, zoom);
        const cx = ((lon + 180) / 360) * n;
        const latRad = (lat * Math.PI) / 180;
        const cy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
        const centerTileX = Math.floor(cx);
        const centerTileY = Math.floor(cy);
        const pxOffsetX = (cx - centerTileX) * tileSize;
        const pxOffsetY = (cy - centerTileY) * tileSize;
        const containerW = 600,
            containerH = 400;
        const tiles: { left: number; top: number; tx: number; ty: number; key: string }[] = [];
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const tx = centerTileX + dx;
                const ty = centerTileY + dy;
                if (ty < 0 || ty >= n) continue;
                tiles.push({
                    left: containerW / 2 - pxOffsetX + dx * tileSize,
                    top: containerH / 2 - pxOffsetY + dy * tileSize,
                    tx,
                    ty,
                    key: `${tx}-${ty}`,
                });
            }
        }
        return tiles;
    }, [lat, lon]);

    // Time label for current frame — human-readable
    const timeLabel = useMemo(() => {
        if (!radarFrames.length) return '';
        const now = Date.now() / 1000;
        const diffMin = Math.round((radarFrames[activeFrame]?.time - now) / 60);
        if (Math.abs(diffMin) < 3) return 'NOW';
        if (diffMin < 0) {
            const absMins = Math.abs(diffMin);
            if (absMins < 60) return `-${absMins}m`;
            return `-${(absMins / 60).toFixed(1).replace(/\.0$/, '')}h`;
        }
        if (diffMin < 60) return `+${diffMin}m`;
        return `+${(diffMin / 60).toFixed(1).replace(/\.0$/, '')}h`;
    }, [radarFrames, activeFrame]);

    // Wind display
    const displaySpeed = useMemo(() => {
        if (windSpeed == null) return null;
        const s = units?.speed ?? 'knots';
        return Math.round(convertSpeed(windSpeed, s) || 0);
    }, [windSpeed, units?.speed]);
    const speedUnit = units?.speed === 'mph' ? 'mph' : units?.speed === 'kmh' ? 'km/h' : 'kts';
    const windLabel = windDirection != null ? degreesToCardinal(windDirection) : '';

    const isLive = activeFrame === nowIdx;
    const progress = radarFrames.length > 1 ? activeFrame / (radarFrames.length - 1) : 0;

    // Scrubber drag handler
    const handleScrub = useCallback(
        (clientX: number) => {
            if (!scrubberRef.current || radarFrames.length < 2) return;
            const rect = scrubberRef.current.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const idx = Math.round(pct * (radarFrames.length - 1));
            setActiveFrame(idx);
            setIsPlaying(false); // pause on manual scrub
        },
        [radarFrames.length],
    );

    return (
        <div className="relative w-full h-full flex flex-col">
            <div
                className={`relative flex-1 min-h-0 w-full rounded-2xl overflow-hidden border bg-slate-900/60 ${isGolden ? 'border-amber-400/[0.15]' : isCardDay ? 'border-white/[0.08]' : 'border-sky-300/[0.08]'}`}
            >
                {/* Layer 1: Dark basemap — fades in progressively when loaded */}
                {staticUrl && (
                    <img
                        src={staticUrl}
                        alt="Location map"
                        className="absolute inset-0 w-full h-full"
                        style={{
                            opacity: mapLoaded ? 1 : 0,
                            transition: 'opacity 600ms ease-in',
                            objectFit: 'cover',
                        }}
                        loading="eager"
                        draggable={false}
                    />
                )}

                {/* Layer 2: Looping rain radar + forecast */}
                {radarFrames.length > 0 &&
                    tileGrid.length > 0 &&
                    (() => {
                        const supabaseUrl =
                            (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
                        return (
                            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                                {radarFrames.map((frame, idx) => {
                                    const isForecst = frame.type === 'forecast';
                                    const frameKey = isForecst ? `fc-${frame.forecastSecs}` : frame.path;
                                    return (
                                        <div
                                            key={frameKey}
                                            className="absolute inset-0"
                                            style={{
                                                opacity: idx === activeFrame ? 0.65 : 0,
                                                transition: 'opacity 400ms ease',
                                            }}
                                        >
                                            {/* Preload nearby frames for smooth scrubbing */}
                                            {(Math.abs(idx - activeFrame) <= 3 || idx === activeFrame) &&
                                                tileGrid.map((t) => {
                                                    const src = isForecst
                                                        ? `${supabaseUrl}/functions/v1/proxy-rainbow?action=tile&snapshot=${frame.snapshot}&forecast=${frame.forecastSecs}&z=${zoom}&x=${t.tx}&y=${t.ty}&color=6`
                                                        : `https://tilecache.rainviewer.com${frame.path}/${tileSize}/${zoom}/${t.tx}/${t.ty}/7/1_1.png`;
                                                    return (
                                                        <img
                                                            key={`${frameKey}-${t.key}`}
                                                            src={src}
                                                            alt=""
                                                            className="absolute"
                                                            style={{
                                                                left: t.left,
                                                                top: t.top,
                                                                width: tileSize,
                                                                height: tileSize,
                                                            }}
                                                            loading="lazy"
                                                            draggable={false}
                                                            onError={(e) => {
                                                                (e.target as HTMLImageElement).style.display = 'none';
                                                            }}
                                                        />
                                                    );
                                                })}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })()}

                {/* Layer 3: Vignette */}
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{ background: 'radial-gradient(ellipse at 50% 50%, transparent 30%, rgba(0,0,0,0.6) 100%)' }}
                />

                {/* Layer 4: Location dot */}
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

                {/* Layer 5: Radar scrubber bar + play control */}
                {radarFrames.length > 1 && (
                    <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-2" style={{ pointerEvents: 'auto' }}>
                        <div className="flex items-center gap-2">
                            {/* Play/Pause button */}
                            <button
                                onClick={() => {
                                    if (!isPlaying) {
                                        // Start from beginning if at end or at 'now'
                                        if (activeFrame >= radarFrames.length - 1) setActiveFrame(0);
                                        setIsPlaying(true);
                                    } else {
                                        setIsPlaying(false);
                                    }
                                }}
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

                            {/* Scrubber track */}
                            <div
                                ref={scrubberRef}
                                className="flex-1 relative h-7 flex items-center cursor-pointer"
                                onClick={(e) => handleScrub(e.clientX)}
                                onTouchMove={(e) => {
                                    e.preventDefault();
                                    handleScrub(e.touches[0].clientX);
                                }}
                                onTouchStart={(e) => handleScrub(e.touches[0].clientX)}
                            >
                                {/* Track background */}
                                <div className="w-full h-[3px] rounded-full bg-white/[0.08] relative overflow-visible">
                                    {/* Progress fill */}
                                    <div
                                        className="absolute inset-y-0 left-0 rounded-full"
                                        style={{
                                            width: `${progress * 100}%`,
                                            background:
                                                'linear-gradient(90deg, rgba(56,189,248,0.15) 0%, rgba(56,189,248,0.5) 100%)',
                                            transition: isPlaying ? 'width 400ms ease' : 'width 100ms ease',
                                        }}
                                    />
                                    {/* 'Now' marker tick */}
                                    {nowIdx > 0 && (
                                        <div
                                            className="absolute top-1/2 -translate-y-1/2 w-px h-2.5 bg-white/25"
                                            style={{ left: `${(nowIdx / (radarFrames.length - 1)) * 100}%` }}
                                        />
                                    )}
                                    {/* Thumb */}
                                    <div
                                        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-sky-400 border-2 border-white/30"
                                        style={{
                                            left: `${progress * 100}%`,
                                            transform: 'translateX(-50%) translateY(-50%)',
                                            boxShadow: '0 0 8px rgba(56,189,248,0.5)',
                                            transition: isPlaying ? 'left 400ms ease' : 'left 100ms ease',
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Time label */}
                            <div className="shrink-0 min-w-[36px] text-right">
                                <span className="text-[11px] text-white/40 font-mono font-semibold tabular-nums">
                                    {timeLabel}
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Layer 6: Time label + LIVE/FORECAST badge — top-left */}
                <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
                    {isLive && (
                        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/20">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            <span className="text-[8px] text-emerald-300/80 font-bold tracking-wider">LIVE</span>
                        </div>
                    )}
                    {radarFrames[activeFrame]?.type === 'forecast' && (
                        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/20">
                            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                            <span className="text-[8px] text-amber-300/80 font-bold tracking-wider">FORECAST</span>
                            <span className="text-[8px] text-amber-300/50 font-mono font-semibold">{timeLabel}</span>
                        </div>
                    )}
                    {timeLabel && !isLive && radarFrames[activeFrame]?.type !== 'forecast' && (
                        <div className="px-1.5 py-0.5 rounded-md bg-black/40 backdrop-blur-sm border border-white/[0.06]">
                            <span className="text-[11px] text-white/50 font-mono font-semibold tabular-nums">
                                {timeLabel}
                            </span>
                        </div>
                    )}
                </div>

                {/* Layer 7: Wind badge — bottom-left */}
                {displaySpeed != null && (
                    <div className="absolute bottom-10 left-2.5 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/50 backdrop-blur-sm border border-white/[0.06]">
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
                            <span className="text-white/35 ml-0.5">{speedUnit}</span>
                        </span>
                    </div>
                )}

                {/* Layer 8: Condition — top-right */}
                {condition && (
                    <div className="absolute top-2.5 right-2.5 px-2 py-1 rounded-lg bg-black/50 backdrop-blur-sm border border-white/[0.06]">
                        <span className="text-[11px] text-white/50 font-medium tracking-wide">{condition}</span>
                    </div>
                )}
            </div>
        </div>
    );
};
