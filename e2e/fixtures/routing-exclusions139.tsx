import React from 'react';
import { createRoot } from 'react-dom/client';
import UserOverlaysSheet from '../../components/map/UserOverlaysSheet';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { saveUserOverlay } from '../../services/userOverlays/store';
import { normalizeOverlay } from '../../services/userOverlays/model';
import { readCurrentRoutingExclusions } from '../../services/routing/routingExclusions';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development-only synthetic fixture.');
setAuthIdentityScope('synthetic-manual-routing-owner');
document.documentElement.style.fontSize = '130%';
document.documentElement.style.setProperty('--font-sans', 'Verdana, "DejaVu Sans", sans-serif');
document.body.style.cssText = 'margin:0;width:100vw;height:100dvh;overflow:hidden;background:#020617;color:white';
if (new URLSearchParams(location.search).has('keyboard')) {
    document.documentElement.dataset.keyboardOpen = 'true';
    document.documentElement.style.setProperty('--thalassa-keyboard-height', '220px');
}
await saveUserOverlay(
    {
        ...normalizeOverlay({
            type: 'Polygon',
            coordinates: [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 1],
                    [0, 0],
                ],
            ],
        }),
        format: 'GeoJSON',
    },
    'Own polygon',
);
await saveUserOverlay(
    { ...normalizeOverlay({ type: 'Point', coordinates: [0.5, 0.5] }), format: 'GeoJSON' },
    'Own point',
);
Object.assign(window, {
    __readManualRouting: async () => {
        const context = await readCurrentRoutingExclusions({ bbox: [-0.1, -0.1, 1.1, 1.1] });
        try {
            return { count: context.manual?.features.length, current: context.isCurrent() };
        } finally {
            context.release();
        }
    },
});
createRoot(document.getElementById('root')!).render(
    <UserOverlaysSheet
        onClose={() => {
            document.body.dataset.closed = 'true';
        }}
    />,
);
