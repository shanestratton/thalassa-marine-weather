/**
 * Where the passage pane lives and what it is allowed to touch, pinned —
 * because App.tsx and the chart are busy files, and a pane that silently stops
 * mounting, or quietly covers a licence credit, fails without a sound.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const app = readFileSync('App.tsx', 'utf8');
const css = readFileSync('index.css', 'utf8');
const pane = readFileSync('components/passage/PassageHudPane.tsx', 'utf8');
const hook = readFileSync('hooks/usePassageHudInstruments.ts', 'utf8');
const paneCode = pane.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the passage pane on the Obs chart', () => {
    it('mounts inside the chart main, never over the picker or the route tracer', () => {
        expect(app).toContain("import { PassageHudPane } from './components/passage/PassageHudPane';");
        expect(app).toMatch(/\{chartVisible && !mapPickerActive && !tracerActive &&\s*<PassageHudPane \/>\}/);
        expect(paneCode).not.toContain('onBack');
        // Inside the chart <main> (after MapHub, before the offline chip), so it
        // rides with the split frame instead of the device viewport.
        const mapHubAt = app.indexOf('<MapHub');
        const paneAt = app.indexOf('<PassageHudPane');
        const offlineAt = app.indexOf('Offline chip — matches the wifi-slash chip');
        expect(mapHubAt).toBeGreaterThan(-1);
        expect(paneAt).toBeGreaterThan(mapHubAt);
        expect(offlineAt).toBeGreaterThan(paneAt);
    });

    it('is standard, with no switch: on the chart whenever it has something to show (build 124)', () => {
        expect(paneCode).toContain('const available = passageHudAvailable({ following, preview, recording });');
        expect(paneCode).not.toContain('PassageHudEnabled');
        expect(readFileSync('components/settings/GeneralTab.tsx', 'utf8')).not.toContain('PassageStripSection');
        expect(readFileSync('components/map/MapHub.tsx', 'utf8')).not.toContain('passageHudLayerSources');
        expect(app).toContain("import { usePassageHudAvailable } from './hooks/usePassageHudAvailable';");
        expect(app).toMatch(/chartVisible && passageHudShown && passageHudOpen && !mapPickerActive && !tracerActive/);
    });

    it('doubles the original strip width for larger instruments', () => {
        expect(pane).toContain('w-[9.5rem]');
        expect(pane).toContain('text-[28px]');
        expect(pane).toContain('text-[32px]');
        expect(css).not.toMatch(/data-passage-hud[^{]*(credit|Copernicus|rainviewer)/i);
    });

    it('uses one complete-route camera owner and puts explanatory clutter inside the big i', () => {
        const map = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(map).toContain('usePassageRouteFrame({');
        expect(map).toContain('route: followedRouteCoords,');
        expect(map).toContain('routeKey: followedVoyageId,');
        expect(map.replace(/\s+/g, ' ')).toContain(
            '!showConsensus && !mobActive && !(browseCycloneVisible && closestStorm)',
        );
        expect(map).toContain('usePassageWaypointLayer({');
        expect(map).toContain('aria-label="Show whole route and current vessel position"');
        expect(map).not.toContain('<SquallLegend');
        expect(map).toContain('setPassageSquallInfoVisible(browseSquallVisible)');
        expect(pane).not.toContain('frameRemainingRoute');
        expect(pane).not.toContain('requestMapFit');
    });

    it('uses measured furniture clearance with safe-area and pixel clearances as its fallback', () => {
        const flat = css.replace(/\s+/g, ' ');
        expect(flat).toContain(
            '.thalassa-passage-hud { top: calc(env(safe-area-inset-top) + 60px + var(--passage-hud-credit-clearance, 0px));',
        );
        expect(flat).toMatch(
            /max-height: var\(\s*--passage-hud-available-height, calc\(\s*100% - env\(safe-area-inset-top\) - 60px - var\(--passage-hud-credit-clearance, 0px\) - 232px - env\(safe-area-inset-bottom\)\s*\)\s*\);/,
        );
        expect(paneCode).toContain("pane.style.setProperty('--passage-hud-available-height', `${height}px`);");
        expect(paneCode).toContain("pane.style.removeProperty('--passage-hud-available-height');");
        expect(css).not.toMatch(/\[data-split-pane='chart'\] \.thalassa-passage-hud \{/);
    });

    it('leaves an open layer panel only the room the strip leaves at its tightest', () => {
        // The consolidated layer panel (~280px) outgrew the 232px the strip
        // was built to clear, and pushed its last readings below the fold
        // (browser-tests/passage-hud-height.spec.ts). The strip publishes the
        // room below its TIGHTEST height; the panel caps itself to it (never
        // under its header and Play row), timeline first, and its body scrolls.
        expect(paneCode).toContain("pane.dataset.density = 'tight';");
        expect(paneCode).toContain("chart.style.setProperty('--passage-hud-reserve-bottom', `${reserve}px`);");
        expect(paneCode).toContain("chart.style.removeProperty('--passage-hud-reserve-bottom');");
        const flat = css.replace(/\s+/g, ' ');
        expect(flat).toContain(
            'max( calc(44px + 12px + 1px + 2px + 8px + 60px), calc(var(--passage-hud-reserve-bottom, 100%) - var(--thalassa-chart-controls-bottom)) )',
        );
        expect(flat).toMatch(
            /main\[data-passage-hud='open'\][^{]*\.thalassa-chart-controls-panel-body > :has\(\[role='slider'\]\[aria-label\$=' timeline'\]\) \{ order: -1; \}/,
        );
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
            '.thalassa-helix-legend { left: calc(9.5rem + 12px) !important; bottom: calc(50% - 24px) !important; }',
        ]) {
            expect(flat, neighbour).toContain(squash(`${shown} ${neighbour}`));
        }
        expect(flat).toContain(squash('@media not ((orientation: landscape) and (max-height: 600px)) {'));
        // The selectors those rules lean on still exist where they point.
        expect(app).not.toContain('className="thalassa-map-back absolute z-601 px-3"');
        expect(readFileSync('components/map/ThalassaHelixControl.tsx', 'utf8')).toContain(
            'className="thalassa-helix-legend absolute z-500"',
        );
        const map = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(map).toContain('<BlitzortungAttribution visible compact />');
        expect(map).toContain('top: creditsStripTop(');
        expect(map).toContain('<ObsLayerKey {...obsKeyProps} />');
    });

    it('the ENC notice states its own transform in every context it is moved in', () => {
        const flat = css.replace(/\s+/g, ' ');
        expect(flat).toMatch(
            /\.thalassa-enc-coverage-notice \{ left: calc\(9\.5rem \+ \(100% - 9\.5rem\) \/ 2\); width: min\(390px, calc\(100% - 9\.5rem - 24px\)\); transform: translateX\(-50%\); \}/,
        );
        expect(flat).toMatch(
            /\[data-split-pane='chart'\] \.thalassa-enc-coverage-notice \{ left: calc\(9\.5rem \+ 8px\); width: min\(390px, calc\(100% - 9\.5rem - 88px\)\); transform: none; \}/,
        );
        expect(flat).toMatch(
            /max-width: 360px\) \{ main\[data-passage-hud='open'\][^{]*\.thalassa-enc-coverage-notice \{ left: calc\(9\.5rem \+ 8px\); width: calc\(100% - 9\.5rem - 20px\); transform: none; \}/,
        );
    });

    it('folds the wind legend while it is open, without taking the skipper’s own tap away', () => {
        const helix = readFileSync('components/map/ThalassaHelixControl.tsx', 'utf8');
        expect(helix).toContain('const showLegend = legendChoice ?? !(hudShown && hudOpen && !embedded);');
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
        // Two user actions may turn it on: route-and-track and departure confirmation.
        // (a ghost with no route on the chart is a boat adrift). Both are
        // inside an onClick — nothing turns it on by mounting or rendering.
        const ons = [...paneCode.matchAll(/setPassageOverlay\(true\)/g)];
        expect(ons).toHaveLength(2);
        for (const on of ons) {
            const before = paneCode.slice(Math.max(0, on.index - 650), on.index);
            expect(before).toMatch(/(?:onClick=\{\(\) => \{|onConfirm=\{\(departureMs\) => \{)/);
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
        // A route previewed on Obs (build 124) is on the chart without the Passage overlay.
        expect(mapHub).toContain(
            'useRouteGhostMarker(mapRef, mapReady && !planningSurface && (passageOverlay || obsRoutePreview !== null));',
        );
    });

    it('there is never a second time slider: the chart’s own controls stand down, and their credits do not', () => {
        expect(controls).toContain('const passageLookAheadOn = usePassageLookAheadOn();');
        // Above the early return — a hook runs on every render or on none.
        expect(controls.indexOf('usePassageLookAheadOn()')).toBeLessThan(
            controls.indexOf('if (!visible) return null;'),
        );
        expect(controls).toContain('const showTimeline = !controlsHidden && !lookingAhead;');
        expect(controls).toContain('{!surfaceAvailable ? null : controlsHidden ? (');
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
        expect(layers).toContain('passageWindTimeSelection(fhrs, refTime, look, Date.now())');
        expect(layers).toContain('reportPassageWindCoverage(selection.coverageHours);');
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
            'MobService.subscribe((state) => { mobActiveRef.current = !!state.active; if (state.active) { setDepartureOpen(false); setModelOpen(false); stopPassageLookAhead(); } })',
        );
    });

    it('look-ahead is never persisted: the chart cannot boot into a forecast', () => {
        // The look-ahead's own section, up to the ghost-speed PREFERENCE that follows
        // it (which IS remembered — it is a setting, not a glance).
        const from = store.indexOf('// ── Look ahead');
        const to = store.indexOf('// ── How the ghost makes her way');
        expect(from).toBeGreaterThan(-1);
        expect(to).toBeGreaterThan(from);
        expect(store.slice(from, to)).not.toMatch(/localStorage|sessionStorage/);
        // …and nothing after it stores an offset, a playing flag or a ghost.
        expect(store.slice(to)).not.toMatch(/setItem\([^)]*(ahead|ghost|playing)/i);
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
            // 171px in phase 3 (the credit names every provider in the band and wraps); 186px since
            // phase 4 added the sea's providers and a possible third line.
            'body:has(.thalassa-route-scrubber) .thalassa-passage-kit-prompt { bottom: calc(4rem + 186px + env(safe-area-inset-bottom)) !important; }',
        );
    });

    it('the forecast always names its model in the request, and never clamps past its end', () => {
        expect(sampler).toContain('models: model,');
        expect(sampler).toContain('if (!a && !b) return { ...EMPTY, beyond: true };');
        // Not through the adapter that clamps to its last hour (named in a comment only).
        expect(sampler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/WindFieldAdapter/);
    });

    it('the data credit is in the big i panel, wraps, and cannot be cut off', () => {
        const info = readFileSync('components/passage/PassageHudInfoCard.tsx', 'utf8');
        const status = readFileSync('components/SystemStatusButton.tsx', 'utf8');
        const credit = /<p[^>]*data-testid="route-scrub-credit"[^>]*>/.exec(flat(info))?.[0] ?? '';
        expect(credit).toBeTruthy();
        expect(credit).not.toMatch(/truncate|line-clamp|whitespace-nowrap|overflow-hidden/);
        expect(status).toContain('<PassageHudInfoCard />');
        expect(scrubber).not.toContain('data-testid="route-scrub-credit"');
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

/**
 * Phase 3 — model spread, the speed model, rain following the scrubber. Pins
 * for the things that fail without a sound.
 */
