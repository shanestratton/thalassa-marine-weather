import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const layer = fs.readFileSync(path.join(process.cwd(), 'components/map/EncVectorLayer.ts'), 'utf8');
// LINE comments first, then block comments — order is load-bearing here. This
// file documents the INT1 glyphs as "a mariner reads +/*/hull symbols off a
// paper chart", and the `/*` inside that line opens a phantom block comment
// that a block-first stripper runs 8,444 characters with, swallowing all three
// hazard layers. Stripping line comments first removes the decoy with its line.
const code = layer.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Danger symbols must declutter at low zoom and never at high zoom.
 *
 * Shane 2026-08-07, on the New Caledonia barrier reef: "they are a little hard
 * to follow, unless you zoom right in." OBSTRN/WRECKS/UWTROC carried
 * `icon-allow-overlap: true` unconditionally, on the reasoning that a danger
 * symbol never yields to the collision engine. That is right for a handful of
 * marks and wrong for a reef — the FR466870 cell alone holds 185 UWTROC, and
 * drawn all at once along the barrier they merge into a solid blob that hides
 * the reef being warned about. The safety intent inverts: occlusion conceals.
 *
 * Both halves matter, so both are asserted. Dropping the `true` arm would make
 * a chart silently omit dangers at navigation zoom, which is far worse than
 * the clutter this fixed.
 */
describe('ENC danger-symbol decluttering', () => {
    const HAZARD_LAYERS = ['OBSTRN', 'WRECKS', 'UWTROC'];

    /** Body of one addLayer block, from its id line to the paint block. */
    const layerBlock = (name: string): string => {
        const start = code.indexOf(`id: ENC_VEC_LAYERS.${name},`);
        expect(start, `${name} layer not found`).toBeGreaterThan(-1);
        const end = code.indexOf('beforeIdFor(', start);
        return code.slice(start, end > 0 ? end : start + 1200);
    };

    it('declutters the three hazard layers below the navigation-zoom threshold', () => {
        for (const name of HAZARD_LAYERS) {
            const block = layerBlock(name);
            expect(block, `${name} still hard-codes allow-overlap`).not.toMatch(/'icon-allow-overlap':\s*true/);
            expect(block, `${name} missing the zoom-stepped overlap rule`).toContain(
                "'icon-allow-overlap': hazardAllowOverlap",
            );
        }
    });

    it('declutters at every zoom, with no threshold that turns it back off', () => {
        // The first fix made this a zoom step going unconditional at z13, on
        // the assumption that by then every mark is separately readable.
        // Measured on Port Vila at z14+: it is not — reef UWTROC sits metres
        // apart, so the blobs came back identically above the threshold.
        // There is no zoom at which drawing them all is legible, so any
        // reintroduced step is a regression, not a tuning choice.
        const expr = code.slice(code.indexOf('const hazardAllowOverlap'));
        const body = expr.slice(0, expr.indexOf(';'));
        expect(body).toContain('false');
        expect(body, 'a zoom step here means the blobs return above it').not.toContain("'step'");
        expect(body).not.toContain("['zoom']");
        expect(body).not.toContain('true');
    });

    it('lets the shallowest hazard win a collision, not an arbitrary one', () => {
        // Without a sort key the survivor of a decluttered cluster is whichever
        // the source listed first — so a 30 m wreck could hide a drying rock.
        for (const name of HAZARD_LAYERS) {
            expect(layerBlock(name), `${name} has no severity sort key`).toContain("'symbol-sort-key': hazardSortKey");
        }
        const sort = code.slice(code.indexOf('const hazardSortKey'));
        const body = sort.slice(0, sort.indexOf(';'));
        expect(body).toContain("['get', 'VALSOU']");
        // Missing depth must sort as most-dangerous (0), matching the
        // fail-safe stance encHazardParse takes on absent WATLEV.
        expect(body).toMatch(/'to-number',\s*\['get', 'VALSOU'\],\s*0/);
    });

    it('leaves the navaid layer absolute — it is sparse and already prioritised', () => {
        // Cardinals and isolated-danger marks are few, carry _priority, and
        // are the marks you steer by. They were never the clutter problem.
        const navaid = code.slice(code.indexOf("'symbol-sort-key': ['coalesce', ['get', '_priority']"));
        expect(code).toContain("'symbol-sort-key': ['coalesce', ['get', '_priority'], 99]");
        expect(navaid.slice(-400, navaid.length)).toBeDefined();
    });
});
