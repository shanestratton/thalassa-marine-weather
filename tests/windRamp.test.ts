/**
 * windRamp — the wind particle colour bands.
 *
 * These pin the arithmetic, not the aesthetics. The renderer picks a colour
 * with leaflet-velocity's `floor(len * v / max)` over RAW m/s, so a band edge
 * is an emergent property of (stop count × maxVelocity), not something stated
 * anywhere. The old ramp is the cautionary tale: its comments claimed
 * "0-10 kts / 35+ kts" while the maths actually produced 13-knot bands running
 * to 78 kt, so ordinary sailing wind drew in one flat colour and nobody
 * noticed for months.
 */
import { describe, expect, it } from 'vitest';
import { contrast, deltaE } from './helpers/colourScience';

import {
    WIND_BANDS,
    WIND_COLORS,
    WIND_GRADIENT,
    WIND_MAX_MS,
    WIND_TOP_KT,
    windColorForKt,
} from '../components/map/windRamp';

/** The band a knot value should land in, straight off the table. */
function expectedHex(kt: number): string {
    return (WIND_BANDS.find((b) => kt < b.toKt) ?? WIND_BANDS[WIND_BANDS.length - 1]).hex;
}

describe('windRamp bucket construction', () => {
    it('emits one bucket per knot up to the ceiling', () => {
        expect(WIND_COLORS).toHaveLength(WIND_TOP_KT);
        expect(WIND_TOP_KT).toBe(60);
    });

    it('draws exactly the 10 declared band colours, no more', () => {
        expect(new Set(WIND_COLORS).size).toBe(WIND_BANDS.length);
        expect(WIND_BANDS).toHaveLength(10);
    });

    it('keys maxVelocity to the ceiling in m/s, not knots', () => {
        // The grid is m/s; passing a knot value here is what made the old ramp
        // span 78 kt.
        expect(WIND_MAX_MS).toBeCloseTo(30.8003, 3);
        expect(WIND_MAX_MS / (1852 / 3600)).toBeCloseTo(59.87, 1);
    });

    it('band table is strictly ascending', () => {
        const tops = WIND_BANDS.map((b) => b.toKt);
        expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    });
});

describe('band edges land on the thresholds a skipper steers by', () => {
    it.each([
        [0, 'Drifter'],
        [4.8, 'Drifter'],
        [5, 'Light air'],
        [12, 'Pleasant'],
        [19.8, 'Working breeze'],
        [20, 'Reef'],
        [24.8, 'Reef'],
        [25, 'Heavy reef'],
        [29.8, 'Heavy reef'],
        [30, 'Near gale'],
        [33.8, 'Near gale'],
        [34, 'Gale (F8)'],
        [39.8, 'Gale (F8)'],
        [40, 'Strong gale'],
        [50, 'Storm force'],
    ])('%f kt reads as %s', (kt, label) => {
        const band = WIND_BANDS.find((b) => b.label === label)!;
        expect(windColorForKt(kt as number)).toBe(band.hex);
    });

    it('the REEF flip at 20 kt is a cool→warm hue change, not a shade', () => {
        expect(windColorForKt(19.8)).toBe('#10a06b'); // green
        expect(windColorForKt(20)).toBe('#ee7a0b'); // orange
    });

    it('the GALE flip lands on the true Beaufort F8 line of 34 kt', () => {
        expect(windColorForKt(33.8)).not.toBe(windColorForKt(34));
        expect(windColorForKt(34)).toBe('#cf35bd');
    });
});

describe('borderline speeds err HOT, never cool', () => {
    // A go/no-go field must never under-report. The sub-unity bias makes each
    // edge fall just below its round knot, so a particle sitting exactly on a
    // threshold takes the more alarming colour.
    it.each(WIND_BANDS.slice(0, -1).map((b) => b.toKt))('the %d kt edge flips at or below the round number', (top) => {
        let flip = top - 0.5;
        const below = expectedHex(top - 0.5);
        while (windColorForKt(flip) === below && flip < top + 0.5) flip += 0.001;
        expect(flip).toBeLessThanOrEqual(top);
        expect(top - flip).toBeLessThan(0.25); // and not so early it misleads
    });
});

describe('out-of-range input cannot crash or wrap', () => {
    it('clamps everything above the ceiling to the top band', () => {
        const top = WIND_BANDS[WIND_BANDS.length - 1].hex;
        for (const kt of [60, 75, 120, 500]) expect(windColorForKt(kt)).toBe(top);
    });

    it('clamps zero, negative and non-finite to the calm band', () => {
        const calm = WIND_BANDS[0].hex;
        for (const kt of [0, -5, NaN, -Infinity]) expect(windColorForKt(kt)).toBe(calm);
    });
});