describe('phase 3: spread, speed and rain', () => {
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    const code = (path: string) =>
        readFileSync(path, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
    const spread = code('services/routeForecastSpread.ts');
    const plan = code('services/passagePlan.ts');
    const layers = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
    const controls = readFileSync('components/map/MapWeatherControls.tsx', 'utf8');

    it('the spread reads ONLY suffixed keys — an unsuffixed reply can never become five models agreeing perfectly', () => {
        expect(spread).toContain('hourly?.[`${key}_${model}`]');
        expect(spread).not.toMatch(/hourly\?\.\[key\]/);
    });

    it('the spread never replaces the headline: the strip’s number is still the chart’s one model', () => {
        expect(flat(paneCode)).toContain('value={fmtKnots(fc(sample?.twsKts))}');
        expect(paneCode).not.toMatch(/meanKts|averageKts|consensusKts/);
    });

    it('one request for all five, by name — and the single-model request is only the fallback', () => {
        expect(spread).toContain("models: ids.join(','),");
        expect(flat(paneCode)).toContain(
            // A FRESH bundle's member is the headline; a stale one never is.
            'const forecast = (spreadFresh ? member : null) ?? (await loadRouteForecast(routeCoords, id)) ?? member;',
        );
    });

    it('thresholds are the Glass convergence sheet’s, so the two cannot contradict each other', () => {
        expect(spread).toContain('export const SPREAD_SOME_KTS = 4;');
        expect(spread).toContain('export const SPREAD_SPLIT_KTS = 8;');
        expect(spread).toContain('export const SPREAD_SOME_DEG = 20;');
        expect(spread).toContain('export const SPREAD_SPLIT_DEG = 45;');
    });

    it('no wind forecast is never fed to a polar: it is ASSUMED at cruising speed, and said', () => {
        expect(flat(plan)).toContain(
            "if (twsKts === null || twdDeg === null || !Number.isFinite(courseDeg)) return flat('assumed');",
        );
        // …and that return sits ABOVE the polar lookup, not after it.
        expect(plan.indexOf("return flat('assumed');")).toBeLessThan(
            plan.indexOf('createPolarSpeedLookup(model.polar, twsKts)'),
        );
        expect(paneCode).toContain("assumed: 'NO WX'");
    });

    it("sails the routers' polar (125-08): the learned one only through the resolver, never its raw zeros", () => {
        // The learned grid's empty cells are zeros; only services/routingPolar
        // (through hooks/useRoutingPolar) may read it, blended and banded.
        expect(paneCode).not.toMatch(/SmartPolarStore/);
        expect(plan).not.toMatch(/SmartPolarStore/);
        expect(paneCode).not.toContain('polarData ?? DEFAULT_CRUISING_POLAR');
        expect(flat(paneCode)).toContain('const routing = useRoutingPolar(vessel);');
    });

    it('everything on screen reads ONE plan table — no second copy of the arithmetic', () => {
        // Phase 2's linear formula is gone from the strip.
        expect(paneCode).not.toMatch(/cruiseKts \* aheadMs/);
        expect(paneCode).not.toMatch(/toGoNm \/ cruiseKts/);
        expect(flat(paneCode)).toContain('const moment = plan ? planAt(plan, aheadMs) : null;');
    });

    it('rain is chosen by CLOCK, as an integer, and never while a frame is still warming up', () => {
        expect(layers).toContain('passageRainTimeSelection(frames, rainNowIdxRef.current, look, now)');
        expect(flat(layers)).toContain('if (busy) { timer = setTimeout(apply, 400); return; }');
        expect(layers).toContain('timeMs: f.time * 1000,');
        expect(layers).toContain('snapshotClockMs(rainbowSnapshot, Date.now())');
    });

    it('rain is "unsynced" when its frames cannot follow the selected departure clock', () => {
        expect(flat(layers)).toContain(
            "activeLayers.has('rain') && (!rainReady || rainFollowUnsynced || rainFollowFailed)",
        );
    });

    it('whoever’s rain imagery is on screen is named — radar AND forecast — and never gated on look-ahead', () => {
        expect(controls).toContain('Rain forecast by Rainbow.ai');
        expect(controls).toContain("currentRainFrame?.type === 'forecast';");
        expect(controls).not.toMatch(/showRainForecastAttribution\s*=[^;]*lookingAhead/);
        expect(flat(controls)).toContain('{showRainForecastAttribution && (');
        // …and the Copernicus credit stacks under either of them.
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(flat(hub)).toMatch(
            /const rainCreditShown = weather\.activeLayers\.has\('rain'\) && weather\.rainReady &&/,
        );
        expect(hub).toContain('!!weather.unifiedFramesRef?.current?.[weather.rainFrameIndex];');
    });

    it('the speed choice is a remembered PREFERENCE; the look-ahead itself still is not', () => {
        const store = readFileSync('stores/passageHudStore.ts', 'utf8');
        expect(store).toContain("const SPEED_KEY = 'thalassa_passage_speed_mode_v1';");
    });

    it('review: the rain follower judges the frame that is PAINTED, not the one it asked for', () => {
        expect(layers).toContain('rainCommittedIdxRef.current = requestedIndex;');
        expect(layers).toContain('if (target === observed || rainCommittedIdxRef.current === target) {');
        expect(layers).toContain('setRainFollowFailed(true);');
        expect(flat(layers)).toContain('(!rainReady || rainFollowUnsynced || rainFollowFailed)');
    });

    it('review: the offset is never rewritten from a plan walked while the series is still loading', () => {
        expect(flat(paneCode)).toContain('if (!look.on || !plan || !axisKnown) return;');
        expect(flat(paneCode)).toContain(
            'const axisKnown = !!plan && (forecastSettled || forecast !== null || lastMaxRef.current === 0);',
        );
    });

    it('review: the two warnings are outside the scrolling cells', () => {
        // Parse the actual JSX boundaries: a comment before the warnings does
        // not prove they are outside the scroller's closing tag.
        const source = ts.createSourceFile('PassageHudPane.tsx', pane, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const elementWith = (attribute: string, value: string): ts.JsxElement => {
            const matches: ts.JsxElement[] = [];
            const visit = (node: ts.Node) => {
                if (
                    ts.isJsxElement(node) &&
                    node.openingElement.attributes.properties.some(
                        (prop) =>
                            ts.isJsxAttribute(prop) &&
                            prop.name.getText(source) === attribute &&
                            prop.initializer &&
                            ts.isStringLiteral(prop.initializer) &&
                            prop.initializer.text === value,
                    )
                ) {
                    matches.push(node);
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
            expect(matches, `${attribute}=${value}`).toHaveLength(1);
            return matches[0];
        };
        const scroller = elementWith('className', 'thalassa-passage-hud-cells min-h-0 flex-1 overflow-y-auto');
        // The Ahead/Live button is one renderer (a preview puts it in the bottom
        // row): the warnings render before either of its places in the strip.
        elementWith('data-testid', 'hud-look-ahead');
        const lookAheadAt = pane.indexOf('{followingRoute && renderLookAhead(');
        const bottomRowAt = pane.indexOf("renderLookAhead('h-11 w-1/2 border-r border-white/10', true)");
        expect(lookAheadAt).toBeGreaterThan(-1);
        expect(bottomRowAt).toBeGreaterThan(lookAheadAt);
        for (const id of ['hud-models-split', 'hud-forecast-note']) {
            const warning = elementWith('data-testid', id);
            expect(warning.getStart(source), id).toBeGreaterThan(scroller.getEnd());
            expect(warning.getEnd(), id).toBeLessThan(lookAheadAt);
        }
    });
});

/**
 * Phase 4 — sea state and current at the ghost. Built on a measured probe; the
 * pins are the probe's conclusions, so that nobody "simplifies" them away.
 */
describe('phase 4: the sea at the ghost', () => {
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    const seaSrc = readFileSync('services/routeSeaSampler.ts', 'utf8');
    const seaCode = seaSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('every station’s echoed position is checked by the app’s ONE snap guard function — with the sea’s own, tighter pad', () => {
        expect(seaCode).toContain("import { maxLegitimateSnapKm } from './weather/api/marine';");
        expect(flat(seaCode)).toContain(
            'const inshore = snapKm === null || snapKm > maxLegitimateSnapKm(station.lat, SEA_SNAP_PAD);',
        );
        expect(seaCode).toContain('const SEA_SNAP_PAD = 1.03;');
        expect(seaCode).not.toMatch(/SNAP_TOLERANCE|GRID_DEG/);
        // The report path's own pad is untouched: the default argument is its constant.
        expect(readFileSync('services/weather/api/marine.ts', 'utf8')).toContain(
            'export function maxLegitimateSnapKm(lat: number, tolerance: number = SNAP_TOLERANCE): number {',
        );
    });

    it('one request: the NAMED wave model and best match — the only thing that carries currents', () => {
        expect(seaCode).toContain("export const SEA_WAVE_MODEL = 'meteofrance_wave';");
        expect(seaCode).toContain('models: `${SEA_WAVE_MODEL},best_match`,');
        expect(seaCode).toContain("const CURRENT_SUFFIX = 'marine_best_match';");
        // Best match's WAVES are never read: a wave number always has a named model.
        expect(seaCode).not.toMatch(
            /wave_(height|period|direction)_\$\{CURRENT_SUFFIX\}|wave_height_marine_best_match/,
        );
    });

    it('units are checked, not assumed: metres for waves, km/h (or knots) for current, anything else is no data', () => {
        expect(flat(seaCode)).toContain("const waveUnitOk = units?.[`wave_height_${SEA_WAVE_MODEL}`] === 'm';");
        expect(flat(seaCode)).toContain(
            "const toKts = currentUnit === 'km/h' ? 1 / NM_TO_KM : currentUnit === 'kn' ? 1 : null;",
        );
        // …and the strip converts metres with the METRES converter, never the feet-based one.
        expect(paneCode).toContain("import { convertMetersTo } from '../../utils/units';");
        expect(paneCode).not.toMatch(/convertLength\(/);
    });

    it('the current is never applied to the plan, and no wind-against-tide warning is built on it', () => {
        const planCode = readFileSync('services/passagePlan.ts', 'utf8');
        expect(planCode).not.toMatch(/routeSeaSampler|currentKts|currentAlong/);
        expect(paneCode).not.toMatch(/wind.?against|windVsTide|WIND V TIDE/i);
    });

    it('the sea is keyed by the ROUTE alone, and the wind cells never wait on it', () => {
        expect(seaCode).toContain("routeForecastKey(coords, 'sea')");
        expect(flat(paneCode)).toContain('}, [forecastWanted, following, routeCoords]);');
        // Its own effect and its own state: a marine failure cannot blank the wind.
        expect(paneCode).toContain('const [seaLoaded, setSeaLoaded] = useState');
    });

    it('the cells say when there is more below the fold', () => {
        expect(pane).toContain('className="thalassa-passage-hud-cells min-h-0 flex-1 overflow-y-auto"');
        const rule = /\.thalassa-passage-hud-cells \{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
        expect(rule).toContain('no-repeat local');
        expect(rule).toContain('no-repeat scroll');
    });
});
