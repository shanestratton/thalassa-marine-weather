/**
 * What the clear view itself puts on Obs (129-13; mapHub/useObsClearView.ts):
 * nothing a sighted skipper sees but one line, once.
 *
 *  - For VoiceOver and keyboards, a hidden "Clear the screen" button while
 *    the controls show, and while they are hidden "Controls hidden. Double
 *    tap to show", which takes the focus. A web view cannot give the chart a
 *    native custom action; these stand in for one, and are never drawn.
 *  - The first time on this device: "Tap anywhere to bring the controls back",
 *    for a few seconds.
 */
import React, { useEffect, useRef } from 'react';
import type { ObsClearView } from './mapHub/useObsClearView';

export function ObsClearViewChrome({ view }: { view: ObsClearView }): React.ReactElement | null {
    const showRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (view.on) showRef.current?.focus({ preventScroll: true });
    }, [view.on]);
    if (!view.on && !view.available) return null;
    return (
        <>
            {view.on ? (
                <button ref={showRef} type="button" data-clear-view-keep="" className="sr-only" onClick={view.show}>
                    Controls hidden. Double tap to show
                </button>
            ) : (
                <button type="button" className="sr-only" onClick={view.hide}>
                    Clear the screen
                </button>
            )}
            {view.on && view.hint && (
                <div
                    data-clear-view-keep=""
                    data-testid="clear-view-hint"
                    aria-hidden="true"
                    // In the strip the hidden zoom readout and base pill leave, above
                    // the credits (creditsStrip: inset + 62px): in px, so two lines end
                    // by inset + 52px even in large text. w-max, or a box at left 50%
                    // gets half the screen.
                    className="obs-clear-view-hint pointer-events-none absolute left-1/2 z-805 w-max max-w-[calc(100%-32px)] -translate-x-1/2 rounded-[12px] border border-white/10 bg-slate-950/85 px-[12px] py-[6px] text-center text-[12px] leading-[16px] font-bold text-white shadow-2xl backdrop-blur-md"
                    style={{ top: 'calc(env(safe-area-inset-top) + 8px)' }}
                >
                    Tap anywhere to bring the controls back
                </div>
            )}
        </>
    );
}
