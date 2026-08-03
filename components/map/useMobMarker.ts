/**
 * useMobMarker — plots the active Man-Overboard fix on the chart.
 *
 * The 2026-08-03 app audit's top marine-safety finding: an active MOB
 * gave the helm numbers only (MobPage), with no spatial context on the
 * chart. This marker closes that — a red pulsing datum at the MOB fix
 * with a live chip (elapsed · distance · bearing) fed by MobService's
 * own 1 Hz state emissions.
 *
 * Subscribes to MobService rather than any local activation path so a
 * MOB armed from ANYWHERE — the MOB page, or the Apple Watch button
 * (watchBridgeListeners routes straight to MobService.activate()) —
 * plots the moment it's active, even if the user is already on the
 * chart. Chip updates mutate textContent (no React re-render at 1 Hz);
 * React state only flips on active↔inactive transitions.
 *
 * Deliberately NOT gated on planningSurface: an active MOB must never
 * vanish because the user happens to have the planner open.
 */
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { MobService, type MobState } from '../../services/MobService';

function fmtElapsed(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    if (m >= 60) {
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDistance(meters: number | null): string {
    if (meters == null) return '—';
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1852).toFixed(2)} NM`;
}

function buildMobElement(): { el: HTMLDivElement; chip: HTMLDivElement } {
    const el = document.createElement('div');
    el.className = 'mob-marker';
    el.style.cssText = `
        position: relative;
        width: 44px; height: 44px;
        pointer-events: none;
    `;

    // Urgent red pulse halo — reuses the vesselPulse keyframes.
    const halo = document.createElement('div');
    halo.style.cssText = `
        position: absolute;
        left: 50%; top: 50%;
        width: 40px; height: 40px;
        margin-left: -20px; margin-top: -20px;
        border-radius: 50%;
        background: rgba(239, 68, 68, 0.4);
        animation: vesselPulse 1.2s ease-in-out infinite;
    `;
    el.appendChild(halo);

    // MOB datum: red ring + white lifebuoy cross, readable at chart scale.
    const glyph = document.createElement('div');
    glyph.style.cssText = `
        position: absolute;
        left: 50%; top: 50%;
        width: 28px; height: 28px;
        margin-left: -14px; margin-top: -14px;
    `;
    glyph.innerHTML = `
        <svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="14" r="12" fill="#ef4444" stroke="white" stroke-width="2.5"/>
            <circle cx="14" cy="14" r="5" fill="white"/>
            <path d="M14 2 V9 M14 19 V26 M2 14 H9 M19 14 H26" stroke="white" stroke-width="2.5"/>
        </svg>
    `;
    el.appendChild(glyph);

    const chip = document.createElement('div');
    chip.className = 'mob-marker-chip';
    chip.style.cssText = `
        position: absolute;
        bottom: 46px;
        left: 50%; transform: translateX(-50%);
        background: rgba(127, 29, 29, 0.92);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(239, 68, 68, 0.7);
        border-radius: 12px;
        padding: 4px 8px;
        color: rgba(255,255,255,0.95);
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    `;
    chip.textContent = 'MOB';
    el.appendChild(chip);
    return { el, chip };
}

export function useMobMarker(mapRef: React.MutableRefObject<mapboxgl.Map | null>, mapReady: boolean) {
    const markerRef = useRef<mapboxgl.Marker | null>(null);
    const chipRef = useRef<HTMLDivElement | null>(null);
    // Re-run the mount effect only when MOB flips on/off, not at 1 Hz.
    const [mobActive, setMobActive] = useState<boolean>(() => MobService.isActive());

    useEffect(() => {
        const unsub = MobService.subscribe((s: MobState) => {
            setMobActive(s.active !== null);
            if (chipRef.current && s.active) {
                const brg = s.bearingDeg != null ? ` · ${Math.round(s.bearingDeg)}°` : '';
                chipRef.current.textContent = `MOB ${fmtElapsed(s.elapsedSec)} · ${fmtDistance(s.distanceMeters)}${brg}`;
            }
        });
        return unsub;
    }, []);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const cleanup = () => {
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
            }
            chipRef.current = null;
        };

        const snap = MobService.currentState().active;
        if (!mobActive || !snap) {
            cleanup();
            return;
        }

        cleanup();
        const { el, chip } = buildMobElement();
        chipRef.current = chip;
        markerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([snap.fixLon, snap.fixLat])
            .addTo(map);

        return cleanup;
    }, [mapRef, mapReady, mobActive]);
}
