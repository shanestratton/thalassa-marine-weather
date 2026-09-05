/**
 * The sail plan, made readable — and one real bug found on the way.
 *
 * Shane, 2026-09-05: "we need to dramatically improve the sail plan section of
 * the Instrument panel claude?? make the picture bigger. we need to see each
 * sail clearly as well as the traveller and the cars. wind direction is good,
 * but it is hard to see the sails and what have you. just make it best in
 * class???"
 *
 * Four independent designs and three judges went over it. What is pinned here
 * is the consensus, plus the correctness fix that fell out of it.
 *
 * THE COLOUR BUG. The traveller car, the yankee car and the rail block were
 * filled `windOnPort ? PORT : STBD` — by which side the WIND was on — while
 * being positioned at `CX + lee * …`, on the LEEWARD side. On a beam reach the
 * car is drawn to starboard and was painted port red. It agreed with the drawn
 * side only when the traveller happened to go to windward, which is one band
 * in five. Hue is the fastest channel a sailor reads and three hardware marks
 * were pointing the wrong way with it, state-dependently.
 *
 * THE POLED SAIL. The pole was drawn to windward, correctly, and the yankee it
 * holds out was drawn to leeward with everything else — the sail on the
 * opposite side of the boat to the spar carrying it.
 *
 * WHAT WAS REJECTED, because it would draw precision this file does not have:
 * reef-clew fractions, reef pips (she has in-boom furling — there are no
 * discrete reef points), a degree ring on the wind arrow (BOOM_ANGLE is five
 * named bands, not a measurement), and importing POS from sereneSailing.ts
 * (dead code with an inverted sign).
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SailPlanDiagram } from '../components/nmea/gauges/SailPlanDiagram';

const base = { band: 'Beam reach', main: 'Full', yankee: 'Full', stay: true as const };
const PORT = '#ef5350';
const STBD = '#25b167';

const draw = (over = {}) => render(<SailPlanDiagram {...base} windAngle={45} {...over} />).container;
const mark = (c: HTMLElement, name: string) => c.querySelector(`[data-mark="${name}"]`) as SVGElement;
/**
 * The BOAT's centreline, read off the mast — not the frame's centre.
 *
 * These are different numbers now: the hull slides away from whichever side
 * the labels are on, so half the viewBox is the middle of the PICTURE and the
 * mast is the middle of the SHIP. Every "is this mark to port or starboard"
 * question in this file is about the ship.
 */
const cx = (c: HTMLElement) => Number((c.querySelector('[data-mark="mast"]') as SVGElement).getAttribute('cx'));

describe('hue means exactly one thing: which side the wind is on', () => {
    it('never paints hardware port or starboard', () => {
        for (const band of ['Beating', 'Close reach', 'Beam reach', 'Broad reach', 'Running']) {
            for (const windAngle of [45, 315]) {
                const c = draw({ band, windAngle });
                for (const name of ['traveller-car', 'yankee-car', 'rail-block']) {
                    const el = mark(c, name);
                    if (!el) continue;
                    const fill = el.getAttribute('fill');
                    expect(fill, `${name} ${band} @${windAngle}`).not.toBe(PORT);
                    expect(fill, `${name} ${band} @${windAngle}`).not.toBe(STBD);
                }
            }
        }
    });

    it('the beam-reach car is drawn to leeward — the state the old fill got wrong', () => {
        // Wind at 45 is on the starboard bow, so the rig is to PORT and the
        // beam-reach traveller goes to leeward with it. The old code filled
        // this starboard green.
        const c = draw({ band: 'Beam reach', windAngle: 45 });
        const car = mark(c, 'traveller-car');
        expect(Number(car.getAttribute('x'))).toBeLessThan(cx(c));
        expect(car.getAttribute('fill')).not.toBe(STBD);
    });

    it('still uses port and starboard where they belong — the wind arrow', () => {
        expect(draw({ windAngle: 45 }).innerHTML).toContain(STBD);
        expect(draw({ windAngle: 315 }).innerHTML).toContain(PORT);
    });
});

