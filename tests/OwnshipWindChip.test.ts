/**
 * Her own wind as a small arrow and number on her own-ship marker (build 123,
 * W1-WC): the marker's DOM half. Shane 2026-10-07, on zoom 14 as her wind's
 * floor: "as soon as the punter zooms out from there, then the wind models
 * kick in", with her reading moving onto her boat icon so it is never lost.
 *
 * The production element and painters run on jsdom, which lays nothing out:
 * the placement here is the inline geometry, and the real layout (wide fonts,
 * a 320 px phone, contrast) is pinned in browser-tests/ownship-boat-marker.
 * Fictional values only.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('mapbox-gl', () => ({ default: { Marker: class {} }, Marker: class {} }));
vi.mock('../services/GpsService', () => ({ GpsService: { watchPosition: vi.fn(), getCurrentPosition: vi.fn() } }));
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: { getLastPosition: vi.fn(() => null) } }));

import {
    createVesselElement,
    ownshipChipSignature,
    presentOwnshipStatus,
    presentOwnshipWind,
} from '../components/map/useVesselTracker';
import { boatWindChipFor, type BoatWindReadout } from '../components/map/boatWindReadout';
import { gpsFixState } from '../components/gpsFixState';

const NOW = 1_800_000_000_000;
const OWN = { kind: 'boat', crewOwnerId: null } as const;

function chip(wind: BoatWindReadout['wind'], unit = 'kts') {
    return boatWindChipFor({ wind, boat: { crewOwnerId: null }, fieldShowsHers: false }, OWN, unit);
}

const parts = (el: HTMLElement) => ({
    badge: el.querySelector<HTMLElement>('.vessel-sog-badge')!,
    ageChip: el.querySelector<HTMLElement>('.vessel-age-chip')!,
    wind: el.querySelector<HTMLElement>('.vessel-wind-chip')!,
    arrow: el.querySelector<SVGElement>('.vessel-wind-arrow')!,
    text: el.querySelector<HTMLElement>('.vessel-wind-text')!,
});

/** The px offset in an inline `calc(50% + Npx)`. */
const offsetPx = (value: string) => Number(/^calc\(50% \+ (\d+(?:\.\d+)?)px\)$/.exec(value)?.[1] ?? NaN);

