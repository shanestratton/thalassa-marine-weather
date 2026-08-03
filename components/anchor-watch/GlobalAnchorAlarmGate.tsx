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
 * the App root.
 *
 * The overlay is imported STATICALLY on purpose: a lazy chunk fetched at
 * ALARM time can fail (offline PWA at a remote anchorage, stale deploy
 * hashes) and a rejected React.lazy would throw to the root
 * ErrorBoundary — unmounting the whole app, mid-alarm, taking the
 * silence control with it. The alarm path must never depend on a
 * network fetch; the component is small and this is a life-safety
 * surface.
 */
import React, { useEffect, useState } from 'react';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import { AnchorAlarmOverlay } from './AnchorAlarmOverlay';

export const GlobalAnchorAlarmGate: React.FC = () => {
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot>(() => AnchorWatchService.getSnapshot());

    useEffect(() => AnchorWatchService.subscribe(setSnapshot), []);

    if (snapshot.state !== 'alarm') return null;

    return <AnchorAlarmOverlay snapshot={snapshot} onAcknowledge={() => AnchorWatchService.acknowledgeAlarm()} />;
};
