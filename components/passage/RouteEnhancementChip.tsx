/**
 * RouteEnhancementChip — small floating pill rendered while the
 * passage-planner enhancement pipeline is running.
 *
 * Listens for the two window events `useVoyageForm` emits:
 *
 *   thalassa:passage-enhancement-start  (pipeline kicked off)
 *   thalassa:passage-enhancement-end    (everything settled)
 *
 * Self-mounts; nothing visible while idle. Renders absolutely-positioned
 * top-center so it overlays the chart without participating in layout
 * flow. Embed once at the MapHub root and it'll do the right thing
 * whichever direction the user navigates from.
 *
 * Why a separate component: keeps MapHub clean, makes the listener
 * lifecycle scoped and tied to mount/unmount, and lets us drop the
 * chip into other surfaces (RoutePlanner, voyage detail page) without
 * duplicating the wiring.
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import {
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    isPassageEnhancementTokenCurrent,
    PASSAGE_ENHANCEMENT_END_EVENT,
    PASSAGE_ENHANCEMENT_START_EVENT,
    readPassageEnhancementToken,
    type PassageEnhancementToken,
} from '../../services/passageEnhancementEvents';

const PHASES = [
    'Finding deep water',
    'Threading the channel',
    'Checking the weather window',
    'Marking the turns',
    'Tidying the track',
];

const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

export const RouteEnhancementChip: React.FC = () => {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getAuthIdentityScope, getAuthIdentityScope);
    const [activeOperation, setActiveOperation] = useState<{
        scope: AuthIdentityScope;
        token: PassageEnhancementToken;
    } | null>(null);
    const [phaseIdx, setPhaseIdx] = useState(0);
    const active =
        activeOperation !== null &&
        activeOperation.scope.key === identityScope.key &&
        activeOperation.scope.generation === identityScope.generation &&
        isPassageEnhancementTokenCurrent(activeOperation.token, identityScope);

    useEffect(() => {
        const onStart = (event: Event) => {
            const token = readPassageEnhancementToken(event);
            const eventScope = getAuthIdentityScope();
            if (!token || !isPassageEnhancementTokenCurrent(token, eventScope)) return;
            setActiveOperation({ scope: eventScope, token });
            setPhaseIdx(0);
        };
        const onEnd = (event: Event) => {
            const token = readPassageEnhancementToken(event);
            if (!token || !isPassageEnhancementTokenCurrent(token)) return;
            setActiveOperation((current) =>
                current?.token.operationId === token.operationId &&
                current.token.scopeKey === token.scopeKey &&
                current.token.generation === token.generation
                    ? null
                    : current,
            );
        };
        window.addEventListener(PASSAGE_ENHANCEMENT_START_EVENT, onStart);
        window.addEventListener(PASSAGE_ENHANCEMENT_END_EVENT, onEnd);
        return () => {
            window.removeEventListener(PASSAGE_ENHANCEMENT_START_EVENT, onStart);
            window.removeEventListener(PASSAGE_ENHANCEMENT_END_EVENT, onEnd);
        };
    }, []);

    // Hide previous-account progress synchronously through the derived
    // `active` value above, then release the retained token on commit.
    useEffect(() => {
        setActiveOperation((current) =>
            current &&
            (current.scope.key !== identityScope.key || current.scope.generation !== identityScope.generation)
                ? null
                : current,
        );
        setPhaseIdx(0);
    }, [identityScope]);

    // Rotate the phrase so the chip doesn't feel frozen during the
    // longer steps. 2s cadence — slow enough to read, fast enough to
    // signal progress.
    useEffect(() => {
        if (!active) return;
        const id = setInterval(() => {
            setPhaseIdx((i) => (i + 1) % PHASES.length);
        }, 2000);
        return () => clearInterval(id);
    }, [active]);

    // Self-dismiss watchdog: if the end event never fires (a pipeline
    // await stalled behind a dead socket — CapacitorHttp ignores
    // AbortSignal on device), hide the chip after 3 minutes instead of
    // spinning forever. The normal end event flips `active` and the
    // cleanup clears the timer; ditto on unmount.
    useEffect(() => {
        if (!active || !activeOperation) return;
        const ownedToken = activeOperation.token;
        const id = setTimeout(
            () =>
                setActiveOperation((current) =>
                    current?.token.operationId === ownedToken.operationId &&
                    current.token.scopeKey === ownedToken.scopeKey &&
                    current.token.generation === ownedToken.generation
                        ? null
                        : current,
                ),
            180_000,
        );
        return () => clearTimeout(id);
    }, [active, activeOperation]);

    if (!active) return null;

    return (
        <div
            className="pointer-events-none fixed inset-x-0 z-[2500] flex justify-center animate-in fade-in slide-in-from-top-2 duration-200"
            style={{ top: 'calc(env(safe-area-inset-top) + 8px)' }}
            role="status"
            aria-live="polite"
        >
            <div className="pointer-events-auto inline-flex items-center gap-3 px-4 py-2 rounded-full bg-slate-900/95 border border-violet-500/30 backdrop-blur-md shadow-[0_0_25px_rgba(168,85,247,0.20)]">
                <div className="flex gap-1">
                    <span className="block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" />
                </div>
                <span className="text-[11px] font-mono tracking-wide text-violet-200">{PHASES[phaseIdx]}…</span>
            </div>
        </div>
    );
};
