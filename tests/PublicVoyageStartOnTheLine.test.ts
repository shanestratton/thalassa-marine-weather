/**
 * The planned line owns where a voyage starts.
 *
 * "Voyage Start" is a SHIP-LOG waypoint dropped where tracking was switched
 * on — the mooring, usually. On a passage that has not sailed yet that is
 * nowhere near where the boat will depart from, and drawn beside a planned
 * route it makes two claims about the same thing a few hundred metres apart.
 *
 * Shane, 2026-09-05, on the public Voyage Explorer: "we have a voyage start
 * button at our current location. however, that is not where the voyage will
 * start from. the voyage should always be the line claude. the source of
 * truth."
 *
 * So when a plan line exists it owns the start, and the log marker stands
 * down. With no plan line the log marker is the only start there is and it
 * stays. "Voyage End" is untouched: where a passage actually finished is a
 * fact about the voyage, not a competing claim about the plan.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('src/components/MapContainer.tsx', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('public voyage explorer — the start belongs to the line', () => {
    it('drops the ship-log Voyage Start marker only when a plan line exists', () => {
        expect(code).toMatch(/const hasPlanLine = !!passageLine && passageLine\.length >= 2;/);
        expect(code).toMatch(/hasPlanLine \? waypoints\.filter\(\(w\) => w\.name !== 'Voyage Start'\) : waypoints/);
    });

    it('renders the filtered list, not the raw one', () => {
        expect(code).toContain('{shownWaypoints.map((w, i) => (');
        expect(code).not.toContain('{waypoints.map((w, i) => (');
    });

    it('keeps Voyage End — it is a fact, not a competing claim', () => {
        expect(code).not.toContain("'Voyage End'");
    });

    it("labels the plan's own origin instead", () => {
        expect(code).toMatch(/passageLine\[0\]\[0\].*passageLine\[0\]\[1\]/s);
        expect(src).toMatch(/hasPlanLine && passageLine && \(/);
        expect(src).toContain('Voyage Start');
    });

    it('still marks that origin green, so the label sits on the dot it names', () => {
        // role 'start' → #34d399 in the passage-waypoint-dots layer.
        expect(code).toMatch(/role: i === 0 \? 'start'/);
        expect(code).toContain("'#34d399'");
    });
});
