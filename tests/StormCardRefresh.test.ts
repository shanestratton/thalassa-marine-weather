/**
 * The storm card's numbers were frozen for the whole session.
 *
 * Shane, 2026-08-23: "fix the storm card numbers."
 *
 * The card is built by an effect keyed on [selectedStorm?.sid, visible,
 * mapReady]. The 30-minute catalogue reload hands React a NEW ActiveCyclone
 * object with the SAME sid, so the effect never re-ran: pressure, category,
 * wind and position stayed at whatever they were when the view opened. Only
 * the 60-second age tick moved — which made a stale card look live. On a card
 * whose whole job is to say what a cyclone is doing, that is the worst kind of
 * stale: confidently wrong.
 *
 * Widening the effect's deps was the obvious fix and is the wrong one — that
 * effect ends in a 1.2 s flyTo, so the camera would lurch every half hour.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { badgeSignature, createStormBadgeStatic, refreshStormCardInPlace } from '../components/map/useCycloneLayer';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

const at = '2026-08-23T00:00:00Z';

const storm = (over: Partial<Record<string, unknown>> = {}): ActiveCyclone =>
    ({
        sid: 'wp172026',
        name: 'Saudel',
        basin: 'WP',
        category: 4,
        categoryLabel: '4',
        maxWindKts: 115,
        minPressureMb: 956,
        lastAdvisoryTime: at,
        currentPosition: { lat: 20.8, lon: 142.9, time: at, windKts: 115, pressureMb: 956 },
        track: [{ lat: 20.0, lon: 143.5, time: at, windKts: 110, pressureMb: 960 }],
        ...over,
    }) as unknown as ActiveCyclone;

/** The HUD as the card effect builds it: card wrapper first, stepper after. */
function hudWith(c: ActiveCyclone): HTMLElement {
    const container = document.createElement('div');
    const hud = document.createElement('div');
    hud.id = 'cyclone-hud-badges';
    const card = createStormBadgeStatic(c);
    card.dataset.sig = badgeSignature(c);
    hud.appendChild(card);
    const stepper = document.createElement('div');
    stepper.id = 'stepper-sentinel';
    hud.appendChild(stepper);
    container.appendChild(hud);
    return container;
}

describe('badgeSignature', () => {
    it('moves when any number on the card moves', () => {
        const base = badgeSignature(storm());
        expect(badgeSignature(storm({ minPressureMb: 948 }))).not.toBe(base);
        expect(badgeSignature(storm({ maxWindKts: 130 }))).not.toBe(base);
        expect(badgeSignature(storm({ category: 5, categoryLabel: '5' }))).not.toBe(base);
        expect(badgeSignature(storm({ currentPosition: { lat: 21.9, lon: 142.9, time: at } }))).not.toBe(base);
        expect(badgeSignature(storm({ lastAdvisoryTime: '2026-08-23T06:00:00Z' }))).not.toBe(base);
    });

    it('is stable for the same advisory, so a reload does not churn the DOM', () => {
        // A fresh object with identical numbers arrives every 30 minutes.
        expect(badgeSignature(storm())).toBe(badgeSignature(storm()));
    });
});

describe('refreshStormCardInPlace', () => {
    it('puts the new numbers on screen', () => {
        // Position and classification are on the collapsed face of the card,
        // which is what a skipper glances at — assert there.
        const container = hudWith(storm());
        expect(container.textContent).toContain('20.8°N');
        expect(container.textContent).toContain('142.9°E');

        refreshStormCardInPlace(
            container,
            storm({
                currentPosition: { lat: 22.4, lon: 140.1, time: at },
                maxWindKts: 64,
                category: 1,
                categoryLabel: '1',
            }),
        );

        expect(container.textContent).toContain('22.4°N');
        expect(container.textContent).toContain('140.1°E');
        expect(container.textContent).not.toContain('20.8°N');
    });

    it('does nothing at all when the advisory has not moved', () => {
        // The reload fires every 30 minutes whether or not anything changed;
        // rebuilding the DOM regardless would drop a tap mid-gesture.
        const container = hudWith(storm());
        const before = container.querySelector('#cyclone-hud-badges')!.firstElementChild;
        refreshStormCardInPlace(container, storm());
        expect(container.querySelector('#cyclone-hud-badges')!.firstElementChild!.innerHTML).toBe(before!.innerHTML);
    });

    it('keeps the card open if the user had it open', () => {
        const container = hudWith(storm());
        const body = container.querySelector('[data-storm-body]') as HTMLElement;
        body.style.display = 'block'; // user expanded it
        refreshStormCardInPlace(container, storm({ minPressureMb: 941 }));
        const after = container.querySelector('[data-storm-body]') as HTMLElement;
        expect(after.style.display).toBe('block');
    });

    it('keeps it collapsed if it was collapsed', () => {
        const container = hudWith(storm());
        refreshStormCardInPlace(container, storm({ minPressureMb: 941 }));
        expect((container.querySelector('[data-storm-body]') as HTMLElement).style.display).toBe('none');
    });

    it('does not replay the unroll — a refresh is not an entrance', () => {
        const container = hudWith(storm());
        refreshStormCardInPlace(container, storm({ minPressureMb: 941 }));
        const card = container.querySelector('[data-storm-body]')!.parentElement as HTMLElement;
        expect(card.style.cssText).not.toContain('storm-badge-unroll');
    });

    it('leaves the storm stepper alone', () => {
        // The stepper is a sibling of the card inside the HUD. A refresh that
        // rebuilt the whole HUD would take it out.
        const container = hudWith(storm());
        refreshStormCardInPlace(container, storm({ minPressureMb: 941 }));
        expect(container.querySelector('#stepper-sentinel')).not.toBeNull();
    });

    it('no-ops safely when no card is mounted', () => {
        expect(() => refreshStormCardInPlace(document.createElement('div'), storm())).not.toThrow();
    });
});

describe('it is driven by the catalogue, not by a prop', () => {
    it('refreshes from cyclonesRef right where the markers rebuild', () => {
        // The fresh data is already local — loadCyclones writes cyclonesRef —
        // so this needs no prop round trip and, crucially, no camera move.
        const src = readFileSync('components/map/useCycloneLayer.ts', 'utf8');
        const after = src.slice(src.indexOf('rebuildMarkers();', src.indexOf('No manual selection')));
        expect(after.slice(0, 600)).toContain('refreshStormCardInPlace(map.getContainer(), freshSel)');
        expect(after.slice(0, 600)).toContain("cyclones.find((c) => c.sid === sel.sid)");
        // And the card effect's deps must NOT have been widened to do it.
        expect(src).toContain('}, [selectedStorm?.sid, visible, mapReady]);');
    });
});
