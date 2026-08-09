/**
 * Turning an invisible crash into a fact.
 *
 * Shane has reported the planning screen "crashing back to the Glass page"
 * since 2026-08-01, and every attempt to chase it hit the same wall: nothing
 * in the logs. Two real causes were found and fixed anyway — auth churn
 * (d812494a) and ENC memory pressure (0a607bd3) — and it still happens on zoom.
 *
 * The logs are empty because iOS kills the WebContent process, not the app.
 * Our JavaScript dies with it, logger included; Capacitor reloads; uiStore
 * seeds currentView from bootView — 'dashboard'. A memory kill and a cold boot
 * are indistinguishable from inside the web layer.
 *
 * The detector is a flag raised in the foreground and lowered on every orderly
 * exit. Two properties decide whether it is worth anything, and both are here:
 *
 *   1. It must catch a foreground death. That is the report.
 *   2. It must NOT cry wolf on a backgrounded app. iOS kills suspended apps
 *      constantly and it costs the skipper nothing; if those were reported the
 *      count would be meaningless and nobody would read it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    armSessionWatch,
    clearAbnormalExit,
    detectAbnormalExit,
    markOrderlyExit,
    markSessionOpen,
    noteRestored,
    readAbnormalExit,
    shouldRestore,
} from '../services/webContentKill';

const OPEN = 'thalassa.sessionOpen';
const EXITS = 'thalassa.abnormalExits';
const CRUMB = 'thalassa.lastView';

describe('detecting a foreground death', () => {
    beforeEach(() => localStorage.clear());

    it('reports a session that never exited in an orderly way', () => {
        markSessionOpen('voyage');
        // …process dies here. No cleanup runs. Next boot:
        const died = detectAbnormalExit();
        expect(died?.count).toBe(1);
    });

    it('stays quiet when the last exit was orderly', () => {
        markSessionOpen('voyage');
        markOrderlyExit();
        expect(detectAbnormalExit()).toBeNull();
    });

    it('stays quiet on a first run — no flag is not a death', () => {
        expect(detectAbnormalExit()).toBeNull();
    });

    it('names the screen it died on, from the breadcrumb not the flag', () => {
        // The flag records the view at the moment it was RAISED — boot. The
        // skipper then navigated to the planning screen and died there. The
        // report must say 'voyage', not 'dashboard', or it sends the next
        // investigation to the wrong screen.
        markSessionOpen('dashboard');
        localStorage.setItem(CRUMB, JSON.stringify({ view: 'voyage', at: Date.now() }));
        expect(detectAbnormalExit()?.view).toBe('voyage');
    });

    it('falls back to the flag when no breadcrumb exists', () => {
        markSessionOpen('dashboard');
        expect(detectAbnormalExit()?.view).toBe('dashboard');
    });

    it('tallies across sessions, so a pattern is visible', () => {
        for (let i = 1; i <= 3; i++) {
            markSessionOpen('voyage');
            expect(detectAbnormalExit()?.count).toBe(i);
        }
        expect(readAbnormalExit()?.count).toBe(3);
    });

    it('consumes the flag, so one death is not reported on every later boot', () => {
        markSessionOpen('voyage');
        expect(detectAbnormalExit()?.count).toBe(1);
        expect(detectAbnormalExit()).toBeNull();
        expect(detectAbnormalExit()).toBeNull();
        expect(readAbnormalExit()?.count).toBe(1);
    });

    it('ignores a corrupt flag rather than inventing a death', () => {
        localStorage.setItem(OPEN, 'not json');
        expect(detectAbnormalExit()).toBeNull();
        localStorage.setItem(OPEN, JSON.stringify({ view: 'voyage' })); // no timestamp
        expect(detectAbnormalExit()).toBeNull();
    });

    it('survives a corrupt tally by starting a new one', () => {
        localStorage.setItem(EXITS, '{{{');
        markSessionOpen('voyage');
        expect(detectAbnormalExit()?.count).toBe(1);
    });

    it('can be cleared', () => {
        markSessionOpen('voyage');
        detectAbnormalExit();
        clearAbnormalExit();
        expect(readAbnormalExit()).toBeNull();
    });
});

describe('backgrounding is an orderly exit — this is what stops the crying wolf', () => {
    beforeEach(() => localStorage.clear());

    it('lowers the flag when the app goes to the background', () => {
        armSessionWatch('voyage');
        expect(localStorage.getItem(OPEN)).not.toBeNull();

        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        // iOS may now kill the suspended app. That costs the skipper nothing
        // and must not be reported as a crash.
        expect(localStorage.getItem(OPEN)).toBeNull();
        expect(detectAbnormalExit()).toBeNull();
    });

    it('raises it again when the app comes back to the front', () => {
        armSessionWatch('voyage');
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        localStorage.setItem(CRUMB, JSON.stringify({ view: 'voyage', at: Date.now() }));

        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        expect(localStorage.getItem(OPEN)).not.toBeNull();
        // A death now, in the foreground, IS reportable.
        expect(detectAbnormalExit()?.view).toBe('voyage');
    });

    it('treats a deliberate reload or navigation away as orderly', () => {
        armSessionWatch('voyage');
        window.dispatchEvent(new Event('pagehide'));
        expect(detectAbnormalExit()).toBeNull();
    });
});

describe('armSessionWatch', () => {
    beforeEach(() => localStorage.clear());

    it('reports the previous death and arms the next session in one call', () => {
        markSessionOpen('voyage');
        localStorage.setItem(CRUMB, JSON.stringify({ view: 'voyage', at: Date.now() }));

        const died = armSessionWatch('dashboard');
        expect(died?.count).toBe(1);
        expect(died?.view).toBe('voyage');
        // And the new session is now being watched.
        expect(localStorage.getItem(OPEN)).not.toBeNull();
    });

    it('returns null on a clean start but still arms', () => {
        expect(armSessionWatch('dashboard')).toBeNull();
        expect(localStorage.getItem(OPEN)).not.toBeNull();
    });
});

describe('restoring must not become a crash loop', () => {
    beforeEach(() => localStorage.clear());

    it('restores the first time', () => {
        expect(shouldRestore('map')).toBe(true);
    });

    it('stands off when the view we restored to died again', () => {
        // Shane's log, 2026-08-09 — the loop this guard exists for:
        //   died 2x ... on 'map'
        //   restoring the skipper to 'map'
        //   died 3x ... on 'map'
        // Sending them back into the screen that kills the app traps them:
        // they cannot reach Settings or the chart cache to dig themselves out.
        noteRestored('map');
        expect(shouldRestore('map')).toBe(false);
    });

    it('still restores a DIFFERENT view — the stand-off is per screen', () => {
        noteRestored('map');
        expect(shouldRestore('voyage')).toBe(true);
    });

    it('forgets the stand-off after a session that ended cleanly', () => {
        noteRestored('map');
        expect(shouldRestore('map')).toBe(false);
        // A boot with no raised flag means last time worked.
        expect(detectAbnormalExit()).toBeNull();
        expect(shouldRestore('map')).toBe(true);
    });

    it('keeps standing off across consecutive deaths on the same view', () => {
        noteRestored('map');
        markSessionOpen('map');
        expect(detectAbnormalExit()?.count).toBe(1);
        expect(shouldRestore('map')).toBe(false);
    });
});

describe('the two false positives that inflated the count to 21', () => {
    beforeEach(() => localStorage.clear());

    it('does not report a death across a build change — that is Xcode, not a crash', () => {
        // An Xcode "Run" terminates the running app to install the new one,
        // in the foreground, with no cleanup. Identical evidence to a crash.
        // Shane installed builds all day on 2026-08-09 and every one counted.
        localStorage.setItem(
            'thalassa.sessionOpen',
            JSON.stringify({ at: Date.now(), view: 'map', build: 'OLDHASH1' }),
        );
        // The running bundle reports a different hash.
        const script = document.createElement('script');
        script.setAttribute('src', '/assets/index-NEWHASH2.js');
        document.head.appendChild(script);

        expect(detectAbnormalExit()).toBeNull();
        // …and the flag is consumed, so it cannot be re-reported next boot.
        expect(localStorage.getItem('thalassa.sessionOpen')).toBeNull();
        script.remove();
    });

    it('still reports a death when the build is unchanged', () => {
        const script = document.createElement('script');
        script.setAttribute('src', '/assets/index-SAMEHASH.js');
        document.head.appendChild(script);

        markSessionOpen('map');
        expect(detectAbnormalExit()?.count).toBe(1);
        script.remove();
    });

    it('listens for Capacitor appStateChange, not just visibilitychange', () => {
        // WKWebView does not reliably fire visibilitychange when a Capacitor
        // app backgrounds. This codebase already knew — MusicPage says
        // "Capacitor's appStateChange is the reliable signal", ShipLogService
        // uses both — and this module did not, so every ordinary
        // suspend-then-terminate was reported as a foreground death.
        const source = readFileSync(resolve(process.cwd(), 'services/webContentKill.ts'), 'utf8');
        expect(source).toContain("import('@capacitor/app')");
        expect(source).toMatch(/appStateChange/);
        expect(source).toMatch(/if \(isActive\) markSessionOpen/);
    });
});
