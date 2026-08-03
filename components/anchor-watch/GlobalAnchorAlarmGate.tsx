/**
 * GlobalAnchorAlarmGate — app-level mount for the anchor drag/GPS-lost
 * alarm overlay.
 *
 * The overlay used to be page-local to AnchorWatchPage ('compass'), so
 * an alarm firing while the user was on the Glass, the chart, or the
 * Galley showed NOTHING in-app — the full-screen alarm only existed if
 * you happened to be standing on the anchor-watch page (2026-08-03
 * audit, marine-safety-UX). This gate subscribes to the service and
 * portals the overlay over ANY page the moment state hits 'alarm'.
 *
 * A dedicated component (rather than subscribing in App) so the 1 Hz-ish
 * watch-state emissions re-render only this null-returning gate, never
 * the App root. The overlay itself stays lazy — it joins the bundle only
 * when an alarm actually fires.
 */
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../services/AnchorWatchService';

const AnchorAlarmOverlay = lazy(() => import('./AnchorAlarmOverlay').then((m) => ({ default: m.AnchorAlarmOverlay })));

export const GlobalAnchorAlarmGate: React.FC = () => {
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot>(() => AnchorWatchService.getSnapshot());

    useEffect(() => AnchorWatchService.subscribe(setSnapshot), []);

    if (snapshot.state !== 'alarm') return null;

    return (
        <Suspense fallback={null}>
            <AnchorAlarmOverlay snapshot={snapshot} onAcknowledge={() => AnchorWatchService.acknowledgeAlarm()} />
        </Suspense>
    );
};
