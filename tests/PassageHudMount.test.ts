/**
 * Where the passage pane lives and what it is allowed to touch, pinned —
 * because App.tsx and the chart are busy files, and a pane that silently stops
 * mounting, or quietly covers a licence credit, fails without a sound.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync('App.tsx', 'utf8');
const css = readFileSync('index.css', 'utf8');
const pane = readFileSync('components/passage/PassageHudPane.tsx', 'utf8');
const hook = readFileSync('hooks/usePassageHudInstruments.ts', 'utf8');
const paneCode = pane.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the passage pane on the Obs chart', () => {
    it('mounts inside the chart main, never over the picker or the route tracer, and hands the strip Back', () => {
        expect(app).toContain("import { PassageHudPane } from './components/passage/PassageHudPane';");
        expect(app).toMatch(/\{chartVisible && !mapPickerActive && !tracerActive && \(\s*<PassageHudPane/);
        expect(app).toMatch(
            /<PassageHudPane[\s\S]{0,420}onBack=\{\(\) => \{\s*delete window\.__thalassaPinView;\s*setPage\(previousView \|\| 'dashboard'\);/,
        );
        // Inside the chart <main> (after MapHub, before the offline chip), so it
        // rides with the split frame instead of the device viewport.
        const mapHubAt = app.indexOf('<MapHub');
        const paneAt = app.indexOf('<PassageHudPane');
        const offlineAt = app.indexOf('Offline chip — matches the wifi-slash chip');
        expect(mapHubAt).toBeGreaterThan(-1);
        expect(paneAt).toBeGreaterThan(mapHubAt);
        expect(offlineAt).toBeGreaterThan(paneAt);
    });

    it('is off by default and switched on from Preferences', () => {
        const store = readFileSync('stores/passageHudStore.ts', 'utf8');
        expect(store).toContain("const ENABLED_KEY = 'thalassa_passage_hud_enabled_v1';");
        expect(paneCode).toMatch(/if \(!enabled\) return null;/);
        expect(readFileSync('components/settings/GeneralTab.tsx', 'utf8')).toContain('<PassageStripSection />');
        expect(readFileSync('components/settings/PassageStripSection.tsx', 'utf8')).toContain(
            'onChange={setPassageHudEnabled}',
        );
        expect(app).toMatch(/chartVisible && passageHudEnabled && passageHudOpen && !mapPickerActive && !tracerActive/);
    });

    it('is no wider than the gap the centred chart furniture leaves, so no licence credit is ever moved', () => {
        expect(pane).toContain('w-[4.75rem]');
        expect(css).not.toMatch(/data-passage-hud[^{]*(credit|Copernicus|rainviewer)/i);
    });

    it('uses pixel clearances where its neighbours are pixel-anchored, and pays the insets in the split like they do', () => {
        expect(css).toMatch(/\.thalassa-passage-hud \{\s*top: calc\(env\(safe-area-inset-top\) \+ 60px\);/);
        expect(css).toContain(
            'max-height: calc(100% - env(safe-area-inset-top) - 60px - 232px - env(safe-area-inset-bottom));',
        );
        expect(css).not.toMatch(/\[data-split-pane='chart'\] \.thalassa-passage-hud \{/);
    });

    it('stands down for the planner, the consensus matrix, a storm card and a landscape phone', () => {
        for (const owner of [
            '.thalassa-passage-banner',
            "button[aria-label='Close consensus matrix']",
            '.storm-hud-badges',
        ]) {
            expect(css).toContain(`main:has(${owner}) .thalassa-passage-hud,`);
            expect(css).toContain(`main:has(${owner}) .thalassa-passage-hud-tab`);
        }
        expect(css).toMatch(
            /@media \(orientation: landscape\) and \(max-height: 600px\) \{\s*\.thalassa-passage-hud,\s*\.thalassa-passage-hud-tab,\s*\.thalassa-route-scrubber \{\s*display: none;/,
        );
        expect(readFileSync('components/map/PassageBanner.tsx', 'utf8')).toContain('thalassa-passage-banner');
        expect(readFileSync('components/map/ConsensusMatrix.tsx', 'utf8')).toContain(
            'aria-label="Close consensus matrix"',
        );
        expect(readFileSync('components/map/useCycloneLayer.ts', 'utf8')).toContain('storm-hud-badges');
    });

    it('its neighbours yield only while the strip is really on screen', () => {
        const shown =
            "main[data-passage-hud='open']:not(:has(.thalassa-passage-banner)):not(:has(button[aria-label='Close consensus matrix'])):not(:has(.storm-hud-badges))";
        // Whitespace-blind: the formatter wraps these long selectors as it likes.
        const squash = (t: string) => t.replace(/\s+/g, '');
        const flat = squash(css);
        for (const neighbour of [
            '.thalassa-map-back { display: none; }',
            '.thalassa-helix-legend { left: calc(4.75rem + 12px) !important; bottom: calc(50% - 24px) !important; }',
            '.fixed.left-2.z-140 { left: calc(4.75rem + 8px); }',
        ]) {
            expect(flat, neighbour).toContain(squash(`${shown} ${neighbour}`));
        }
        expect(flat).toContain(squash('@media not ((orientation: landscape) and (max-height: 600px)) {'));
        // The selectors those rules lean on still exist where they point.
        expect(app).toContain('className="thalassa-map-back absolute z-601 px-3"');
        expect(readFileSync('components/map/ThalassaHelixControl.tsx', 'utf8')).toContain(
            'className="thalassa-helix-legend absolute z-500"',
        );
        expect(readFileSync('components/map/MapHub.tsx', 'utf8')).toContain(
            'className="fixed left-2 z-140 flex flex-col-reverse gap-2 pointer-events-none"',
        );
    });

    it('the ENC notice states its own transform in every context it is moved in', () => {
        const flat = css.replace(/\s+/g, ' ');
        expect(flat).toMatch(
            /\.thalassa-enc-coverage-notice \{ left: calc\(4\.75rem \+ \(100% - 4\.75rem\) \/ 2\); width: min\(390px, calc\(100% - 4\.75rem - 24px\)\); transform: translateX\(-50%\); \}/,
        );
        expect(flat).toMatch(
            /\[data-split-pane='chart'\] \.thalassa-enc-coverage-notice \{ left: calc\(4\.75rem \+ 72px\); width: min\(390px, calc\(100% - 4\.75rem - 152px\)\); transform: none; \}/,
        );
        expect(flat).toMatch(
            /max-width: 360px\) \{ main\[data-passage-hud='open'\][^{]*\.thalassa-enc-coverage-notice \{ left: calc\(4\.75rem \+ 8px\); width: calc\(100% - 4\.75rem - 20px\); transform: none; \}/,
        );
    });

    it('folds the wind legend while it is open, without taking the skipper’s own tap away', () => {
        const helix = readFileSync('components/map/ThalassaHelixControl.tsx', 'utf8');
        expect(helix).toContain('const showLegend = legendChoice ?? !(hudEnabled && hudOpen && !embedded);');
    });

    it('sits under the consensus matrix and the offline card, over the legend and the credits', () => {
        expect(paneCode.match(/z-549/g)?.length).toBe(2);
        expect(readFileSync('components/map/MapHub.tsx', 'utf8')).toContain('absolute z-550 left-1/2 top-1/2');
    });

    it('keeps its Hide control at the foot, clear of the notices that gather at the top of the chart', () => {
        const hideAt = paneCode.indexOf('Hide passage instruments');
        const lastCellAt = paneCode.lastIndexOf('<Cell');
        expect(hideAt).toBeGreaterThan(lastCellAt);
    });

    it('is not a dialog and carries no scrim', () => {
        expect(pane).not.toMatch(/role="dialog"/);
        expect(pane).not.toMatch(/aria-modal/);
    });

    it('never subscribes the chart to every instrument sample', () => {
        expect(paneCode).not.toMatch(/useNmeaStore\(/);
        expect(hook).toMatch(/NmeaStore\.subscribe\(/);
        expect(hook).toMatch(/same\(prev, next\) \? prev : next/);
    });

    it('never shows the own-ship resolver’s or the phone’s speed and heading', () => {
        expect(paneCode).not.toMatch(/own\.(sog|cog)/);
        expect(paneCode).not.toMatch(/pos\.(speed|heading)/);
    });

    it('never switches the Passage overlay off, and only switches it on from a tap', () => {
        expect(paneCode).not.toMatch(/setPassageOverlay\(false\)/);
        // Two taps may turn it on: the route-and-track button, and LOOK AHEAD
        // (a ghost with no route on the chart is a boat adrift). Both are
        // inside an onClick — nothing turns it on by mounting or rendering.
        const ons = [...paneCode.matchAll(/setPassageOverlay\(true\)/g)];
        expect(ons).toHaveLength(2);
        for (const on of ons) {
            const before = paneCode.slice(Math.max(0, on.index - 320), on.index);
            expect(before).toMatch(/onClick=\{\(\) => \{(?![\s\S]*\}\}\s*\n\s*className)/);
        }
    });

    it('never starts the cloud lane from the chart', () => {
        expect(paneCode).not.toMatch(/CloudTelemetryService/);
    });
});

/**
 * Phase 2 — look ahead. The same kind of pins: where it is wired, and what it
 * must never do to the chart's own furniture or to a licence credit.
 */