describe('the sail the pole is holding is on the pole side', () => {
    it('puts the yankee to windward when it is poled out', () => {
        const c = draw({ band: 'Running', windAngle: 45 });
        const centre = cx(c);
        const poleX = Number(mark(c, 'pole').getAttribute('x2'));
        const yankee = [...c.querySelectorAll('path')].find((p) => p.getAttribute('d')?.includes(`M ${centre} 62`))!;
        expect(yankee).toBeTruthy();
        // Both on the same side of the centreline.
        const yankeeOut = Number(yankee.getAttribute('d')!.match(/Q ([\d.]+)/)![1]);
        expect(Math.sign(yankeeOut - centre)).toBe(Math.sign(poleX - centre));
    });

    it('keeps it to leeward in every band that is not poled', () => {
        for (const band of ['Beating', 'Close reach', 'Beam reach', 'Broad reach']) {
            const c = draw({ band, windAngle: 45 });
            const centre = cx(c);
            const boomX = Number(mark(c, 'boom').getAttribute('x2'));
            const yankee = [...c.querySelectorAll('path')].find((p) =>
                p.getAttribute('d')?.includes(`M ${centre} 62`),
            )!;
            const yankeeOut = Number(yankee.getAttribute('d')!.match(/Q ([\d.]+)/)![1]);
            expect(Math.sign(yankeeOut - centre), band).toBe(Math.sign(boomX - centre));
        }
    });
});

describe('the marks that answer the question are drawn, not implied', () => {
    it('draws the mainsheet, so the traveller has a stated purpose', () => {
        expect(mark(draw(), 'mainsheet')).not.toBeNull();
    });

    it('draws the yankee sheet to whichever fitting is live', () => {
        for (const band of ['Beating', 'Beam reach', 'Running']) {
            expect(mark(draw({ band }), 'yankee-sheet'), band).not.toBeNull();
        }
    });

    it('ghosts the traveller car on a run instead of claiming a position', () => {
        // The table parks it at centre to mean "not the control that matters
        // here". A filled car at dead centre is still a claim about where a
        // physical thing is.
        const run = mark(draw({ band: 'Running' }), 'traveller-car');
        expect(run.getAttribute('fill')).toBe('none');
        expect(run.getAttribute('stroke-dasharray')).toBeTruthy();
        const reach = mark(draw({ band: 'Beam reach' }), 'traveller-car');
        expect(reach.getAttribute('fill')).not.toBe('none');
    });

    it('keeps the traveller track inside the hull', () => {
        // A track hanging off the topsides is a lie about the boat, and
        // lengthening it to make the car easier to read would buy legibility
        // with accuracy. The car got bigger instead.
        const src = readFileSync('components/nmea/gauges/SailPlanDiagram.tsx', 'utf8');
        expect(src).toMatch(/const TRACK_HALF = 50;/);
        // Half-beam at the widest station in the hull path.
        expect(src).toContain('CX + 58} 236');
    });
});

