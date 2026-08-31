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
 * button; auth success still dismisses it through the effect below.
 */

import React, { useEffect, useState } from 'react';
import { isBuilderDeepLink } from '../services/deepLink';
import { useAuthStore } from '../stores/authStore';
import { SignInScreen } from './SignInScreen';

export const BuilderDeepLink: React.FC = () => {
    // location.pathname is fixed for the life of the SPA — read once.
    const [active] = useState(isBuilderDeepLink);
    const [done, setDone] = useState(false);
    const [showSignIn, setShowSignIn] = useState(false);
    const user = useAuthStore((s) => s.user);
    const authChecked = useAuthStore((s) => s.authChecked);

    useEffect(() => {
        if (!active || !authChecked) return;
        if (user) {
            if (done) return;
            // Session in hand (boot probe or a just-completed sign-in) —
            // lower the wall. The planner front door is already on screen;
            // its slide fires the tracer-open request itself.
            setDone(true);
            setShowSignIn(false);
        } else {
            // No session. This now covers an explicit sign-out from
            // PlanSignOutButton AFTER the gate had already passed, so `done`
            // has to be cleared: latching it would hold the wall down for
            // the rest of the SPA's life and leave a signed-out planner with
            // no chart data — exactly the state the wall exists to prevent.
            setDone(false);
            setShowSignIn(true);
        }
    }, [active, done, authChecked, user]);

    if (!active || done || !showSignIn) return null;

    // No `onClose`: that prop is what renders SignInScreen's close button,
    // so leaving it off is the wall. The effect above tears this down the
    // moment a session exists, which is the only way past it.
    return (
        <SignInScreen
            isOpen
            prompt="Sign in to open your passage builder — your charts, tides and saved routes live on your account."
        />
    );
};
