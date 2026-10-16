import React from 'react';
import { createRoot } from 'react-dom/client';
import AnchorSafeZoneSheet from '../../components/anchor-watch/AnchorSafeZoneSheet';
import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import { anchorZonePosition } from '../../utils/anchorSafeZone';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Synthetic fixture is development-only.');
const query = new URLSearchParams(location.search);
document.documentElement.style.fontSize = '130%';
document.documentElement.style.fontFamily = 'Verdana, "DejaVu Sans", sans-serif';
document.body.style.cssText = 'margin:0;width:100vw;height:100dvh;overflow:hidden;background:#020617;color:white';
if (query.has('keyboard')) {
    document.documentElement.dataset.keyboardOpen = 'true';
    document.documentElement.style.setProperty('--thalassa-keyboard-height', '220px');
}
const anchor = { latitude: -27, longitude: 179.99999, timestamp: Date.now() };
const safeZone = {
    version: 1 as const,
    kind: 'polygon' as const,
    anchor: { latitude: anchor.latitude, longitude: anchor.longitude },
    vertices: [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
    ].map(([x, y]) => anchorZonePosition(anchor, x, y)!),
};
const snapshot: AnchorWatchSnapshot = {
    state: 'watching',
    anchorPosition: anchor,
    vesselPosition: { ...anchor, accuracy: 1, heading: 0, speed: 0 },
    safeZone,
    swingRadius: 60,
    distanceFromAnchor: 0,
    maxDistanceRecorded: 0,
    bearingToAnchor: 0,
    config: { rodeLength: 50, waterDepth: 10, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 },
    positionHistory: [],
    alarmTriggeredAt: null,
    alarmCause: null,
    watchStartedAt: anchor.timestamp,
    gpsAccuracy: 1,
    gpsQuality: 'precision',
    gpsQualityLabel: 'Synthetic fix',
    guardianStatus: 'idle',
    setupError: null,
};
createRoot(document.getElementById('root')!).render(
    <AnchorSafeZoneSheet
        snapshot={snapshot}
        readToken={async () => 'synthetic-watch-token'}
        onSave={async (value, token) => {
            document.body.dataset.saved = JSON.stringify({ value, token });
            return { ok: true };
        }}
        onClose={() => {
            document.body.dataset.closed = 'true';
        }}
    />,
);