describe('nothing runs off the frame', () => {
    /**
     * Shane's screenshot, 2026-09-05, showed "STAYSAIL (" and nothing after
     * it. Every label goes to LEEWARD, because that is where the sails are and
     * the windward side carries the wind arrow and the pole — so with the boat
     * centred, the longest label always ran off one edge.
     *
     * His fix, and it is the right one: "can we move it left or right
     * depending on where the words are." The hull slides to windward and the
     * words get the room. Nothing the drawing SAYS changes, because every
     * angle and position is still measured from the boat's own centreline.
     *
     * The catch is that the hull slides INTO the wind arrow, so this checks
     * both edges. jsdom has no text metrics, so widths are estimated at
     * 0.7em per character for 800-weight caps with tracking — deliberately
     * generous, so a pass here means real room.
     */
    const W = 340;
    const estWidth = (text: string, size: number) => text.length * size * 0.7;

    const extents = (c: HTMLElement) => {
        const out: Array<{ text: string; left: number; right: number }> = [];
        for (const t of [...c.querySelectorAll('text')]) {
            const text = t.textContent ?? '';
            if (!text.trim()) continue;
            const x = Number(t.getAttribute('x'));
            const size = Number(t.getAttribute('font-size') ?? 15);
            const w = estWidth(text, size);
            const anchor = t.getAttribute('text-anchor');
            const left = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
            out.push({ text, left, right: left + w });
        }
        return out;
    };

    it('keeps every label inside the viewBox, on both tacks and every band', () => {
        for (const band of ['Beating', 'Close reach', 'Beam reach', 'Broad reach', 'Running']) {
            for (const windAngle of [45, 315]) {
                for (const stay of [true, false, 'storm'] as const) {
                    for (const label of extents(draw({ band, windAngle, stay }))) {
                        expect(label.left, `${label.text} ${band} @${windAngle}`).toBeGreaterThanOrEqual(0);
                        expect(label.right, `${label.text} ${band} @${windAngle}`).toBeLessThanOrEqual(W);
                    }
                }
            }
        }
    });

    it('keeps the wind arrow inside it too — the side the hull slides INTO', () => {
        for (const windAngle of [0, 45, 90, 135, 180, 225, 270, 315]) {
            const c = draw({ windAngle });
            const centre = cx(c);
            // Full extension of the arrow's tail from the mast.
            const reach = 140;
            expect(centre - reach, `@${windAngle}`).toBeGreaterThanOrEqual(0);
            expect(centre + reach, `@${windAngle}`).toBeLessThanOrEqual(W);
        }
    });

    it('keeps the hull and the traveller track inside it', () => {
        for (const windAngle of [45, 315]) {
            const c = draw({ windAngle });
            const centre = cx(c);
            expect(centre - 58).toBeGreaterThanOrEqual(0);
            expect(centre + 58).toBeLessThanOrEqual(W);
        }
    });

    it('sits centred when there is no tack to lean away from', () => {
        expect(cx(draw({ windAngle: null }))).toBe(W / 2);
    });

    it('leans AWAY from the labels, not toward them', () => {
        // Wind on the starboard bow puts the sails and their labels to port,
        // so the hull must move to starboard — right — to make room.
        expect(cx(draw({ windAngle: 45 }))).toBeGreaterThan(W / 2);
        expect(cx(draw({ windAngle: 315 }))).toBeLessThan(W / 2);
    });
});

describe('legibility, in rendered pixels rather than viewBox units', () => {
    const src = readFileSync('components/nmea/gauges/SailPlanDiagram.tsx', 'utf8');
    const glass = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

    it('sizes the viewBox to the real container so 1 unit is 1 pixel', () => {
        expect(src).toMatch(/const W = 340;/);
        expect(glass).toContain('max-w-[420px]');
        expect(glass).not.toContain('max-w-[260px]');
    });

    it('has no label smaller than 14', () => {
        // 10.4px tracked caps is below the floor for a wet screen read at an
        // angle in one second.
        const sizes = [...src.matchAll(/fontSize=\{(\d+)\}/g)].map((m) => Number(m[1]));
        expect(sizes.length).toBeGreaterThan(4);
        for (const size of sizes) expect(size).toBeGreaterThanOrEqual(14);
    });

    it('makes the two warnings that hurt people the loudest, not the quietest', () => {
        // They were 11px bare text — the SMALLEST thing in the drawing, under
        // marks four times their weight. An unexpected boom is the injury this
        // panel exists to prevent.
        const c = draw({ band: 'Running', windAngle: 180, prevent: true, runners: true });
        expect(c.textContent).toContain('PREVENTER ON');
        expect(c.textContent).toContain('RUNNERS ON');
        expect(c.querySelectorAll('rect[fill="rgba(251,191,36,0.14)"]')).toHaveLength(2);
    });

    it('halos every label, because the boom sweeps across all of them', () => {
        // A mark whose position is DATA cannot be solved by moving the text.
        expect(src).toMatch(/paintOrder: 'stroke'/);
    });
});
