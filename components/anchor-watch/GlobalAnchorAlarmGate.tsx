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
 *
 * Build 125 (125-03): a drag alarm on THIS phone's own watch offers "Move
 * anchor", which opens MoveAnchorSheet in alarm mode over the alarm: the late
 * set, where the mark is in the wrong place, not the anchor. Never for a
 * GPS-lost alarm, and never while the boat's Pi keeps the watch (its watch is
 * moved by its own path; the keeper is only read here, never told anything).
 *
 * Build 126 (126-07b): the sheet is no longer in the app's first load (the
 * gate mounts with every page, anchored or not, and the sheet has grown with
 * 126-07a and 07b). It is loaded while a watch is kept on this phone: from the
 * moment it is set, long before any alarm, and kept once in. The anchor page
 * that sets a watch loads it too, so it is normally in already. Never with
 * React.lazy (a rejection would throw to the root) or lazyRetry (it reloads
 * the page), and never awaited by the alarm: a load that fails is caught (and
 * tried again when an alarm sounds), the overlay and Silence never wait for
 * it, and until the sheet is in, the alarm screen just does not offer Move
 * anchor. tests/GlobalAnchorAlarmGateSheetLoad.test.tsx.
 */
import React, { useEffect, useState } from 'react';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import { AnchorPiWatchKeeper } from '../../services/anchorPiWatchKeeper';
import { triggerHaptic } from '../../utils/system';
import { toast } from '../Toast';
import { AnchorAlarmOverlay } from './AnchorAlarmOverlay';
import type { MoveAnchorSheet as SheetComponent } from './MoveAnchorSheet';

type Sheet = typeof SheetComponent;
let sheetLoad: Promise<Sheet> | null = null;
/** The Move anchor sheet, loaded once; a failed load is forgotten, to be tried again. */
function loadSheet(): Promise<Sheet> {
    sheetLoad ??= import('./MoveAnchorSheet').then(
        (module) => module.MoveAnchorSheet,
        (error: unknown) => {
            sheetLoad = null;
            throw error;
        },
    );
    return sheetLoad;
}

export const GlobalAnchorAlarmGate: React.FC = () => {
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot>(() => AnchorWatchService.getSnapshot());
    const [moving, setMoving] = useState(false);
    const [MoveAnchorSheet, setSheet] = useState<Sheet | null>(null);

    useEffect(() => AnchorWatchService.subscribe(setSnapshot), []);

    // While a watch is kept, and again when an alarm sounds if that failed.
    const keeping = snapshot.state !== 'idle';
    const sounding = snapshot.state === 'alarm';
    useEffect(() => {
        if (!keeping || MoveAnchorSheet) return;
        let live = true;
        loadSheet().then(
            (sheet) => {
                if (live) setSheet(() => sheet);
            },
            () => undefined,
        );
        return () => {
            live = false;
        };
    }, [keeping, sounding, MoveAnchorSheet]);

    const canMove =
        snapshot.state === 'alarm' &&
        snapshot.alarmCause === 'drag' &&
        !!snapshot.anchorPosition &&
        snapshot.swingRadius > 0 &&
        !!MoveAnchorSheet &&
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
            {moving && canMove && MoveAnchorSheet && (
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
