/**
 * Shane 2026-08-28: "whole area claude, i just dont want to confuse punters
 * if i can help it."
 *
 * The survey found the confusion was not where either of us expected. The two
 * ENC screens are NOT duplicates — they are disjoint by construction, and
 * merging them would have been actively dangerous. What actually collided was
 * the NAMES: two screens both called "Boat Network", one hop apart in the same
 * menu, with the identical description. A punter who failed to find the Pi on
 * one tried the other, got the same failure in different words, and concluded
 * the app was broken.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const settings = readFileSync('components/SettingsModal.tsx', 'utf8');
const vesselHub = readFileSync('components/VesselHub.tsx', 'utf8');
const piCacheTab = readFileSync('components/settings/PiCacheTab.tsx', 'utf8');
const avNav = readFileSync('components/vessel/AvNavPage.tsx', 'utf8');
const banner = readFileSync('components/map/ChartDepthControls.tsx', 'utf8');
const encCard = readFileSync('components/vessel/EncCellManager.tsx', 'utf8');

describe('two screens, two names', () => {
    it('leaves the everyday glance called Boat Network', () => {
        // The one you tap to ask "is the boat there?" keeps the name.
        expect(vesselHub).toContain('label="Boat Network"');
    });

    it('names the settings tab for what it actually owns', () => {
        // Pairing, the security fingerprint, Forget, the mDNS-spoof alarm,
        // cache purge and the new-Pi wizard all live only here.
        expect(settings).toContain("label: 'Boat Pi — setup & cache',");
        expect(settings).toContain("description: 'Pairing, install, cache & anchor',");
    });

    it('does not use the name twice', () => {
        expect(settings).not.toContain("label: 'Boat Network'");
    });

    it('fixes the collision inside the tab as well', () => {
        // It said "Pi Cache Server" and then immediately "Boat Network".
        expect(piCacheTab).toContain('<Section title="Boat Pi">');
        expect(piCacheTab).not.toContain('<Section title="Boat Network">');
    });
});

describe('what the boat network claims to carry', () => {
    it('no longer says it carries your charts', () => {
        // The charts are on the phone. Saying the boat network carries them is
        // what makes a skipper wonder where they went when the Pi is ashore.
        expect(avNav).toContain('Pi, instruments &amp; weather cache');
        expect(avNav).not.toContain('Pi, charts, instruments &amp; weather cache');
    });

    it('drops the dead ternary that had the same string in both arms', () => {
        expect(avNav).not.toContain('? `Pi, charts, instruments & weather cache`');
    });
});

describe('the ENC card says who it is for', () => {
    it('names the requirement rather than the data format', () => {
        expect(encCard).toContain('(needs the Pi to import)');
    });

    it('calls the list what it is — most rows were never "imported" by anyone', () => {
        // Auto-sync puts them there, twenty at a time, nearest the fix.
        expect(encCard).toContain('Charts on this phone');
        expect(encCard).not.toContain('Imported Cells');
        expect(encCard).toContain('No charts on this phone yet.');
    });
});

describe('the no-coverage banner', () => {
    it('tells a skipper who owns charts how many they have and where the gap is', () => {
        expect(banner).toContain(
            "`You have ${encCellCount} ENC chart${encCellCount === 1 ? '' : 's'}, none covering here.`",
        );
    });

    it('only offers the reference Library when there are no charts at all', () => {
        // With charts installed it used to open a page that greets you with
        // "No reference ENC cells are installed" — a different kind of chart
        // entirely, and a dead end.
        expect(banner).toContain('{encCellCount === 0 && (');
    });
});

describe('unreachable chart UI is gone', () => {
    it('deletes the third Pi-discovery implementation and its guide', () => {
        // Nothing imported ChartServerTab anywhere in the tree — it was a
        // fourth mental model of "where charts come from", waiting to be
        // wired back in during exactly this cleanup.
        expect(existsSync('components/settings/ChartServerTab.tsx')).toBe(false);
        expect(existsSync('components/settings/ChartServerSetupGuide.tsx')).toBe(false);
    });

    it('deletes the orphaned ENC demo route and its layer', () => {
        expect(existsSync('components/map/EncRouteButton.tsx')).toBe(false);
        expect(existsSync('components/map/useEncTestRouteLayer.ts')).toBe(false);
    });

    it('keeps the offshore backup strategy, which existed nowhere else', () => {
        const doc = readFileSync('docs/ENC_INTEGRATION.md', 'utf8');
        expect(doc).toContain('o-charts USB dongle');
        expect(doc).toContain('Register two systems');
        // And warns why the guide must not come back as it was.
        expect(doc).toContain('~/.signalk/charts/');
    });

    it('leaves no stale reference to the deleted layer', () => {
        const seaway = readFileSync('components/map/useSeawayDebugLayer.ts', 'utf8');
        expect(seaway).not.toContain('useEncTestRouteLayer');
    });
});
