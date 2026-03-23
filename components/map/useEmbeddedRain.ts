import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('useEmbeddedRain');

export function useEmbeddedRain(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    embedded: boolean,
    mapReady: boolean,
    backgroundRain: boolean = false,
) {
    const enabled = embedded || backgroundRain;
    const embeddedRainFrames = useRef<{ path: string; time: number }[]>([]);
    const embRainNowIdx = useRef(0);
    const [embRainIdx, setEmbRainIdx] = useState(-1);
    const [embRainCount, setEmbRainCount] = useState(0);
    const [embRainPlaying, setEmbRainPlaying] = useState(false);

    // Load rain frames
    useEffect(() => {
        if (!enabled || !mapReady || !mapRef.current) return;
        const mapForCleanup = mapRef.current;
        (async () => {
            try {
                const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
                const data = await res.json();
                const past = (data?.radar?.past ?? []).map((f: { path: string; time: number }) => ({
                    path: f.path,
                    time: f.time,
                }));
                const forecast = (data?.radar?.nowcast ?? []).map((f: { path: string; time: number }) => ({
                    path: f.path,
                    time: f.time,
                }));
                const allFrames = [...past, ...forecast];
                embeddedRainFrames.current = allFrames;
                setEmbRainCount(allFrames.length);
                const nowIdx = Math.max(0, past.length - 1);
                embRainNowIdx.current = nowIdx;
                setEmbRainIdx(nowIdx);
            } catch (err) {
                log.warn('[useWeatherLayers]', err);
            }
        })();
        return () => {
            try {
                const mx = mapForCleanup;
                if (mx?.getLayer('embedded-rain')) mx.removeLayer('embedded-rain');
                if (mx?.getSource('embedded-rain')) mx.removeSource('embedded-rain');
            } catch (_) {
                log.warn('[useWeatherLayers]', _);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, mapReady]);

    // Swap rain tile on frame change
    useEffect(() => {
        if (!enabled || !mapRef.current) return;
        const m = mapRef.current;
        const frames = embeddedRainFrames.current;
        if (!frames.length || embRainIdx < 0 || embRainIdx >= frames.length) return;
        const frame = frames[embRainIdx];
        if (m.getSource('embedded-rain')) {
            try {
                m.removeLayer('embedded-rain');
                m.removeSource('embedded-rain');
            } catch (e) {
                log.warn('rain layer cleanup:', e);
            }
        }
        m.addSource('embedded-rain', {
            type: 'raster',
            tiles: [`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/6/1_1.png`],
            tileSize: 256,
            minzoom: 2,
            maxzoom: 6,
        });
        m.addLayer({
            id: 'embedded-rain',
            type: 'raster',
            source: 'embedded-rain',
            paint: { 'raster-opacity': embedded ? 0.75 : 0.55, 'raster-contrast': 0.3, 'raster-brightness-min': 0.1 },
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, embRainIdx]);

    // Auto-play
    useEffect(() => {
        if (!embRainPlaying) return;
        const timer = setInterval(() => {
            if (document.hidden) return;
            setEmbRainIdx((prev) => {
                if (prev + 1 >= embRainCount) return 0; // loop back
                return prev + 1;
            });
        }, 600);
        return () => clearInterval(timer);
    }, [embRainPlaying, embRainCount]);

    return {
        embeddedRainFrames,
        embRainIdx,
        setEmbRainIdx,
        embRainCount,
        embRainPlaying,
        setEmbRainPlaying,
        embRainNowIdx,
    };
}
