import React from 'react';
import mapboxgl from 'mapbox-gl';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { boatPresence } from '../../../services/presence/boatPresence';
import type { PresencePoint } from '../../../services/presence/BoatPresenceController';
import { ModalSheet } from '../../ui/ModalSheet';
import BoatPresenceSheet from './BoatPresenceSheet';
export interface BoatPresenceStatus {
    active: boolean;
    publishing: boolean;
    text: string;
}
interface Props {
    map: mapboxgl.Map | null;
    mapReady: boolean;
    viewing: boolean;
    onViewingChange: (v: boolean) => void;
    controlsOpen: boolean;
    onCloseControls: () => void;
    onStatus: (v: BoatPresenceStatus | null) => void;
}
export default function BoatPresenceSurface({
    map,
    mapReady,
    viewing,
    onViewingChange,
    controlsOpen,
    onCloseControls,
    onStatus,
}: Props) {
    const s = React.useSyncExternalStore(boatPresence.subscribe, boatPresence.snapshot);
    const [selected, setSelected] = React.useState<PresencePoint | null>(null),
        wasViewing = React.useRef(false);
    React.useEffect(() => {
        boatPresence.setForeground(document.visibilityState === 'visible');
        let disposed = false,
            nativeActive = true,
            removeNative: (() => void) | undefined;
        if (Capacitor.isNativePlatform())
            void App.addListener('appStateChange', ({ isActive }) => {
                nativeActive = isActive;
                if (!disposed) boatPresence.setForeground(isActive && document.visibilityState === 'visible');
            })
                .then((handle) => {
                    if (disposed) void handle.remove();
                    else removeNative = () => void handle.remove();
                })
                .catch(() => {
                    if (!disposed) boatPresence.setForeground(false);
                });
        const visibility = () => {
            if (document.visibilityState === 'visible') boatPresence.setForeground(nativeActive);
        };
        document.addEventListener('visibilitychange', visibility);
        const expire = setInterval(boatPresence.expire, 1000),
            tick = setInterval(() => {
                void boatPresence.tick().catch(() => {});
            }, 20000);
        return () => {
            disposed = true;
            removeNative?.();
            document.removeEventListener('visibilitychange', visibility);
            clearInterval(expire);
            clearInterval(tick);
            boatPresence.setForeground(false);
            onCloseControls();
            onStatus(null);
        };
    }, [onStatus, onCloseControls]);
    React.useEffect(() => {
        void boatPresence.setSession('reader', viewing).catch(() => onViewingChange(false));
    }, [viewing, onViewingChange]);
    React.useEffect(() => {
        if (s.viewing) wasViewing.current = true;
        else if (wasViewing.current) {
            wasViewing.current = false;
            onViewingChange(false);
        }
    }, [s.viewing, onViewingChange]);
    React.useEffect(() => {
        onStatus(s.viewing || s.publishing ? { active: true, publishing: s.publishing, text: s.status } : null);
    }, [s.viewing, s.publishing, s.status, onStatus]);
    React.useEffect(() => {
        if (selected && !s.points.some((p) => p.id === selected.id)) setSelected(null);
    }, [s.points, selected]);
    React.useEffect(() => {
        if (!map || !mapReady || !viewing || !s.viewing) return;
        const markers = s.points.map((point) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.style.cssText =
                'width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;padding:0;';
            button.setAttribute('aria-label', `${point.label}; delayed Thalassa position`);
            button.dataset.boatPresence = 'true';
            // A circle within a diamond: deliberately distinct from AIS triangles.
            const ns = 'http://www.w3.org/2000/svg',
                svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('viewBox', '0 0 32 32');
            svg.setAttribute('width', '30');
            svg.setAttribute('height', '30');
            svg.setAttribute('aria-hidden', 'true');
            const diamond = document.createElementNS(ns, 'path');
            diamond.setAttribute('d', 'M16 2 30 16 16 30 2 16Z');
            diamond.setAttribute('fill', '#164e63');
            diamond.setAttribute('stroke', '#67e8f9');
            diamond.setAttribute('stroke-width', '2');
            const circle = document.createElementNS(ns, 'circle');
            circle.setAttribute('cx', '16');
            circle.setAttribute('cy', '16');
            circle.setAttribute('r', '5');
            circle.setAttribute('fill', '#cffafe');
            svg.append(diamond, circle);
            button.append(svg);
            button.onclick = (e) => {
                e.stopPropagation();
                setSelected(point);
            };
            const marker = new mapboxgl.Marker({ element: button })
                .setLngLat([point.longitude, point.latitude])
                .addTo(map);
            // Mapbox assigns role=img to custom markers; retain the real
            // interactive button's semantics after that native setup.
            button.setAttribute('role', 'button');
            return marker;
        });
        return () => markers.forEach((marker) => marker.remove());
    }, [map, mapReady, viewing, s.viewing, s.points]);
    return (
        <>
            {controlsOpen && <BoatPresenceSheet onClose={onCloseControls} />}
            {selected && (
                <ModalSheet isOpen onClose={() => setSelected(null)} title={selected.label} maxWidth="max-w-sm">
                    <div className="space-y-3 text-sm text-white">
                        <p>
                            Thalassa app position · {selected.tier}. Self-reported phone GPS in a 0.05° cell, delayed at
                            least 5 minutes.
                        </p>
                        <p>
                            Five-minute snapshot bucket: {new Date(selected.bucketAt).toLocaleTimeString()}. The boat
                            may have moved.
                        </p>
                        <p>
                            No speed, heading or track. This symbol is never used for AIS collision alarms or routing.
                        </p>
                    </div>
                </ModalSheet>
            )}
        </>
    );
}