describe('her wind chip on her marker', () => {
    it('is part of the marker, hidden until there is a reading to show, and is its own element', () => {
        const el = createVesselElement();
        const { badge, ageChip, wind } = parts(el);
        expect(wind).not.toBeNull();
        expect(wind.style.display).toBe('none');
        // Never inside the badge or the age chip: their words and colours stay theirs.
        expect(badge.contains(wind)).toBe(false);
        expect(wind.contains(badge)).toBe(false);
        expect(ageChip.contains(wind)).toBe(false);
        expect(wind.parentElement).toBe(el);
        // The root keeps Mapbox's exact GPS anchor: only the chips are offset.
        expect(el.style.position).toBe('');
        expect(el.style.transform).toBe('');
    });

    it('sits under the boat, centred on her fix: clear of the badge beside her and the age chip above', () => {
        const { badge, ageChip, wind } = parts(createVesselElement());
        expect(wind.style.position).toBe('absolute');
        // Centred under her (beside the badge it ran under the right-rail zoom
        // control on a 320 px phone, which sits level with the centred boat).
        expect(wind.style.left).toBe('50%');
        expect(wind.style.transform).toBe('translateX(-50%)');
        // Below the 28 px boat, a bow heading south included (14 px + its halo).
        expect(offsetPx(wind.style.top)).toBeGreaterThanOrEqual(16);
        // The badge is centred on the fix and at most 22 px tall (12 px x 1.25, 2 px
        // padding, 1 px border): the chip starts below its foot.
        expect(badge.style.top).toBe('50%');
        expect(offsetPx(wind.style.top)).toBeGreaterThan(11);
        // The age chip is above the boat; this one is below her.
        expect(ageChip.style.top).toMatch(/^-/);
        // The app's 12 px floor, in the badge's own weight.
        expect(wind.style.fontSize).toBe('12px');
        expect(wind.style.whiteSpace).toBe('nowrap');
    });

    it('shows her speed and direction, an arrow the way the streaks fly, and names itself', () => {
        const el = createVesselElement();
        const spoken = presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: false }));
        const { wind, arrow, text } = parts(el);
        expect(wind.style.display).not.toBe('none');
        expect(text.textContent).toBe('14 kt SSW');
        expect(arrow.style.display).not.toBe('none');
        expect(arrow.style.transform).toBe('rotate(20deg)');
        expect(wind.getAttribute('role')).toBe('img');
        expect(wind.getAttribute('aria-label')).toBe('Boat wind 14 knots from south-south-west');
        expect(wind.dataset.tone).toBe('live');
        // What the marker's one spoken name adds after its own words.
        expect(spoken).toBe('boat wind 14 knots from south-south-west');
    });

    it('Calm and a direction-less reading carry no arrow', () => {
        const el = createVesselElement();
        presentOwnshipWind(el, chip({ kt: 0.3, fromDeg: null, stale: false }));
        expect(parts(el).text.textContent).toBe('Calm');
        expect(parts(el).arrow.style.display).toBe('none');
        expect(parts(el).wind.getAttribute('aria-label')).toBe('Boat wind calm');
        presentOwnshipWind(el, chip({ kt: 6, fromDeg: null, stale: false }));
        expect(parts(el).text.textContent).toBe('6 kt');
        expect(parts(el).arrow.style.display).toBe('none');
    });

    it('the stale tier is dimmed and says so; live again is not', () => {
        const el = createVesselElement();
        presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: false }));
        const liveClasses = parts(el).wind.className;
        // The badge's own chip, so daylight lightens both together.
        expect(parts(el).wind.classList.contains('bg-slate-900/94')).toBe(true);
        presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: true }));
        const { wind } = parts(el);
        expect(wind.dataset.tone).toBe('stale');
        expect(wind.className).not.toBe(liveClasses);
        expect(wind.classList.contains('text-slate-400')).toBe(true);
        expect(wind.classList.contains('text-slate-100')).toBe(false);
        expect(wind.getAttribute('aria-label')).toMatch(/\bstale\b/i);
        presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: false }));
        expect(parts(el).wind.dataset.tone).toBe('live');
        expect(parts(el).wind.className).toBe(liveClasses);
    });

    it('hides, unnamed, when there is nothing to show', () => {
        const el = createVesselElement();
        presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: false }));
        expect(presentOwnshipWind(el, null)).toBe('');
        expect(parts(el).wind.style.display).toBe('none');
        expect(parts(el).wind.hasAttribute('aria-label')).toBe(false);
    });

    it('touches the DOM only when its words, its arrow’s 5 degree step or its tone change', () => {
        const el = createVesselElement();
        presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: false }));
        const watch = new MutationObserver(() => {});
        watch.observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
        // The same reading, and an instrument tick that reads the same on screen.
        presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: false }));
        presentOwnshipWind(el, chip({ kt: 14.2, fromDeg: 201.4, stale: false }));
        expect(watch.takeRecords()).toHaveLength(0);
        // A new number: one repaint.
        presentOwnshipWind(el, chip({ kt: 15, fromDeg: 201.4, stale: false }));
        expect(watch.takeRecords().length).toBeGreaterThan(0);
        expect(parts(el).text.textContent).toBe('15 kt SSW');
        // The arrow's next step: a repaint, same words.
        presentOwnshipWind(el, chip({ kt: 15, fromDeg: 203, stale: false }));
        expect(watch.takeRecords().length).toBeGreaterThan(0);
        expect(parts(el).arrow.style.transform).toBe('rotate(25deg)');
        // Hidden, and hidden again: once.
        presentOwnshipWind(el, null);
        expect(watch.takeRecords().length).toBeGreaterThan(0);
        presentOwnshipWind(el, null);
        expect(watch.takeRecords()).toHaveLength(0);
        watch.disconnect();
    });

    it('leaves the badge’s words, colour and precedence alone, and the badge leaves it alone', () => {
        const el = createVesselElement();
        presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: false }));
        const fix = gpsFixState(NOW - 5_000, 60_000, NOW);
        presentOwnshipStatus(el, { label: 'Anchored', anchorTone: 'green', anchorNote: null }, fix);
        const { badge, text, wind } = parts(el);
        expect(badge.textContent).toBe('Anchored');
        expect(badge.dataset.tone).toBe('anchored');
        expect(text.textContent).toBe('14 kt SSW');
        expect(wind.style.display).not.toBe('none');
        presentOwnshipStatus(el, { label: 'Anchor alarm', anchorTone: 'red', anchorNote: null }, fix);
        expect(parts(el).badge.textContent).toBe('Anchor alarm');
        expect(parts(el).badge.dataset.tone).toBe('alarm');
        expect(parts(el).text.textContent).toBe('14 kt SSW');
    });

    it('is part of what a town name under own-ship must clear', () => {
        const el = createVesselElement();
        const before = ownshipChipSignature(el);
        presentOwnshipWind(el, chip({ kt: 14, fromDeg: 200, stale: false }));
        const showing = ownshipChipSignature(el);
        expect(showing).not.toBe(before);
        // A new number of the same width is the same footprint, as the badge's are.
        presentOwnshipWind(el, chip({ kt: 15, fromDeg: 200, stale: false }));
        expect(ownshipChipSignature(el)).toBe(showing);
        presentOwnshipWind(el, null);
        expect(ownshipChipSignature(el)).toBe(before);
    });
});
