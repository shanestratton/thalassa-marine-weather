/**
 * BuilderDeepLink — the /plan front door (tracer masterplan Phase 5.1).
 *
 * Mounted once in App.tsx; renders nothing unless the session STARTED
 * on a builder URL (thalassawx.app/plan or /builder — the "Skipper"
 * link on every yacht's public voyage-log page). uiStore has already
 * booted the app straight onto the map view; this component owns the
 * auth step: wait for the boot session probe, prompt sign-in when
 * there's no session (cloud ENC charts and saved-route sync are
 * account-gated on the web — a signed-out builder honestly shows "no
 * charts here"), then fire the pending tracer-open request MapHub
 * consumes. Declining the sign-in still opens the tracer; the gate is
 * a door, not a wall.
 */

import React, { useEffect, useState } from 'react';
import { isBuilderDeepLink, requestTracerOpen } from '../services/deepLink';
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
        if (!active || done || !authChecked) return;
        if (user) {
            // Session in hand (boot probe or a just-completed sign-in) —
            // open the builder. MapHub's mount effect or the window
            // event picks this up whichever mounts first.
            setDone(true);
            setShowSignIn(false);
            requestTracerOpen();
        } else {
            setShowSignIn(true);
        }
    }, [active, done, authChecked, user]);

    if (!active || done || !showSignIn) return null;

    return (
        <SignInScreen
            isOpen
            prompt="Sign in to open your passage builder — your charts and saved routes live on your account."
            onClose={() => {
                // Auth success closes via the user-effect above. Landing
                // here signed out means the user dismissed the sheet —
                // open the tracer anyway; it reports "no ENC charts"
                // honestly rather than dead-ending the visit.
                setShowSignIn(false);
                if (!useAuthStore.getState().user) {
                    setDone(true);
                    requestTracerOpen();
                }
            }}
        />
    );
};
