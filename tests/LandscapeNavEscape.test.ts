import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mobile landscape hides the bottom nav to buy vertical room. That is a fine
 * default and a fatal absolute.
 *
 * Onboarding offers a "Landscape" display preference, and settingsStore acts on
 * it with ScreenOrientation.lock({ orientation: 'landscape' }). On a phone that
 * makes App's `isMobileLandscape` (landscape AND innerHeight < 500)
 * permanently true. The nav was gated on `!isMobileLandscape`, and Settings —
 * the only screen where the orientation preference can be changed back — is
 * reachable only from VesselHub and RoutePlanner, both of which you get to
 * THROUGH the nav. So the choice removed every route to undoing itself: the app
 * was unnavigable until reinstall.
 *
 * These are source assertions rather than a render test, because App.tsx is the
 * root of the whole tree and mounting it here would need most of the app's
 * services mocked. They are narrow on purpose: each one names a specific way
 * the escape can be lost again.
 */

const app = readFileSync(resolve(process.cwd(), 'App.tsx'), 'utf8');
const store = readFileSync(resolve(process.cwd(), 'stores/settingsStore.ts'), 'utf8');
const displayPrefs = readFileSync(resolve(process.cwd(), 'components/onboarding/DisplayPrefsStep.tsx'), 'utf8');
const routePlanner = readFileSync(resolve(process.cwd(), 'components/RoutePlanner.tsx'), 'utf8');
const globalStyles = readFileSync(resolve(process.cwd(), 'index.css'), 'utf8');

describe('mobile landscape can always reach navigation', () => {
    it('still offers the landscape preference that creates the hazard', () => {
        // If this ever goes away the trap is gone by removal rather than by
        // fix, and the guards below become dead weight — worth knowing.
        expect(displayPrefs).toContain("value: 'landscape' as const");
        expect(store).toContain("ScreenOrientation.lock({ orientation: 'landscape' })");
    });

    it('does not gate the nav on !isMobileLandscape alone', () => {
        // The exact original bug. A bare `!isMobileLandscape &&` on the nav is
        // what made the app unnavigable.
        expect(app).not.toMatch(/\{!isMobileLandscape && !isStandalonePlan && \(\s*<nav/);
    });

    it('renders the nav when landscape navigation has been summoned', () => {
        expect(app).toContain('(!isMobileLandscape || landscapeNavOpen) && !isStandalonePlan && (');
    });

    it('exposes a control to summon it, with an accessible name and expanded state', () => {
        // One toggle, rendered in two places: bottom-left on every landscape
        // page, docked in the header row on the Glass (it sat over the
        // instrument grid there). Its own <nav> keeps a landmark while the
        // bar is folded away.
        const start = app.indexOf('const renderLandscapeNavToggle = (docked: boolean) => (');
        expect(start, 'no landscape nav toggle button found').toBeGreaterThan(-1);
        const button = app.slice(start, start + 1400);
        expect(button).toMatch(/^[^]*?<nav aria-label=[^]*?<button/);
        expect(button).toContain('setLandscapeNavOpen');
        expect(button).toContain('aria-label');
        expect(button).toContain('aria-expanded');
        // Marine touch target: a wet hand on a moving boat.
        expect(button).toContain('min-h-[44px]');
        expect(button).toContain('min-w-[44px]');
        // Both placements are actually rendered.
        expect(app).toMatch(
            /\{isDashboard &&\s+isMobileLandscape &&\s+!isStandalonePlan &&\s+renderLandscapeNavToggle\(true\)\}/,
        );
        expect(app).toMatch(
            /\{isMobileLandscape &&\s+!isStandalonePlan &&\s+!isDashboard &&\s+renderLandscapeNavToggle\(false\)\}/,
        );
    });

    it('keeps the toggle above the nav so it can also dismiss it', () => {
        const navZ = /z-900(?!\d)/.test(app);
        const toggleZ = /z-901(?!\d)/.test(app);
        expect(navZ).toBe(true);
        expect(toggleZ).toBe(true);
    });

    it('moves the Route Planner CTA into document flow on a short landscape phone', () => {
        expect(routePlanner).toContain('route-planner-page');
        expect(routePlanner).toContain('route-planner-form');
        expect(routePlanner).toContain('route-planner-cta');
        // In flow after the form, and sticky to the bottom of the view's
        // scroller (pinned as in portrait, but a row of its own). The page
        // must not be a scroll container, or it would capture the sticky.
        const landscape = globalStyles.slice(
            globalStyles.indexOf('@media (orientation: landscape) and (max-height: 500px)'),
        );
        expect(landscape).toMatch(
            /\.route-planner-page\s*\{[^}]*overflow-x: clip !important;[^}]*overflow-y: visible !important/,
        );
        expect(landscape).toMatch(/\.route-planner-cta\s*\{[^}]*position: sticky !important;[^}]*bottom: 0 !important/);
    });
});
