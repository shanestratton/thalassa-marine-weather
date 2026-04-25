/**
 * PerfOverlay — opt-in performance HUD for the chart screen.
 *
 * Activated by appending `?perf=1` to the URL. Renders a small chip
 * in the top-left showing frame rate, active layer count, Mapbox tile
 * cache count, lightning strike rate, and JS heap usage when available.
 *
 * Designed for diagnosing perf hitches on lower-spec devices (iPhone
 * 8/SE etc) without shipping a heavy debug surface to production users.
 * Hidden entirely unless the URL param is set, so zero cost in normal
 * use.
 *
 * What it tracks:
 *   - FPS — exponential moving average of inter-frame ms over the last
 *           ~30 frames. Anything below ~50 in steady state is suspicious
 *           on modern hardware.
 *   - Active layers — count of currently-active sky + tactical layers.
 *           High counts predict the performance edge cases.
 *   - Tile sources — number of map sources currently mounted (tiles +
 *           geojson). 28+ is the rain layer; 40+ means something leaked.
 *   - Strike rate — strikes/min from the lightning feed (when active).
 *           High rate × many strikes = repaint pressure on the GPU.
 *   - JS heap — performance.memory.usedJSHeapSize when available
 *           (Chromium/WebKit on iOS exposes this in some builds).
 */
import React, { useEffect, useState, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { subscribeLightningStatus, type StatusSnapshot } from '../../services/weather/api/blitzortungLightning';

interface PerfOverlayProps {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    activeLayerCount: number;
}

interface Stats {
    fps: number;
    sources: number;
    layers: number;
    strikesPerMinute: number;
    heapMB: number | null;
}

function isPerfModeEnabled(): boolean {
    try {
        const params = new URLSearchParams(window.location.search);
        return params.get('perf') === '1';
    } catch {
        return false;
    }
}

export const PerfOverlay: React.FC<PerfOverlayProps> = ({ mapRef, activeLayerCount }) => {
    const [enabled] = useState<boolean>(() => isPerfModeEnabled());
    const [stats, setStats] = useState<Stats>({
        fps: 60,
        sources: 0,
        layers: 0,
        strikesPerMinute: 0,
        heapMB: null,
    });
    const lastFrameRef = useRef<number>(performance.now());
    const fpsAvgRef = useRef<number>(60);
    const rafRef = useRef<number | null>(null);

    // FPS measurement loop — only runs when overlay is enabled, so it's
    // free in production. Exponential moving average so a single hitch
    // doesn't make the readout jump.
    useEffect(() => {
        if (!enabled) return;
        const tick = (now: number) => {
            const dt = now - lastFrameRef.current;
            lastFrameRef.current = now;
            if (dt > 0 && dt < 1000) {
                const instantaneousFps = 1000 / dt;
                fpsAvgRef.current = fpsAvgRef.current * 0.92 + instantaneousFps * 0.08;
            }
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        };
    }, [enabled]);

    // Subscribe to lightning rate so the overlay reflects strike volume.
    useEffect(() => {
        if (!enabled) return;
        const unsub = subscribeLightningStatus((snap: StatusSnapshot) => {
            setStats((s) => ({ ...s, strikesPerMinute: snap.strikesPerMinute }));
        });
        return unsub;
    }, [enabled]);

    // Periodic refresh of the slower-moving stats (sources, layers, heap).
    // 1 Hz is plenty — these don't change frame-to-frame.
    useEffect(() => {
        if (!enabled) return;
        const tick = () => {
            const map = mapRef.current;
            let sources = 0;
            let layers = 0;
            try {
                if (map) {
                    const style = map.getStyle();
                    sources = style?.sources ? Object.keys(style.sources).length : 0;
                    layers = style?.layers ? style.layers.length : 0;
                }
            } catch {
                /* style not ready */
            }
            // performance.memory is non-standard but exposed on iOS WKWebView
            // in some builds. Type-cast to access without TS yelling.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mem = (performance as any).memory;
            const heapMB = mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : null;

            setStats((s) => ({
                ...s,
                fps: Math.round(fpsAvgRef.current),
                sources,
                layers,
                heapMB,
            }));
        };
        tick();
        const t = setInterval(tick, 1000);
        return () => clearInterval(t);
    }, [enabled, mapRef]);

    if (!enabled) return null;

    // Color FPS by health — green > 50, amber 30-50, red < 30.
    const fpsColor = stats.fps >= 50 ? '#22c55e' : stats.fps >= 30 ? '#fbbf24' : '#ef4444';

    return (
        <div
            className="fixed z-[9999] pointer-events-none"
            style={{
                top: 'max(4px, env(safe-area-inset-top))',
                left: 4,
                background: 'rgba(0, 0, 0, 0.78)',
                color: '#fff',
                fontFamily: 'monospace',
                fontSize: 9,
                padding: '4px 6px',
                borderRadius: 6,
                lineHeight: 1.45,
                letterSpacing: 0.2,
                border: '1px solid rgba(255,255,255,0.1)',
            }}
            aria-hidden
        >
            <div style={{ color: fpsColor, fontWeight: 700 }}>{stats.fps} fps</div>
            <div>layers: {activeLayerCount}</div>
            <div>
                src: {stats.sources} · l: {stats.layers}
            </div>
            {stats.strikesPerMinute > 0 && <div>⚡ {stats.strikesPerMinute}/min</div>}
            {stats.heapMB !== null && <div>heap: {stats.heapMB} MB</div>}
        </div>
    );
};