describe('the look-ahead scrubber, ghost and wind timeline', () => {
    const mapHub = readFileSync('components/map/MapHub.tsx', 'utf8');
    const controls = readFileSync('components/map/MapWeatherControls.tsx', 'utf8');
    const layers = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
    const store = readFileSync('stores/passageHudStore.ts', 'utf8');
    const scrubber = readFileSync('components/passage/RouteTimeScrubber.tsx', 'utf8');
    const sampler = readFileSync('services/routeForecastSampler.ts', 'utf8');
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

    it('the chart draws the ghost from ONE hook line, off on the planning surfaces', () => {
        expect(mapHub).toContain("import { useRouteGhostMarker } from './useRouteGhostMarker';");
        expect(mapHub).toContain('useRouteGhostMarker(mapRef, mapReady && !planningSurface);');
    });

    it('there is never a second time slider: the chart’s own controls stand down, and their credits do not', () => {
        expect(controls).toContain('const passageLookAheadOn = usePassageLookAheadOn();');
        // Above the early return — a hook runs on every render or on none.
        expect(controls.indexOf('usePassageLookAheadOn()')).toBeLessThan(
            controls.indexOf('if (!visible) return null;'),
        );
        expect(controls).toContain('const showTimeline = !controlsHidden && !lookingAhead;');
        expect(controls).toContain('{lookingAhead ? null : controlsHidden ? (');
        // The RainViewer credit is gated on the radar being shown — never on the timeline.
        expect(flat(controls)).toContain('{showRainViewerAttribution && (');
        expect(controls).not.toMatch(/showRainViewerAttribution\s*=[^;]*lookingAhead/);
    });

    it('the furniture subscribes to ON/OFF only — not to an offset that changes at drag rate', () => {
        expect(controls).not.toMatch(/usePassageLookAhead\(\)/);
        expect(store).toContain('export function usePassageLookAheadOn(): boolean');
    });

    it('the wind timeline follows the offset by the grid’s own clock, and SAYS how far its field reaches', () => {
        expect(layers).toContain('subscribePassageLookAhead(schedule)');
        expect(layers).toContain('windFrameForForecastHour(fhrs, nowHour + look.aheadMs / 3_600_000)');
        expect(layers).toContain('reportPassageWindCoverage(Math.max(0, fhrs[fhrs.length - 1] - nowHour));');
        // Through the manual-scrub path, so the Now auto-tracker leaves it alone…
        expect(layers).toMatch(/setWindHour\(Math\.round\(target\.frame \* 10\) \/ 10\);/);
        // …and handed straight back when the glance ends.
        expect(flat(layers)).toContain('lookAheadDrivingRef.current = false; windUserScrubbedRef.current = false;');
    });

    it('re-applies the glance when the layer set changes, and tells the scrubber which layers cannot follow', () => {
        expect(flat(layers)).toContain('}, [windReady, windLayerOn, windForecastHours, setWindHour, activeKey]);');
        expect(layers).toContain('reportPassageUnsyncedLayers(names);');
        // The time pills are the only pause buttons, and they are stood down.
        for (const stop of ['setRainPlaying(false);', 'setIsPlaying(false);', 'setCurrentsPlaying(false);']) {
            expect(layers).toContain(stop);
        }
    });

    it('the wind grid carries its own clock, in UTC — frame 0 is not "now"', () => {
        const fetcher = readFileSync('services/weather/OpenMeteoWindFetcher.ts', 'utf8');
        expect(fetcher).toContain('Date.parse(`${firstTime}:00Z`)');
        expect(fetcher).toContain('...(refTime ? { refTime } : {}),');
    });

    it('a man overboard ends the glance', () => {
        expect(flat(paneCode)).toContain(
            'MobService.subscribe((state) => { if (state.active) stopPassageLookAhead(); })',
        );
    });

    it('look-ahead is never persisted: the chart cannot boot into a forecast', () => {
        const lookAheadCode = store.slice(store.indexOf('// ── Look ahead'));
        expect(lookAheadCode).not.toMatch(/localStorage|sessionStorage/);
    });

    it('the scrubber’s slot is in the Mapbox credits’ own units, and clears the right-hand column', () => {
        const rule = /\.thalassa-route-scrubber \{([^}]*)\}/.exec(cssCode)?.[1] ?? '';
        expect(rule).toContain('bottom: calc(4rem + 38px + env(safe-area-inset-bottom));');
        expect(rule).toContain('right: 116px;');
        expect(rule).toContain('left: 12px;');
        // The credits themselves are never named by these rules.
        const block = css.slice(css.indexOf('/* LOOK AHEAD (phase 2)'), css.indexOf('/* Surfaces that own the chart'));
        expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/mapboxgl-ctrl|attrib|logo/);
    });

    it('stands down wherever the strip does', () => {
        for (const owner of [
            '.thalassa-passage-banner',
            "button[aria-label='Close consensus matrix']",
            '.storm-hud-badges',
        ]) {
            expect(flat(cssCode)).toContain(`main:has(${owner}) .thalassa-route-scrubber`);
        }
        expect(flat(cssCode)).toMatch(
            /@media \(orientation: landscape\) and \(max-height: 600px\) \{ \.thalassa-passage-hud, \.thalassa-passage-hud-tab, \.thalassa-route-scrubber \{ display: none; \}/,
        );
    });

    it('the passage nudge card steps up over the scrubber — the control in use does not move', () => {
        expect(readFileSync('components/vessel/PassageKitPrompt.tsx', 'utf8')).toContain(
            'thalassa-passage-kit-prompt fixed',
        );
        expect(flat(cssCode)).toContain(
            'body:has(.thalassa-route-scrubber) .thalassa-passage-kit-prompt { bottom: calc(4rem + 146px + env(safe-area-inset-bottom)) !important; }',
        );
    });

    it('the forecast always names its model in the request, and never clamps past its end', () => {
        expect(sampler).toContain('models: model,');
        expect(sampler).toContain('if (!a && !b) return { ...EMPTY, beyond: true };');
        // Not through the adapter that clamps to its last hour (named in a comment only).
        expect(sampler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/WindFieldAdapter/);
    });

    it('the data credit on the scrubber can wrap but can never be cut off', () => {
        const credit = /<p[^>]*data-testid="route-scrub-credit"[^>]*>/.exec(flat(scrubber))?.[0] ?? '';
        expect(credit).toBeTruthy();
        expect(credit).not.toMatch(/truncate|line-clamp|whitespace-nowrap|overflow-hidden/);
    });

    it('changing the model is a centred dialog, clear of the tab bar — not a bottom sheet', () => {
        const modal = readFileSync('components/passage/PassageModelModal.tsx', 'utf8');
        expect(modal).toContain('items-center justify-center');
        expect(modal).toContain('pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]');
        expect(modal).toContain('overflow-y-auto');
        expect(modal).toContain('WindStore.setModel(choice.id);');
        expect(modal).toContain('{MODEL_ATTRIBUTION_LINE}');
    });
});
