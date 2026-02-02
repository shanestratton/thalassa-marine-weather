
import { useEffect, useRef, MutableRefObject } from 'react';
import { ParticleEngine } from '../components/ParticleEngine';
import { WeatherMetrics } from '../types';

export const useWeatherOverlay = (
    canvasRef: MutableRefObject<HTMLCanvasElement | null>,
    mapInstance: MutableRefObject<any>,
    activeLayer: 'wind' | 'waves' | 'rain' | 'global-wind',
    metrics: WeatherMetrics,
    showWeather: boolean
) => {
    const engineRef = useRef<ParticleEngine | null>(null);

    // Weather Sampling Functions
    const sampleWeatherData = (targetLat: number, targetLon: number, type: string): number | null => {
        const noise = Math.sin(targetLat * 3) * Math.cos(targetLon * 3);
        if (type === 'wind') return Math.max(0.1, (metrics.windSpeed || 0) + (noise * 4));
        if (type === 'waves') {
            if (metrics.isEstimated || (metrics.waveHeight || 0) < 0.2) return 0;
            return Math.max(0.1, (metrics.waveHeight || 0) + (noise * 0.5));
        }
        if (type === 'rain') {
            if (!metrics.precipitation && !metrics.condition.toLowerCase().includes('rain')) return 0;
            const baseRain = metrics.precipitation || 2.0;
            const rainCluster = Math.sin(targetLat * 10 + targetLon * 10) + Math.cos(targetLat * 5);
            return rainCluster > 0 ? baseRain + (noise) : 0;
        }
        return 0;
    };

    const sampleDirection = (lat: number, lon: number) => {
        const baseDir = (metrics.windDegree ?? 0);
        const variation = Math.sin(lat * 2 + lon * 2) * 20;
        return (baseDir + variation + 360) % 360;
    };

    // Engine Lifecycle
    useEffect(() => {
        const map = mapInstance.current;
        const canvas = canvasRef.current;

        if (!map || !canvas || !showWeather) {
            engineRef.current?.stop();
            engineRef.current = null;
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx?.clearRect(0, 0, canvas.width, canvas.height);
            }
            return;
        }

        const handleResize = () => {
            if (canvas && canvas.parentElement) {
                const rect = canvas.parentElement.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;

                // Optimization: Force integer sizing to prevent blur and rounding drift
                const targetWidth = Math.round(rect.width * dpr);
                const targetHeight = Math.round(rect.height * dpr);

                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                    canvas.width = targetWidth;
                    canvas.height = targetHeight;
                    canvas.style.width = `${rect.width}px`;
                    canvas.style.height = `${rect.height}px`;
                    engineRef.current?.sync();
                }
            }
        };

        if (!engineRef.current) {
            // Initial Sizing
            handleResize();

            engineRef.current = new ParticleEngine(
                canvas,
                map,
                sampleWeatherData,
                sampleDirection
            );
            engineRef.current.start();
        }

        // Map Events for Engine Sync
        const handleMoveStart = () => engineRef.current?.setFastMode(false);
        const handleZoomStart = () => engineRef.current?.setFastMode(true);
        const handleZoomEnd = () => {
            engineRef.current?.setFastMode(false);
            engineRef.current?.sync();
        };

        let moveFrame: number;
        const handleMove = () => {
            if (moveFrame) cancelAnimationFrame(moveFrame);
            moveFrame = requestAnimationFrame(() => engineRef.current?.sync());
        };

        // Optimization: Use ResizeObserver instead of window.resize
        // This handles container resizes (e.g. mobile address bar) much better
        const resizeObserver = new ResizeObserver(() => {
            // Request animation frame to debounce resize events
            requestAnimationFrame(handleResize);
        });

        if (canvas.parentElement) {
            resizeObserver.observe(canvas.parentElement);
        }

        map.on('zoomstart', handleZoomStart);
        map.on('zoomend', handleZoomEnd);
        map.on('move', handleMove);
        map.on('movestart', handleMoveStart);

        return () => {
            if (moveFrame) cancelAnimationFrame(moveFrame);
            resizeObserver.disconnect();
            map.off('zoomstart', handleZoomStart);
            map.off('zoomend', handleZoomEnd);
            map.off('move', handleMove);
            map.off('movestart', handleMoveStart);
            engineRef.current?.stop();
            engineRef.current = null;
        };
    }, [mapInstance.current, showWeather, metrics]);

    // Layer Switching
    useEffect(() => {
        if (engineRef.current) engineRef.current.setLayer(activeLayer);
    }, [activeLayer]);

    return engineRef;
};