describe('legend gradient is derived, so it cannot drift from the renderer', () => {
    it('names every band colour, in low→high order', () => {
        for (const b of WIND_BANDS) expect(WIND_GRADIENT).toContain(b.hex);
        const positions = WIND_BANDS.map((b) => WIND_GRADIENT.indexOf(b.hex));
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it('uses hard stops — the renderer buckets, it does not interpolate', () => {
        // Each band appears twice: once opening its span, once closing it.
        for (const b of WIND_BANDS) {
            expect(WIND_GRADIENT.split(b.hex).length - 1).toBe(2);
        }
    });

    it('runs bottom-up so calm sits at the foot of the bar', () => {
        expect(WIND_GRADIENT.startsWith('linear-gradient(to top,')).toBe(true);
        expect(WIND_GRADIENT).toContain(`${WIND_BANDS[0].hex} 0.00%`);
    });
});

describe('the streak palette (white below the reef line)', () => {
    it('is white below 20 kt and the band colours from 20 kt up, bucket for bucket', async () => {
        const { WIND_PARTICLE_COLORS, WIND_PARTICLE_WHITE, WIND_PARTICLE_WHITE_BELOW_KT } =
            await import('../components/map/windRamp');
        expect(WIND_PARTICLE_COLORS).toHaveLength(WIND_COLORS.length);
        WIND_PARTICLE_COLORS.forEach((hex, k) => {
            expect(hex).toBe(k < WIND_PARTICLE_WHITE_BELOW_KT ? WIND_PARTICLE_WHITE : WIND_COLORS[k]);
        });
        // The reef band opens the warm colours.
        expect(WIND_PARTICLE_COLORS[20]).toBe(WIND_BANDS.find((b) => b.toKt === 25)!.hex);
    });

    it('gives the legend the same white span and the warm bands in order', async () => {
        const { WIND_PARTICLE_GRADIENT } = await import('../components/map/windRamp');
        expect(WIND_PARTICLE_GRADIENT.startsWith('linear-gradient(to top, #ffffff 0.00%')).toBe(true);
        const warm = WIND_BANDS.filter((b) => b.toKt > 20);
        const positions = warm.map((b) => WIND_PARTICLE_GRADIENT.indexOf(b.hex));
        expect(positions.every((p) => p > 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        for (const b of WIND_BANDS.filter((x) => x.toKt <= 20)) expect(WIND_PARTICLE_GRADIENT).not.toContain(b.hex);
    });
});

describe('windParticleColorForKt (the close-in streak colour)', () => {
    it('is the streak palette at the renderer bucket edges: white below 20 kt, warning hues from the reef line', async () => {
        const { windParticleColorForKt, WIND_PARTICLE_WHITE } = await import('../components/map/windRamp');
        // Same buckets as the leaflet field's colour: only the sub-20 kt bands turn white.
        const coolHexes = WIND_BANDS.filter((b) => b.toKt <= 20).map((b) => b.hex);
        for (let tenths = 0; tenths <= 650; tenths += 1) {
            const kt = tenths / 10;
            const field = windColorForKt(kt);
            expect(windParticleColorForKt(kt)).toBe(coolHexes.includes(field) ? WIND_PARTICLE_WHITE : field);
        }
        expect(windParticleColorForKt(19.9)).toBe(WIND_PARTICLE_WHITE);
        expect(windParticleColorForKt(22)).toBe('#ee7a0b');
        expect(windParticleColorForKt(Number.NaN)).toBe(WIND_PARTICLE_WHITE);
        expect(windParticleColorForKt(-3)).toBe(WIND_PARTICLE_WHITE);
        expect(windParticleColorForKt(500)).toBe(WIND_BANDS[WIND_BANDS.length - 1].hex);
    });
});

// ── The desk's Light base (127-DESKMAP-b) ────────────────────────────────
// White streaks measured 1.28-2.03:1 on Light and the reef orange 1.39-2.21:1:
// the wind would vanish on the base the desk opens on. The light palette keeps
// the buckets and each band's hue, darkened until it reads on every Light
// water and land colour.
describe('the streak palette for a light base', () => {
    const hue = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
        const max = Math.max(r, g, b);
        const d = max - Math.min(r, g, b);
        if (!d) return 0;
        const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return (h * 60 + 360) % 360;
    };

    it('keeps WIND_COLORS’ bucket edges: one colour per band, changing only at 20, 25, 30, 34, 40 and 48 kt', async () => {
        const { WIND_PARTICLE_COLORS_LIGHT } = await import('../components/map/windRamp');
        expect(WIND_PARTICLE_COLORS_LIGHT).toHaveLength(WIND_COLORS.length);
        const edges = WIND_PARTICLE_COLORS_LIGHT.flatMap((hex, k) =>
            k > 0 && hex !== WIND_PARTICLE_COLORS_LIGHT[k - 1] ? [k] : [],
        );
        expect(edges).toEqual([20, 25, 30, 34, 40, 48]);
    });

    // 4.5:1 as inks so the streaks' cores land 3:1 as drawn (1 px antialiased
    // lines, 0.88 alpha, additive trails; browser-tests/desk-wind-layout.spec.ts
    // measures the pixels).
    it('reads on every Light water and land colour: 4.5:1 for each warm band, 7:1 below the reef line', async () => {
        const { WIND_PARTICLE_COLORS_LIGHT } = await import('../components/map/windRamp');
        const { LIGHT_PALETTE } = await import('../components/map/reliefBase');
        const grounds = [
            ...LIGHT_PALETTE.ramp.map(([, colour]) => colour),
            ...LIGHT_PALETTE.bands,
            LIGHT_PALETTE.land,
            LIGHT_PALETTE.water,
        ].filter((c) => c.startsWith('#'));
        expect(grounds.length).toBeGreaterThan(8);
        WIND_PARTICLE_COLORS_LIGHT.forEach((ink, k) => {
            for (const ground of grounds)
                expect(contrast(ink, ground), `${k} kt ${ink} on ${ground}`).toBeGreaterThanOrEqual(k < 20 ? 7 : 4.5);
        });
    });

    it('keeps each warm band’s own hue family (within 15°)', async () => {
        const { WIND_PARTICLE_COLORS_LIGHT } = await import('../components/map/windRamp');
        for (let k = 20; k < WIND_COLORS.length; k++) {
            const delta = Math.abs(hue(WIND_PARTICLE_COLORS_LIGHT[k]) - hue(WIND_COLORS[k]));
            expect(Math.min(delta, 360 - delta), `${k} kt`).toBeLessThanOrEqual(15);
        }
    });

    // Review 2026-10-10: at one lightness the dark inks ran together (25-30
    // against 30-34 kt nearly one red; 20-25 against 25-30 ΔE 1.4 to a deutan
    // eye). Neighbours, the slate below the reef line included, stay apart for
    // every common colour vision, so a streak's band can be read off the key.
    it('keeps every pair of neighbouring bands apart: ΔE2000 ≥ 10 for normal, deutan and protan vision', async () => {
        const { WIND_PARTICLE_COLORS_LIGHT } = await import('../components/map/windRamp');
        const inks = [...new Set(WIND_PARTICLE_COLORS_LIGHT)];
        expect(inks).toHaveLength(7);
        for (let i = 1; i < inks.length; i++)
            for (const vision of ['normal', 'deutan', 'protan'] as const)
                expect(
                    deltaE(inks[i - 1], inks[i], vision),
                    `${inks[i - 1]} | ${inks[i]} (${vision})`,
                ).toBeGreaterThanOrEqual(10);
    });

    it('windParticleColorForKt(kt, "light") is that palette at the renderer’s bucket edges; "dark" is today’s', async () => {
        const { windParticleColorForKt, WIND_PARTICLE_COLORS, WIND_PARTICLE_COLORS_LIGHT } =
            await import('../components/map/windRamp');
        // The renderer's own bucket: floor(len * v / max) over m/s, clamped.
        const bucket = (kt: number) =>
            Math.min(
                WIND_COLORS.length - 1,
                Math.max(0, Math.floor((WIND_COLORS.length * kt * (1852 / 3600)) / WIND_MAX_MS)),
            );
        for (let tenths = 1; tenths <= 650; tenths += 1) {
            const kt = tenths / 10;
            expect(windParticleColorForKt(kt, 'dark')).toBe(windParticleColorForKt(kt));
            expect(windParticleColorForKt(kt)).toBe(WIND_PARTICLE_COLORS[bucket(kt)]);
            expect(windParticleColorForKt(kt, 'light'), `${kt} kt`).toBe(WIND_PARTICLE_COLORS_LIGHT[bucket(kt)]);
        }
        expect(windParticleColorForKt(19.9, 'light')).toBe(WIND_PARTICLE_COLORS_LIGHT[0]);
        expect(windParticleColorForKt(20, 'light')).toBe(WIND_PARTICLE_COLORS_LIGHT[20]);
        expect(windParticleColorForKt(Number.NaN, 'light')).toBe(WIND_PARTICLE_COLORS_LIGHT[0]);
        expect(windParticleColorForKt(500, 'light')).toBe(WIND_PARTICLE_COLORS_LIGHT[WIND_COLORS.length - 1]);
    });

    it('gives the legend a derived light twin: hard stops, bottom-up, the light inks in band order', async () => {
        const { WIND_PARTICLE_GRADIENT_LIGHT, WIND_PARTICLE_COLORS_LIGHT, WIND_PARTICLE_GRADIENT } =
            await import('../components/map/windRamp');
        expect(
            WIND_PARTICLE_GRADIENT_LIGHT.startsWith(`linear-gradient(to top, ${WIND_PARTICLE_COLORS_LIGHT[0]} 0.00%`),
        ).toBe(true);
        const inks = [...new Set(WIND_PARTICLE_COLORS_LIGHT)];
        const positions = inks.map((hex) => WIND_PARTICLE_GRADIENT_LIGHT.indexOf(hex));
        expect(positions.every((p) => p >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        // Hard stops: every warm band opens and closes its own span.
        for (const hex of inks.slice(1)) expect(WIND_PARTICLE_GRADIENT_LIGHT.split(hex).length - 1).toBe(2);
        // The dark twin is untouched.
        expect(WIND_PARTICLE_GRADIENT.startsWith('linear-gradient(to top, #ffffff 0.00%')).toBe(true);
    });
});
