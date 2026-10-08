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
 * Danger symbols declutter at every zoom, and the shallowest survives.
 *
 * Shane 2026-08-07, on the New Caledonia barrier reef: "they are a little hard
 * to follow, unless you zoom right in." OBSTRN/WRECKS/UWTROC carried
 * `icon-allow-overlap: true` unconditionally, on the reasoning that a danger
 * symbol never yields to the collision engine. That is right for a handful of
 * marks and wrong for a reef — the FR466870 cell alone holds 185 UWTROC, and
 * drawn all at once along the barrier they merge into a solid blob that hides
 * the reef being warned about. The safety intent inverts: occlusion conceals.
 *
 * What survives a collision is the SHALLOWEST mark, whatever its class (build
 * 125, 125-04): wrecks, rocks and obstructions draw from one layer with one
 * depth sort key (components/map/encHazardSortKey.ts).
 * tests/enc/encOneHazardLayer.test.ts reads the mounted spec;
 * browser-tests/enc-hazard-labels.spec.ts proves the placement in real engines.
 */
describe('ENC danger-symbol decluttering', () => {
    /** Body of the hazard addLayer block, from its id line to beforeIdFor. */
    const layerBlock = (name: string): string => {
        const start = code.indexOf(`id: ENC_VEC_LAYERS.${name},`);
        expect(start, `${name} layer not found`).toBeGreaterThan(-1);
        const end = code.indexOf('beforeIdFor(', start);
        return code.slice(start, end > 0 ? end : start + 1200);
    };

    it('draws every wreck, rock and obstruction from ONE symbol layer (build 125, 125-04)', () => {
        // A sort key orders one layer only. As three layers, every rock was
        // placed before any wreck and every wreck before any obstruction, so a
        // 15 m rock beat a 0.5 m wreck. One layer is what makes the sort global.
        expect(code.match(/id: ENC_VEC_LAYERS\.HAZARDS,/g) ?? []).toHaveLength(1);
        for (const old of ['OBSTRN', 'WRECKS', 'UWTROC']) {
            expect(code, `${old} still mounts its own layer`).not.toContain(`id: ENC_VEC_LAYERS.${old},`);
        }
    });

    it('declutters the hazard layer instead of drawing every mark on top of the next', () => {
        const block = layerBlock('HAZARDS');
        expect(block, 'HAZARDS still hard-codes allow-overlap').not.toMatch(/'icon-allow-overlap':\s*true/);
        expect(block, 'HAZARDS missing the overlap rule').toContain("'icon-allow-overlap': hazardAllowOverlap");
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

    it('lets the shallowest hazard win a collision, not an arbitrary one, across all three classes', () => {
        // Without a sort key the survivor of a decluttered cluster is whichever
        // the source listed first — so a 30 m wreck could hide a drying rock.
        // ONE key on ONE layer: the depth decides, never the class.
        expect(layerBlock('HAZARDS'), 'HAZARDS has no severity sort key').toContain("'symbol-sort-key': hazardSortKey");
        expect(code.match(/'symbol-sort-key': hazardSortKey/g) ?? []).toHaveLength(1);
        const sort = code.slice(code.indexOf('const hazardSortKey'));
        const body = sort.slice(0, sort.indexOf(';'));
        // The key is computed per mark in the merge (readS57, so a lower-case
        // ogr2ogr cell sorts like an upper-case one) and stamped as _hzSort; a
        // raw ['get', 'VALSOU'] here tied every lower-case mark at 0 and ranked
        // depthless foul ground above a 0.5 m wreck (125-04 review).
        expect(body).toMatch(/'to-number',\s*\['get', ENC_HAZARD_SORT_PROP\],\s*0/);
        expect(body, 'a raw VALSOU read in the layer bypasses the case-defensive key').not.toContain('VALSOU');
        expect(code).toMatch(/\[ENC_HAZARD_SORT_PROP\]:\s*encHazardSortKey\(/);
    });

    it('leaves the navaid layer absolute — it is sparse and already prioritised', () => {
        // Cardinals and isolated-danger marks are few, carry _priority, and
        // are the marks you steer by. They were never the clutter problem.
        const navaid = code.slice(code.indexOf("'symbol-sort-key': ['coalesce', ['get', '_priority']"));
        expect(code).toContain("'symbol-sort-key': ['coalesce', ['get', '_priority'], 99]");
        expect(navaid.slice(-400, navaid.length)).toBeDefined();
    });
});
