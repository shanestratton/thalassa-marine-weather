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
            /@media \(orientation: landscape\) and \(max-height: 600px\) \{\s*\.thalassa-passage-hud,\s*\.thalassa-passage-hud-tab \{\s*display: none;/,
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
        expect(paneCode.match(/setPassageOverlay\(true\)/g)?.length).toBe(1);
        expect(paneCode).toMatch(/onClick=\{\(\) => \{[\s\S]{0,120}setPassageOverlay\(true\);/);
    });

    it('never starts the cloud lane from the chart', () => {
        expect(paneCode).not.toMatch(/CloudTelemetryService/);
    });
});
