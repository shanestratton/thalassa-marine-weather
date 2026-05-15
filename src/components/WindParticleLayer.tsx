import React, { useEffect, useRef } from 'react';
import type { MapRef } from 'react-map-gl/mapbox';
import { sampleWind, type WindGrid } from '../wind';

interface WindParticleLayerProps {
    grid: WindGrid;
    mapRef: React.RefObject<MapRef | null>;
}

const PARTICLE_COUNT = 600;
const MAX_AGE = 140;
const TARGET_PX_PER_FRAME = 2;
const REFERENCE_WIND_MS = 10;

interface Particle {
    lat: number;
    lng: number;
    age: number;
}

/**
 * Canvas overlay that drifts a swarm of particles along a wind field.
 *
 * Particles are stored in world coords (lat/lng) and re-projected to
 * screen pixels every frame, so they stay tied to the map as the user
 * pans/zooms. The "speed of life" (dt per frame) is scaled by the
 * current zoom + cos(lat) so the visual drift looks roughly the same
 * whether you're zoomed out on the Coral Sea or close in on a marina.
 */
export const WindParticleLayer: React.FC<WindParticleLayerProps> = ({ grid, mapRef }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const map = mapRef.current;
        if (!canvas || !map) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const parent = canvas.parentElement;
        if (!parent) return;

        const dpr = window.devicePixelRatio || 1;
        const resize = (): void => {
            const rect = parent.getBoundingClientRect();
            canvas.width = Math.floor(rect.width * dpr);
            canvas.height = Math.floor(rect.height * dpr);
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(parent);

        const respawn = (p: Particle): void => {
            const bounds = map.getBounds();
            if (!bounds) {
                p.lat = (grid.minLat + grid.maxLat) / 2;
                p.lng = (grid.minLon + grid.maxLon) / 2;
                p.age = 0;
                return;
            }
            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();
            // Spawn within the intersection of the visible map and the wind
            // grid, so the new particle actually has wind to follow.
            const sLat = Math.max(sw.lat, grid.minLat);
            const nLat = Math.min(ne.lat, grid.maxLat);
            const wLng = Math.max(sw.lng, grid.minLon);
            const eLng = Math.min(ne.lng, grid.maxLon);
            if (nLat <= sLat || eLng <= wLng) {
                p.lat = sw.lat + Math.random() * (ne.lat - sw.lat);
                p.lng = sw.lng + Math.random() * (ne.lng - sw.lng);
            } else {
                p.lat = sLat + Math.random() * (nLat - sLat);
                p.lng = wLng + Math.random() * (eLng - wLng);
            }
            p.age = Math.floor(Math.random() * MAX_AGE);
        };

        const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => {
            const p: Particle = { lat: 0, lng: 0, age: 0 };
            respawn(p);
            return p;
        });

        let running = true;
        let rafId = 0;

        const animate = (): void => {
            if (!running) return;

            const w = parent.clientWidth;
            const h = parent.clientHeight;

            // Fade existing trails toward transparent.
            ctx.save();
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();

            // Zoom-adaptive seconds-of-wind per frame.
            const zoom = map.getZoom();
            const centerLat = map.getCenter().lat;
            const metersPerPx = (40075000 / (256 * Math.pow(2, zoom))) * Math.cos((centerLat * Math.PI) / 180);
            const dtSec = (TARGET_PX_PER_FRAME * metersPerPx) / REFERENCE_WIND_MS;

            ctx.lineWidth = 1.1;
            ctx.lineCap = 'round';

            for (const p of particles) {
                const wind = sampleWind(grid, p.lat, p.lng);
                if (wind.speed < 0.1) {
                    respawn(p);
                    continue;
                }

                const metersPerDegLon = 111320 * Math.cos((p.lat * Math.PI) / 180) || 1;
                const newLat = p.lat + (wind.v * dtSec) / 111320;
                const newLng = p.lng + (wind.u * dtSec) / metersPerDegLon;

                const fromXy = map.project([p.lng, p.lat]);
                const toXy = map.project([newLng, newLat]);

                const onScreen =
                    Number.isFinite(fromXy.x) &&
                    Number.isFinite(toXy.x) &&
                    fromXy.x >= -20 &&
                    fromXy.x <= w + 20 &&
                    fromXy.y >= -20 &&
                    fromXy.y <= h + 20;

                if (onScreen) {
                    // Brighter for fresher wind. sky-200 → near-white as speed climbs.
                    const t = Math.min(1, wind.speed / 18);
                    const r = Math.round(190 + t * 60);
                    const g = Math.round(230 + t * 20);
                    ctx.strokeStyle = `rgba(${r}, ${g}, 255, 0.55)`;
                    ctx.beginPath();
                    ctx.moveTo(fromXy.x, fromXy.y);
                    ctx.lineTo(toXy.x, toXy.y);
                    ctx.stroke();
                }

                p.lat = newLat;
                p.lng = newLng;
                p.age++;

                if (
                    p.age > MAX_AGE ||
                    !Number.isFinite(toXy.x) ||
                    toXy.x < -60 ||
                    toXy.x > w + 60 ||
                    toXy.y < -60 ||
                    toXy.y > h + 60
                ) {
                    respawn(p);
                }
            }

            rafId = requestAnimationFrame(animate);
        };
        rafId = requestAnimationFrame(animate);

        return () => {
            running = false;
            cancelAnimationFrame(rafId);
            ro.disconnect();
        };
    }, [grid, mapRef]);

    return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-[5]" aria-hidden="true" />;
};
