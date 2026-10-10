// @vitest-environment node
/**
 * The ledger of blocks gated when the real AU chart fixtures were retired
 * (127-C-a Phase 0, 2026-10-10; see tests/helpers/retiredChartFixtures.ts).
 *
 * A gate is a counted, temporary bridge, never a silent green: this suite
 * scans every test file for a skipIf on REAL_AU_CHART_FIXTURES_RETIRED and
 * requires the list to equal LEDGER exactly, each title to say why it skips,
 * and the ledger never to grow past its Phase 0 size. Phase 1 ports each block
 * to the synthetic harbour kit or a NOAA corridor and takes its line off; a
 * golden that only made sense on Newport's real geometry is retired with a
 * line in the history below, not faked.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRED_CHART_FIXTURES, RETIRED_GATE_SUFFIX } from './helpers/retiredChartFixtures';

const ROOT = join(__dirname, '..');

/** `file › title` for every gated block, as written in the source. */
const LEDGER: readonly string[] = [
    // P1, must (127): the synthetic harbour kit at four origins: leads clipped to their
    // on-water spans, hazards, structures never clear; the canal estate never over land,
    // gates side-correct; an in-test synthetic marina grid.
    'tests/leadCompiler.test.ts › lead compiler — Moreton Bay corridor (four overlapping cells, merged) (real AU chart fixture retired; port: 127-C-a)',
    'tests/leadCompiler.test.ts › lead compiler — Newport cells (OC-61-10ENB5 + OC-61-10RCS5) (real AU chart fixture retired; port: 127-C-a)',
    'tests/leadCompiler.test.ts › lead compiler — fixture totals, pinned (real AU chart fixture retired; port: 127-C-a)',
    'tests/leadCompiler.test.ts › lead compiler — one compile per cell set, measured (real AU chart fixture retired; port: 127-C-a)',
    'tests/leadCompiler.test.ts › on the real Newport cells re-extracted WITH a low bridge across RECTRC 2380, that lead says bridge clearance (real AU chart fixture retired; port: 127-C-a)',
    'tests/leadCompiler.test.ts › on the real blobs nothing is clear, and every lead says why (real AU chart fixture retired; port: 127-C-a)',
    'tests/leadCompiler.test.ts › the real Newport blobs carry none of the structure layers (fixture pin) (real AU chart fixture retired; port: 127-C-a)',
    'tests/leadCompiler.test.ts › the same cells re-extracted with the layers (empty: none charted) can be clear (real AU chart fixture retired; port: 127-C-a)',
    'tests/navLineLeadCategories.test.ts › on the real Newport cells keeps every CATNAV 3 leading line and none of the clearing or transit lines (real AU chart fixture retired; port: 127-C-a)',
    'tests/navLineOsmChartTwins.test.ts › OSM navigation lines that redraw a chart clearing or transit line (real AU chart fixture retired; port: 127-C-a)',
    'tests/navLineOsmChartTwins.test.ts › tracer: a wrong-side cardinal next to the dropped transits stays a DANGER (real AU chart fixture retired; port: 127-C-a)',
    'tests/engine/leadEntryClip.test.ts › routeInshore entry: leads cut to their on-water spans (withNavLineLeadsOnly) (real AU chart fixture retired; port: 127-C-a)',
    'tests/engine/leadEntryClip.test.ts › the Moreton corridor: RECTRC 2655 lies wholly on land paint (real AU chart fixture retired; port: 127-C-a)',
    'tests/engine/leadEntryClip.test.ts › tracer context: tap-snap and ridingLeadAt read on-water spans only (real AU chart fixture retired; port: 127-C-a)',
    'tests/engine/leadLandExtension.test.ts › a leading line over charted land vouches no water (Newport cells) (real AU chart fixture retired; port: 127-C-a)',
    'tests/repro/newportPinkenba.repro.test.ts › Newport → Pinkenba — hug reproduction against real ENC (real AU chart fixture retired; port: 127-C-a)',
    'tests/repro/newportMedialAxis.test.ts › Newport channel — medial axis rides centre where A* hugs (real AU chart fixture retired; port: 127-C-a)',
    'tests/repro/newportGateFollow.test.ts › followChannelGates — Newport exit, two-parallel-channel land-cross (real AU chart fixture retired; port: 127-C-a)',
    'tests/repro/newportMarks.diag.test.ts › Newport marks — fairlead reconstruction diagnostic (real AU chart fixture retired; port: 127-C-a)',
    'tests/inshoreRouter.chartLeads.test.ts › CHARACTERISATION: chart CATNAV 3 leads in the production shape (newport-shane cells) (real AU chart fixture retired; port: 127-C-a)',
    'tests/inshoreRouter.chartLeads.test.ts › GOLDEN: chart leads + OSM overlay (the production shape), strict (real AU chart fixture retired; port: 127-C-a)',
    'tests/waterPack/offlineNewportCanal.test.ts › offline Newport canal with the water pack (owner decision 2) (real AU chart fixture retired; port: 127-C-a)',
    'tests/marinaCenterline.parity.test.ts › marinaCenterline parity — real Newport ENC grid (real AU chart fixture retired; port: 127-C-a)',
    // P2, should (may slide to 128, still counted here): a NOAA corridor and the synthetic
    // harbour; new baselines measured once and committed with _meta.licence.
    'tests/inshoreRouter.golden.test.ts › GOLDEN: Newport → Rivergate (Brisbane River, real AU cells) (real AU chart fixture retired; port: 127-C-a)',
    'tests/inshoreRouter.golden.test.ts › GOLDEN: Newport → Rivergate at the REAL Tayana draft (2.44 m / 8 ft) (real AU chart fixture retired; port: 127-C-a)',
    'tests/inshoreRouter.golden.test.ts › GOLDEN: Newport → Rivergate — survey quality on the route (decision 9) (real AU chart fixture retired; port: 127-C-a)',
    'tests/inshoreRouter.golden.test.ts › GOLDEN: Newport → Tangalooma (leading-line approach) (real AU chart fixture retired; port: 127-C-a)',
    'tests/inshoreRouter.scorecard-baseline.test.ts › scorecard baseline (golden fixtures) (real AU chart fixture retired; port: 127-C-a)',
    'tests/seawayArbitration.corpus.test.ts › seaway arbitration corpus — graph vs Stage II baseline (real AU chart fixture retired; port: 127-C-a)',
    'tests/routing/threeTierNewport.test.ts › four-tier wiring — Newport→Murrarie (Shane real route) (real AU chart fixture retired; port: 127-C-a)',
    'tests/noTideFixtureOffsets.test.ts › decision 11 — Newport → ${name}, destination nudged ${nudge} (real AU chart fixture retired; port: 127-C-a)',
    'tests/tier2/moretonBayFixture.test.ts › Tier-2 real-chart fixture — Moreton Bay open-bay crossing (real AU chart fixture retired; port: 127-C-a)',
    // Retire: Phase 1 deletes these local suites; their questions move to the Pi's in-memory
    // parity harness (vision §5, 128 starter 3).
    'tests/repro/detailedChartOverviewLandRealCells.local.test.ts › decision 1 stays between two detailed charts: the Brisbane River (local only) (real AU chart fixture retired; port: 127-C-a)',
    'tests/repro/newportRivergateRealCells.local.test.ts › Newport → Rivergate on the real cells (app path, local only) (real AU chart fixture retired; port: 127-C-a)',
    'tests/repro/leadShadow.corpus.local.test.ts › lead-graph shadow corpus (local) (real AU chart fixture retired; port: 127-C-a)',
];

