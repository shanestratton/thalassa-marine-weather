/**
 * PlanSignOutButton — the way back out of a session on the standalone
 * /plan surface.
 *
 * /plan hides the bottom tab bar (App.tsx), so Settings → Account — the
 * only other sign-out in the app — is unreachable from there. Once the
 * builder gate became a wall rather than a door (BuilderDeepLink), a
 * punter who signed in on a borrowed machine had no way out at all.
 *
 * Placement: top-left. MapHub's right-hand control rail occupies
 * `right-[16px]` from `top-[128px]` down, and the bottom band belongs to
 * the map's own controls, so the top-left corner is the one reliably
 * free spot on this surface.
 */

import React, { useState } from 'react';
import { isBuilderDeepLink } from '../services/deepLink';
import { useAuthStore } from '../stores/authStore';
import { triggerHaptic } from '../utils/system';

export const PlanSignOutButton: React.FC = () => {
    // location.pathname is fixed for the life of the SPA — read once.
    const [active] = useState(isBuilderDeepLink);
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);
    const [busy, setBusy] = useState(false);

    if (!active || !user) return null;

    const handleSignOut = async () => {
        if (busy) return;
        setBusy(true);
        triggerHaptic('medium');
        try {
            await logout();
            // BuilderDeepLink watches `user` and re-raises its gate, so a
            // sign-out here lands back on the sign-in wall rather than on a
            // signed-out planner with no chart data.
        } catch {
            // authStore.logout restores the previous session when the
            // server release or native unregister fails, so the safe
            // outcome is simply "still signed in" — no dead end to report.
        } finally {
            setBusy(false);
        }
    };

    return (
        <button
            type="button"
            onClick={handleSignOut}
            disabled={busy}
            data-testid="plan-sign-out"
            aria-label="Sign out of the passage builder"
            className="fixed left-3 top-[calc(env(safe-area-inset-top)+12px)] z-[800] rounded-full border border-white/15 bg-slate-900/80 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-slate-200 backdrop-blur transition-colors active:brightness-110 disabled:opacity-50"
        >
            {busy ? 'Signing out…' : 'Sign out'}
        </button>
    );
};
