/**
 * BuilderDeepLink — the /plan front door (tracer masterplan Phase 5.1).
 *
 * Mounted once in App.tsx; renders nothing unless the session STARTED
 * on a builder URL (thalassawx.app/plan or /builder — the "Skipper"
 * link on every yacht's public voyage-log page). uiStore has already
 * booted the app onto the PLANNER front door (Trip·Legs, departure,
 * saved routes — the same pre-flight as the phone; 2026-09-02, so a
 * new leg can actually be started on the web). This component owns
 * only the auth step: wait for the boot session probe and require
 * sign-in when there's no session. The tracer opens the normal way —
 * the front door's slide.
 *
 * The gate is a WALL, not a door (Shane, 2026-07-28: "if a punter is
 * not signed in, then he should not be able to get to that page at
 * all"). It used to be dismissible, and a dismissed session opened the
 * tracer anyway on the theory that "no ENC charts" was honest enough.
 * It wasn't: charted depth on web comes only from the authenticated
 * enc-cells bucket, so a signed-out builder silently lost TIDE AND
 * DEPTH GATING — it would plot a route across a bar it had no data to
 * refuse. Failing closed is the only safe direction for a depth
 * question. Omitting `onClose` is what removes SignInScreen's close
 * button; a confirmed session lowers it on the next render.
 */

import React, { useId, useState } from 'react';
import { isBuilderDeepLink } from '../services/deepLink';
import { useAuthStore } from '../stores/authStore';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { SignInScreen } from './SignInScreen';
import { OverlayPortal } from './ui/OverlayPortal';

/** Keep the standalone front door covered while its actual session is unknown. */
function CheckingBuilderSession() {
    const messageId = useId();
    const dialogRef = useFocusTrap<HTMLDivElement>(true);
    return (
        <OverlayPortal
            ref={dialogRef}
            scope="app"
            role="dialog"
            aria-modal="true"
            aria-labelledby={messageId}
            aria-busy="true"
            className="flex items-center justify-center bg-slate-950 px-6 text-center text-gray-100"
        >
            <p id={messageId} role="status" aria-live="polite" className="text-sm font-semibold">
                Checking your session…
            </p>
        </OverlayPortal>
    );
}

export const BuilderDeepLink: React.FC = () => {
    // location.pathname is fixed for the life of the SPA — read once.
    const [active] = useState(isBuilderDeepLink);
    const user = useAuthStore((s) => s.user);
    const authChecked = useAuthStore((s) => s.authChecked);

    if (!active) return null;
    // Derive the wall in this render, not an effect after first paint. A
    // provisional user never bypasses the initial session check, and sign-out
    // immediately covers the planner again instead of leaving a latched gap.
    if (!authChecked) return <CheckingBuilderSession />;
    if (user) return null;

    // No `onClose`: that prop is what renders SignInScreen's close button,
    // so leaving it off is the wall. A confirmed session is the only way past.
    return (
        <SignInScreen
            isOpen
            prompt="Sign in to open your passage builder — your tides and saved routes live on your account."
        />
    );
};