/** The ledger's size on 2026-10-10. It can only come down. */
const LEDGER_CEILING = 35;

/** History: blocks retired outright (not ported), with the reason. Empty so far. */

const GATE =
    /\b(?:describe|it|test)\.skipIf\(([^()]*\bREAL_AU_CHART_FIXTURES_RETIRED\b[^()]*)\)\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*)\2/g;

function tracked(...paths: string[]): string[] {
    return execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: ROOT })
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
}

function gates(): { entry: string; title: string }[] {
    const found: { entry: string; title: string }[] = [];
    for (const file of tracked('tests', 'services', 'components', 'hooks', 'utils')) {
        if (!/\.test\.tsx?$/.test(file)) continue;
        let text: string;
        try {
            text = readFileSync(join(ROOT, file), 'utf8');
        } catch {
            continue;
        }
        for (const m of text.matchAll(GATE)) found.push({ entry: `${file} › ${m[3]}`, title: m[3] });
    }
    return found;
}

describe('retired real AU chart fixtures', () => {
    it('none of the retired fixtures is tracked', () => {
        expect(tracked(...RETIRED_CHART_FIXTURES.map((name) => `tests/fixtures/${name}`))).toEqual([]);
    });

    it('every gated block is in the ledger, and every ledger line is a gated block', () => {
        const found = gates();
        console.info(`[retiredChartFixtures] ${found.length} gated blocks (ledger ${LEDGER.length})`);
        expect(found.map((g) => g.entry).sort()).toEqual([...LEDGER].sort());
    });

    it('every gated title says why it skips', () => {
        for (const { entry, title } of gates()) expect(title.endsWith(RETIRED_GATE_SUFFIX), entry).toBe(true);
    });

    it('the ledger only shrinks', () => {
        expect(new Set(LEDGER).size).toBe(LEDGER.length);
        expect(LEDGER.length).toBeLessThanOrEqual(LEDGER_CEILING);
    });
});
