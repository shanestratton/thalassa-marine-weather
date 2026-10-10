/**
 * The real AU chart fixtures, retired 2026-10-10 under the o-charts ruling.
 *
 * o-charts, 2026-10-10: "Storing unencrypted data on any medium, and
 * especially in the cloud, is strictly prohibited by the terms of the licenses
 * signed with the chart providers." These seven files were derived extracts of
 * licensed o-charts cells (OC-61, Moreton Bay), so they leave the tree and the
 * public history (127-C-a Phase 0). Tests run on NOAA (public domain) and
 * synthetic charts instead.
 *
 * Every block that read one is gated on REAL_AU_CHART_FIXTURES_RETIRED, its
 * title ends with RETIRED_GATE_SUFFIX, and tests/retiredChartFixtures.ledger
 * counts the gates: a counted, temporary bridge until 127-C-a Phase 1 ports
 * each block to the synthetic harbour kit or a NOAA corridor. The loaders
 * throw for a retired name, so an un-gated use fails loudly instead of passing
 * silently, and nothing reads such a file even if a stray copy lingers on a
 * disk.
 */

/** The retired files, as named under tests/fixtures/. */
export const RETIRED_CHART_FIXTURES: readonly string[] = [
    'newport-enc-cells.json.gz',
    'moreton-bay-tier2.corridor.json.gz',
    'newport-rivergate-marks.corridor.json.gz',
    'newport-shane.corridor.json.gz',
    'newport-rivergate.corridor.json.gz',
    'newport-tangalooma.corridor.json.gz',
    'newport-marina.grid.bin.gz',
];

/** The gate every block that read a retired fixture skips on. */
export const REAL_AU_CHART_FIXTURES_RETIRED = true;

/** Every gated block's title ends with this. */
export const RETIRED_GATE_SUFFIX = '(real AU chart fixture retired; port: 127-C-a)';

/** Throws when `name` (a bare file name or a path ending in one) is retired. */
export function assertNotRetiredChartFixture(name: string): void {
    const base = name.split(/[\\/]/).pop() ?? name;
    if (RETIRED_CHART_FIXTURES.includes(base))
        throw new Error(
            `tests/fixtures/${base} was retired 2026-10-10 under the o-charts ruling: use the synthetic ` +
                'harbour kit (tests/helpers/syntheticHarbour.ts, 127-C-a Phase 1) or a NOAA fixture',
        );
}

/**
 * A value built on first use and kept. Gated suites read their fixtures
 * through one of these, so a skipped block never touches the file: vitest
 * still runs a skipped describe's body to collect its tests.
 */
export function lazy<T>(make: () => T): () => T {
    let made = false;
    let value: T;
    return () => {
        if (!made) {
            value = make();
            made = true;
        }
        return value;
    };
}
