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
 * surface. The Move anchor sheet it opens is static for the same reason.
 *
 * Build 125 (125-03): a drag alarm on THIS phone's own watch offers "Move
 * anchor", which opens MoveAnchorSheet in alarm mode over the alarm: the late
 * set, where the mark is in the wrong place, not the anchor. Never for a
 * GPS-lost alarm, and never while the boat's Pi keeps the watch (its watch is
 * moved by its own path; the keeper is only read here, never told anything).
 */
import React, { useEffect, useState } from 'react';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import { AnchorPiWatchKeeper } from '../../services/anchorPiWatchKeeper';
import { triggerHaptic } from '../../utils/system';
import { toast } from '../Toast';
import { AnchorAlarmOverlay } from './AnchorAlarmOverlay';
import { MoveAnchorSheet } from './MoveAnchorSheet';

export const GlobalAnchorAlarmGate: React.FC = () => {
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot>(() => AnchorWatchService.getSnapshot());
    const [moving, setMoving] = useState(false);

    useEffect(() => AnchorWatchService.subscribe(setSnapshot), []);

    const canMove =
        snapshot.state === 'alarm' &&
        snapshot.alarmCause === 'drag' &&
        !!snapshot.anchorPosition &&
        snapshot.swingRadius > 0 &&
        !AnchorPiWatchKeeper.isKeeping();
    // The alarm stopping (or turning GPS-lost) closes the sheet, and the next
    // alarm does not reopen it by itself.
    useEffect(() => {
        if (!canMove) setMoving(false);
    }, [canMove]);

    if (snapshot.state !== 'alarm') return null;

    return (
        <>
            <AnchorAlarmOverlay
                snapshot={snapshot}
                onAcknowledge={() => AnchorWatchService.acknowledgeAlarm()}
                onMoveAnchor={canMove ? () => setMoving(true) : undefined}
            />
            {moving && canMove && (
                <MoveAnchorSheet
                    mode="alarm"
                    snapshot={snapshot}
                    onClose={() => setMoving(false)}
                    onMoved={() => {
                        setMoving(false);
                        void triggerHaptic('medium');
                        toast.success('Anchor moved and the alarm stopped. Still watching her for drift.');
                    }}
                />
            )}
        </>
    );
};
