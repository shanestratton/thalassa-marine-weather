// @vitest-environment node
/**
 * No protected chart data in git (127-C-a: the path, content and id rules
 * from Phase 0; the provenance manifest and the real-cell rule from Phase 1).
 *
 * o-charts, 2026-10-10: "Storing unencrypted data on any medium, and
 * especially in the cloud, is strictly prohibited by the terms of the licenses
 * signed with the chart providers." This repo is public, so a decrypted cell,
 * a corridor captured from the Pi's store or a grid baked from one must never
 * be committed again. Tests run on NOAA (public domain, producer "US") and
 * synthetic charts. Catalogue metadata (cell ids with no geometry) and ids in
 * comments pass.
 *
 * The id rule is precise on purpose: an `OC-<n>-<id>` cell id is protected
 * data only as a quoted value beside geometry. Files that hold one today are
 * listed in ID_RULE_LEDGER with what they are; the list can only shrink.
 *
 * Data files are held to an allowlist, not a blocklist: a real extract need
 * carry no producer code, id or source note at all (the retired Tangalooma
 * corridor carried none), so any tracked data file with S-57 layers and
 * coordinates must declare `_meta.licence` 'public-domain' (NOAA, what the
 * capture tool stamps) or 'synthetic', and name only US*, ZZ* or OC-99-*
 * cells. A binary grid has no text to read: the path rule refuses every
 * *.bin under tests/, and the provenance manifest catches a renamed one.
 *
 * The manifest (tests/fixtures/PROVENANCE.json) names every data file under
 * tests/fixtures/ and e2e/fixtures/ (anything that is not test code or a
 * harness page) with where it came from and an open licence: public-domain,
 * cc0, cc-by-4.0, odbl, synthetic, own, wmo-res40 (a partner's observations
 * on the WMO exchange, owner credited), or third-party-replace (named, with
 * the package that replaces it). There is no value for protected data, so a
 * file that is not open cannot be listed, and a file that is not listed fails.
 * Fixture data may not name a proprietary chart as the source of a value.
 *
 * The real-cell rule: nothing in the tree may read the real-cells directory
 * variables the retired local suites took, and no test, tool or script may
 * fetch the Pi's installed cells and write a disk (the old diag cache kept
 * every cell as a file between runs), because decrypted cells on a Mac's disk
 * are a medium the ruling forbids. A diag holds fetched cells in memory;
 * real-chart parity checks run on the Pi, in memory (vision §5). The corridor
 * capture tool is the one writer, and it refuses every id that is not NOAA's.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RETIRED_CHART_FIXTURES } from './helpers/retiredChartFixtures';

const ROOT = join(__dirname, '..');

/** Where chart data could hide: every tracked file but docs/ prose and the iOS project. */
const SKIP_DIRS = /^(docs|ios)\//;
const TEXT_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|geojson|csv|xml|txt|html|sql|py|sh|toml|ya?ml)$/i;
const GZ_FILE = /\.gz$/i;

// ── The rules (pure, so each can be shown failing on in-memory data) ────

/** Chart files by extension: o-charts eSENC/oeSENC, S-63, SENC, S-57 base and update cells. */
const CHART_FILE = /\.(oesu|oesenc|es57|os63|senc)$|\.\d{3}$/i;
/** A routing grid baked from chart cells: *.grid.bin anywhere, and any *.bin under tests/. */
const GRID_BIN = /\.grid\.bin(\.|$)/i;
const TEST_BIN = /^tests\/.*\.bin(\.gz)?$/i;

function pathProblems(path: string): string[] {
    const problems: string[] = [];
    const base = path.split('/').pop() ?? path;
    if (path.startsWith('tests/fixtures/') && RETIRED_CHART_FIXTURES.includes(base))
        problems.push(`${path}: a retired real AU chart fixture`);
    if (CHART_FILE.test(base)) problems.push(`${path}: a chart cell file`);
    if (GRID_BIN.test(base) || TEST_BIN.test(path)) problems.push(`${path}: a chart-derived grid (*.bin)`);
    return problems;
}

const SOURCE_HO = /["']?\b_?sourceHO["']?\s*:\s*["'`]([^"'`]{0,8})["'`]/g;
const S57_LAYER =
    /["']?\b(LNDARE|DEPARE|DRGARE|COALNE|SLCONS|BOYLAT|BCNLAT|BOYCAR|BCNCAR|NAVLNE|RECTRC|FAIRWY|SOUNDG|OBSTRN|WRECKS|UWTROC|M_QUAL|LIGHTS)\b["']?\s*:/;
const COORDINATES = /["']?\bcoordinates["']?\s*:\s*\[/;
/** A quoted o-charts cell id. `OC-99-` is the fictional namespace tests use, so it never hits. */
const OC_ID = /(["'`])(OC-(?!99-)\d{1,3}-[A-Z0-9]{3,})/g;
const PAIR_ARRAY = /\[\s*-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\s*[\],]/g;
/** A coordinate pair at survey precision (six or more decimals): what an extract holds, not a hand-drawn test shape. */
const PRECISE_PAIR = /\[\s*-?\d{1,3}\.\d{6,}\s*,\s*-?\d{1,3}\.\d{6,}\s*[\],]/g;
/** Data files, where a capture lands; code is held to the precise-pair test instead. */
const DATA_FILE = /\.(json|geojson|csv|xml|txt)(\.gz)?$|\.gz$/i;
const PAIR_OBJECT = /\{\s*(?:lat|lon|lng)\s*:\s*-?\d{1,3}\.\d{4,}\s*,\s*(?:lat|lon|lng)\s*:\s*-?\d{1,3}\.\d{4,}/g;
const META = /["']?\b_meta["']?\s*:\s*\{/g;
const META_SOURCE = /["']?\bsource["']?\s*:\s*["'`]([^"'`]*)["'`]/;
const PROTECTED_SOURCE = /o-?charts|oe-?senc|pi-cache live capture/i;
const META_LICENCE = /["']?\blicen[cs]e["']?\s*:\s*["'`]([^"'`]*)["'`]/;
/** The only licences a tracked chart extract may carry. */
const OPEN_LICENCE = /^(public-domain|synthetic)$/;
/** A cell id field: `cellId`, `_cellId`, `sourceCellId`. */
const CELL_ID_FIELD = /["']?\b(?:_?cellId|sourceCellId)["']?\s*:\s*["'`]([^"'`]{1,40})["'`]/g;
/** NOAA, the fictional ZZ producer and the fictional OC-99 namespace. */
const OPEN_CELL_ID = /^(US|ZZ|OC-99-)/;
/** How far either side of an id geometry counts as beside it, in characters. */
const NEAR = 1500;

/** True when the match at `index` sits in a comment (a line, block or doc comment). */
function inComment(text: string, index: number): boolean {
    const start = text.lastIndexOf('\n', index - 1) + 1;
    const before = text.slice(start, index);
    if (/^\s*(\*|\/\*|\/\/|#|--)/.test(before)) return true;
    return /(^|[\s;,)])\/\/|\/\*(?!.*\*\/)/.test(before);
}

function count(re: RegExp, text: string): number {
    return [...text.matchAll(re)].length;
}

/** Hits of the id rule: quoted OC- ids with geometry beside them, as `file:line id`. */
function idRuleHits(file: string, text: string): string[] {
    const hits: string[] = [];
    for (const m of text.matchAll(OC_ID)) {
        const at = m.index ?? 0;
        if (inComment(text, at)) continue;
        const near = text.slice(Math.max(0, at - NEAR), at + NEAR);
        const geometry = COORDINATES.test(near) || count(PAIR_ARRAY, near) >= 3 || count(PAIR_OBJECT, near) >= 3;
        if (geometry) hits.push(`${file}:${text.slice(0, at).split('\n').length} ${m[2]}`);
    }
    return [...new Set(hits)];
}

/** Content problems other than the id rule (which is ledgered). */
function contentProblems(file: string, text: string): string[] {
    const problems: string[] = [];
    const producers = [...text.matchAll(SOURCE_HO)].map((m) => m[1]).filter((ho) => ho !== 'US');
    // In a data file any S-57 layer or coordinates beside a non-US producer
    // is a capture. Test code builds fictional cells with a producer code and
    // a hand-drawn box, so code fails only when it holds an extract's worth
    // of survey-precision coordinates.
    const features = DATA_FILE.test(file)
        ? S57_LAYER.test(text) || COORDINATES.test(text)
        : count(PRECISE_PAIR, text) >= 20;
    if (producers.length > 0 && features)
        problems.push(`${file}: S-57 feature data from a non-US producer (sourceHO ${[...new Set(producers)]})`);
    for (const m of text.matchAll(META)) {
        const source = META_SOURCE.exec(text.slice(m.index ?? 0, (m.index ?? 0) + 3000));
        if (source && PROTECTED_SOURCE.test(source[1]))
            problems.push(`${file}: _meta.source names protected chart data ("${source[1]}")`);
    }
    return problems;
}

/** The data-file allowlist: S-57 layers with coordinates must say they are public domain or synthetic. */
function dataFileProblems(file: string, text: string): string[] {
    if (!DATA_FILE.test(file) || !S57_LAYER.test(text) || !COORDINATES.test(text)) return [];
    const problems: string[] = [];
    const licences = [...text.matchAll(META)].map(
        (m) => META_LICENCE.exec(text.slice(m.index ?? 0, (m.index ?? 0) + 3000))?.[1] ?? '',
    );
    if (!licences.some((l) => OPEN_LICENCE.test(l)))
        problems.push(`${file}: S-57 features with coordinates and no _meta.licence 'public-domain' or 'synthetic'`);
    const closed = [
        ...[...text.matchAll(CELL_ID_FIELD)].map((m) => m[1]).filter((id) => !OPEN_CELL_ID.test(id)),
        ...[...text.matchAll(OC_ID)].map((m) => m[2]),
    ];
    if (closed.length > 0)
        problems.push(
            `${file}: S-57 features from cells other than US*, ZZ* or OC-99-* (${[...new Set(closed)].slice(0, 5)})`,
        );
    return problems;
}

/** The provenance manifest, itself exempt from listing. */
const MANIFEST = 'tests/fixtures/PROVENANCE.json';
const FIXTURE_DIR = /^(tests|e2e)\/fixtures\//;
/** Test code and harness pages that live beside the fixtures. Everything else there is data. */
const FIXTURE_CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|html)$/i;
/** The licences a fixture may carry. There is deliberately no value for protected data. */
const FIXTURE_LICENCES: readonly string[] = [
    'public-domain',
    'cc0',
    'cc-by-4.0',
    'odbl',
    'synthetic',
    'own',
    'wmo-res40',
    'third-party-replace',
];
/** Licences whose holder must be credited by name. */
const CREDITED_LICENCES: readonly string[] = ['cc-by-4.0', 'odbl', 'wmo-res40'];

/** True for a tracked data file the manifest must name. */
function isFixtureData(path: string): boolean {
    return FIXTURE_DIR.test(path) && !FIXTURE_CODE.test(path) && path !== MANIFEST;
}

/** A proprietary chart: a value copied from one is not open, whatever licence the file declares. */
const PROPRIETARY_CHART = /\b(?:navionics|c-map|bluechart|chartworld|o-?charts|oe-?senc)\b/i;

/** Fixture data that names a proprietary chart (the old marker file's "retagged ... per Navionics" fix). */
function fixtureSourceProblems(file: string, text: string): string[] {
    return isFixtureData(file) && PROPRIETARY_CHART.test(text)
        ? [`${file}: names a proprietary chart as the source of a value`]
        : [];
}

/** Every data file listed with an open licence and its source; no entry for a file that is not there. */
function manifestProblems(trackedFiles: readonly string[], manifest: unknown): string[] {
    const files = (manifest as { files?: unknown } | null)?.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) return [`${MANIFEST}: no "files" object`];
    const entries = files as Record<string, unknown>;
    const data = trackedFiles.filter(isFixtureData);
    const problems = data.filter((file) => !(file in entries)).map((file) => `${file}: not in ${MANIFEST}`);
    for (const [file, raw] of Object.entries(entries)) {
        if (!data.includes(file)) {
            problems.push(`${MANIFEST}: ${file} is not a tracked fixture data file`);
            continue;
        }
        const entry = (raw ?? {}) as { licence?: unknown; source?: unknown; credit?: unknown; replacement?: unknown };
        const licence = typeof entry.licence === 'string' ? entry.licence : '';
        if (!FIXTURE_LICENCES.includes(licence)) problems.push(`${file}: licence "${licence}" is not an open licence`);
        if (typeof entry.source !== 'string' || entry.source.trim().length < 8)
            problems.push(`${file}: no source named`);
        const credit = typeof entry.credit === 'string' ? entry.credit : '';
        if (CREDITED_LICENCES.includes(licence) && !credit) problems.push(`${file}: ${licence} needs a credit`);
        if (licence === 'odbl' && !/OpenStreetMap contributors/.test(credit))
            problems.push(`${file}: odbl credit must name OpenStreetMap contributors`);
        if (licence === 'third-party-replace' && (typeof entry.replacement !== 'string' || !entry.replacement.trim()))
            problems.push(`${file}: third-party-replace needs the package that replaces it`);
    }
    return problems;
}

/** The real-cells directory variables the retired local suites read (built, so this file never names them). */
const REAL_CELLS_ENV = new RegExp(`\\b${['THALASSA', 'REAL', '(?:CELLS|BNE)', 'DIR'].join('_')}\\b`);
/** The Pi route that serves an installed cell's decrypted data (built, so this file never names it). */
const PI_CELL_ROUTE = new RegExp(['', 'api', 'enc', 'installed'].join('\\/') + '\\b');
/** A write to the local disk. */
const DISK_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|createWriteStream)\s*\(/;
/** Test and tool code, which runs on a Mac. The Pi's own server keeps its store on the boat. */
const MAC_CODE = /^(tests|e2e|tools|scripts)\//;
/** The corridor capture tool refuses every id that is not a NOAA one (its own test, below). */
const CELL_WRITE_ALLOWED: readonly string[] = ['tools/capture-corridor-fixture.mjs'];

function realCellProblems(file: string, text: string): string[] {
    const problems: string[] = [];
    if (REAL_CELLS_ENV.test(text)) problems.push(`${file}: reads decrypted chart cells from a disk`);
    if (MAC_CODE.test(file) && !CELL_WRITE_ALLOWED.includes(file) && PI_CELL_ROUTE.test(text) && DISK_WRITE.test(text))
        problems.push(`${file}: fetches the Pi's installed cells and writes to a disk`);
    return problems;
}

// ── The tree ─────────────────────────────────────────────────────────────

function tracked(...paths: string[]): string[] {
    return execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
}

function readText(path: string): string | null {
    let bytes: Buffer;
    try {
        bytes = readFileSync(join(ROOT, path));
    } catch {
        return null; // tracked but deleted in the working tree
    }
    if (GZ_FILE.test(path)) {
        try {
            return gunzipSync(bytes).toString('utf8');
        } catch {
            return null;
        }
    }
    return bytes.toString('utf8');
}

/**
 * Files the id rule hits today, and what each is. `port`: real positions a
 * Phase 1 port removes; `fictional`: invented positions whose id becomes an
 * `OC-99-ZZ…` one; `comment`: prose the rule cannot tell from a comment.
 * Take a file off when it stops hitting (an entry with no hit fails).
 */
const ID_RULE_LEDGER: Readonly<Record<string, 'port' | 'fictional' | 'comment'>> = {
    // Real cell ids beside invented boxes and points.
    'tests/catzocBackfill.test.ts': 'fictional',
    'tests/enc/cellFinenessRank.test.ts': 'fictional',
    'tests/enc/scaleShadow.test.ts': 'fictional',
    'tests/routeTracer.test.ts': 'fictional',
    'tools/senc-extractor/src/chartContent.test.mts': 'fictional',
    // Gated blocks that read the retired Newport cells (ported in Phase 1).
    'tests/navLineLeadCategories.test.ts': 'port',
    'tests/navLineOsmChartTwins.test.ts': 'port',
};

describe('no protected chart data in git', () => {
    const scanned = tracked('.').filter((p) => !SKIP_DIRS.test(p) && (TEXT_FILE.test(p) || GZ_FILE.test(p)));
    const texts = scanned
        .map((file) => ({ file, text: readText(file) }))
        .filter((f): f is { file: string; text: string } => f.text !== null);

    it('scans the tree it means to', () => {
        expect(texts.length).toBeGreaterThan(1000);
        for (const dir of [
            'tests/',
            'services/',
            'pi-cache/',
            'tools/',
            'supabase/',
            'public/',
            'utils/',
            'components/',
        ])
            expect(
                texts.some((t) => t.file.startsWith(dir)),
                dir,
            ).toBe(true);
    });

    it('path rule: no retired fixture, chart cell file or baked grid is tracked', () => {
        expect(tracked('.').flatMap(pathProblems)).toEqual([]);
    });

    it('content rule: no non-US S-57 features, and no _meta naming o-charts, oeSENC or a Pi capture', () => {
        expect(texts.flatMap(({ file, text }) => contentProblems(file, text))).toEqual([]);
    });

    it('data-file allowlist: every S-57 extract is public domain or synthetic, from US/ZZ/OC-99 cells', () => {
        expect(texts.flatMap(({ file, text }) => dataFileProblems(file, text))).toEqual([]);
    });

    it('manifest rule: every data file under tests/fixtures and e2e/fixtures has an open licence and a source', () => {
        const all = tracked('tests/fixtures', 'e2e/fixtures');
        expect(all.filter(isFixtureData).length, 'the fixture dirs hold data').toBeGreaterThan(5);
        const manifest = readText(MANIFEST);
        expect(manifest, `${MANIFEST} is tracked`).not.toBeNull();
        expect(manifestProblems(all, JSON.parse(manifest ?? 'null'))).toEqual([]);
        expect(texts.flatMap(({ file, text }) => fixtureSourceProblems(file, text))).toEqual([]);
    });

    it('real-cell rule: nothing reads decrypted chart cells from a disk or writes them to one', () => {
        expect(texts.flatMap(({ file, text }) => realCellProblems(file, text))).toEqual([]);
    });

    it('id rule: every quoted OC- id beside geometry is in the ledger, and the ledger only shrinks', () => {
        const hits = texts.flatMap(({ file, text }) => idRuleHits(file, text));
        const files = [...new Set(hits.map((h) => h.slice(0, h.indexOf(':'))))].sort();
        console.info(
            `[noProtectedChartData] id rule: ${hits.length} hits in ${files.length} ledgered files` +
                (hits.length ? `\n  ${hits.join('\n  ')}` : ''),
        );
        expect(files).toEqual(Object.keys(ID_RULE_LEDGER).sort());
        // Phase 0 size: the ledger can only shrink.
        expect(Object.keys(ID_RULE_LEDGER).length).toBeLessThanOrEqual(7);
    });
});

describe('the corridor capture tool writes NOAA cells only', () => {
    it('refuses every cell id that is not a NOAA one, and stamps the licence', () => {
        const source = readFileSync(join(ROOT, 'tools/capture-corridor-fixture.mjs'), 'utf8');
        const rule = /const NOAA_CELL_ID = \/(.+)\/;/.exec(source);
        expect(rule, 'NOAA_CELL_ID in tools/capture-corridor-fixture.mjs').not.toBeNull();
        const noaa = new RegExp(rule![1]);
        for (const id of ['US5MD1AM', 'US4VA70M', 'US1GC09M']) expect(noaa.test(id), id).toBe(true);
        for (const id of [['OC', '61', '10ZZ5'].join('-'), 'AU5ZZ001', 'FR501010', 'ZZ5SYN01', 'US5', 'us5md1am'])
            expect(noaa.test(id), id).toBe(false);
        expect(source).toContain("licence: 'public-domain'");
        expect(source).not.toMatch(/startsWith\('OC-'\)/);
    });
});

describe('the guard itself (fictional data, built in memory)', () => {
    const square = [
        [
            [10.0001, 20.0001],
            [10.0002, 20.0001],
            [10.0002, 20.0002],
            [10.0001, 20.0001],
        ],
    ];
    const cell = (sourceHO: string, cellId: string) =>
        JSON.stringify({
            _meta: { cells: [cellId] },
            cells: {
                LNDARE: {
                    type: 'FeatureCollection',
                    features: [
                        {
                            type: 'Feature',
                            properties: { acronym: 'LNDARE', _cellId: cellId, sourceHO },
                            geometry: { type: 'Polygon', coordinates: square },
                        },
                    ],
                },
            },
        });

    it('path rule: the retired fixtures, chart cell files and any *.grid.bin fail; NOAA and synthetic pass', () => {
        expect(pathProblems('tests/fixtures/newport-shane.corridor.json.gz')).toHaveLength(1);
        expect(pathProblems('tests/fixtures/harbour.grid.bin')).toHaveLength(1);
        expect(pathProblems('tests/fixtures/harbour.grid.bin.gz')).toHaveLength(1);
        expect(pathProblems('tests/fixtures/marina-grid.bin.gz')).toHaveLength(1);
        expect(pathProblems('tests/engine/harbour.bin')).toHaveLength(1);
        for (const p of ['x/OC-99-ZZTEST.oesu', 'x/ZZ5TEST.000', 'x/ZZ5TEST.003', 'x/cell.os63', 'x/cell.senc'])
            expect(pathProblems(p), p).toHaveLength(1);
        for (const p of [
            'tests/fixtures/noaa-US5ZZ01M.corridor.json.gz',
            'tests/fixtures/synthetic-harbour.json',
            'tests/fixtures/newport-canal-osm.json.gz',
            'tests/fixtures/trim-h264.mp4',
        ])
            expect(pathProblems(p), p).toEqual([]);
    });

    it('content rule: S-57 features from a non-US producer fail; NOAA (US) passes', () => {
        expect(contentProblems('x.json', cell('AU', 'OC-99-ZZTEST'))).toHaveLength(1);
        expect(contentProblems('x.json', cell('FR', 'ZZ5TEST'))).toHaveLength(1);
        expect(contentProblems('x.json', cell('US', 'US5ZZ01M'))).toEqual([]);
        // Test code: a fictional producer with a hand-drawn box passes; an
        // extract's worth of survey-precision coordinates does not.
        expect(contentProblems('x.ts', `const c = { sourceHO: 'ZZ', bbox: [10.5, 20.5, 10.6, 20.6] };`)).toEqual([]);
        const extract = Array.from({ length: 20 }, (_, k) => `[10.${String(100000 + k)}1, 20.1234567]`).join(', ');
        expect(contentProblems('x.ts', `const c = { sourceHO: 'ZZ', ring: [${extract}] };`)).toHaveLength(1);
        // A producer code with no features or coordinates is catalogue metadata.
        expect(contentProblems('x.ts', `const producers = [{ sourceHO: 'AU', name: 'Fictional' }];`)).toEqual([]);
    });

    it('content rule: a stamped _sourceHO counts as a producer', () => {
        const stamped = cell('US', 'US5ZZ01M').replace('"sourceHO":"US"', '"_sourceHO":"AU"');
        expect(contentProblems('x.json', stamped)).toHaveLength(1);
    });

    it('data-file allowlist: an unlabelled extract fails wherever it lands; public-domain NOAA and synthetic pass', () => {
        // The retired Tangalooma corridor's shape: layers and coordinates, no
        // _meta, no ids, no producer code. Every blocklist rule passes it.
        const bare = JSON.stringify({
            layers: {
                LNDARE: {
                    type: 'FeatureCollection',
                    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: square } }],
                },
            },
        });
        for (const file of ['tests/fixtures/harbour-legacy.corridor.json.gz', 'utils/__fixtures__/harbour.json']) {
            expect(pathProblems(file), file).toEqual([]);
            expect(contentProblems(file, bare), file).toEqual([]);
            expect(dataFileProblems(file, bare), file).toHaveLength(1);
        }
        // A fictional OC-99 corridor with no licence still fails: the licence is what passes a file.
        expect(dataFileProblems('x.json', cell('ZZ', 'OC-99-ZZTEST'))).toHaveLength(1);
        // A stamped AU producer and cell id: no licence, and a closed cell.
        const stamped = cell('US', 'AU5ZZ001').replace('"sourceHO":"US"', '"_sourceHO":"AU"');
        expect(dataFileProblems('x.json', stamped)).toHaveLength(2);
        // Labelled public-domain or synthetic, from open cells: passes.
        const label = (licence: string, cellId: string) =>
            cell('US', cellId).replace('"_meta":{', `"_meta":{"licence":"${licence}",`);
        expect(dataFileProblems('x.json', label('public-domain', 'US5ZZ01M'))).toEqual([]);
        expect(dataFileProblems('x.json', label('synthetic', 'ZZ5SYN01'))).toEqual([]);
        expect(dataFileProblems('x.json', label('synthetic', 'OC-99-ZZTEST'))).toEqual([]);
        // A licence label does not launder a closed cell.
        expect(dataFileProblems('x.json', label('public-domain', 'AU5ZZ001'))).toHaveLength(1);
        // Layers without coordinates (a catalogue), or code, are not extracts.
        expect(dataFileProblems('x.json', JSON.stringify({ LNDARE: 'land area' }))).toEqual([]);
        expect(dataFileProblems('x.ts', bare)).toEqual([]);
    });

    it('content rule: a _meta naming o-charts, oeSENC or a pi-cache live capture fails', () => {
        for (const source of ['oeSENC via the Pi', 'o-charts OC-99', 'pi-cache live capture (fictional)'])
            expect(
                contentProblems('x.json', JSON.stringify({ _meta: { source, capturedAt: '2020-01-01' } })),
                source,
            ).toHaveLength(1);
        expect(contentProblems('x.json', JSON.stringify({ _meta: { source: 'NOAA ENC US5ZZ01M' } }))).toEqual([]);
        expect(contentProblems('x.json', JSON.stringify({ _meta: { source: 'synthetic' } }))).toEqual([]);
    });

    it('id rule: a quoted OC- id beside geometry hits; fictional OC-99, catalogue ids and comments do not', () => {
        // Built, never written, so this file holds no quoted id for the scan to find.
        const id = ['OC', '12', 'ZZTEST'].join('-');
        expect(idRuleHits('x.json', cell('ZZ', id))).toEqual([`x.json:1 ${id}`]);
        const ring = 'const ring = [[10.0001, 20.0001], [10.0002, 20.0001], [10.0002, 20.0002]];';
        expect(idRuleHits('x.ts', `const cellId = '${id}';\n${ring}`)).toEqual([`x.ts:1 ${id}`]);
        expect(idRuleHits('x.ts', `const c = { cellId: '${id}', lat: 10.0001, lon: 20.0001 };`)).toEqual([]);
        // The fictional namespace never hits.
        expect(idRuleHits('x.json', cell('ZZ', 'OC-99-ZZTEST'))).toEqual([]);
        // Catalogue metadata: ids and scales, no geometry.
        expect(idRuleHits('x.ts', `export const SCALE = { '${id}': 22000, '${id}2': 90000 };`)).toEqual([]);
        // An id in a comment, even beside coordinates.
        expect(idRuleHits('x.ts', `// cell '${id}'\n${ring}`)).toEqual([]);
        expect(idRuleHits('x.ts', ` * read '${id}' here\n${ring}`)).toEqual([]);
        expect(idRuleHits('x.ts', `const a = 1; // '${id}'\n${ring}`)).toEqual([]);
    });

    it('manifest rule: an unlisted file, a stale entry and every closed or half-stated licence fail', () => {
        const files = [
            'tests/fixtures/harbour-osm.json.gz',
            'tests/fixtures/buoys/zz-feed.txt',
            'e2e/fixtures/clip.mp4',
            'e2e/fixtures/page.tsx',
            'e2e/fixtures/page.html',
            MANIFEST,
            'tests/other/notAFixture.json',
        ];
        const good = {
            'tests/fixtures/harbour-osm.json.gz': {
                licence: 'odbl',
                source: 'OpenStreetMap overlay (fictional bbox)',
                credit: '© OpenStreetMap contributors (ODbL)',
            },
            'tests/fixtures/buoys/zz-feed.txt': { licence: 'public-domain', source: 'NOAA NDBC (fictional station)' },
            'e2e/fixtures/clip.mp4': { licence: 'synthetic', source: 'ffmpeg testsrc2, one second' },
        };
        expect(manifestProblems(files, { files: good })).toEqual([]);
        // Code, harness pages, the manifest itself and files outside the fixture dirs need no entry.
        expect(isFixtureData('e2e/fixtures/page.tsx')).toBe(false);
        expect(isFixtureData(MANIFEST)).toBe(false);
        expect(isFixtureData('tests/other/notAFixture.json')).toBe(false);
        // A data file with no entry: the shape a captured chart would arrive in.
        expect(manifestProblems([...files, 'tests/fixtures/OC-99-ZZTEST.corridor.json.gz'], { files: good })).toEqual([
            'tests/fixtures/OC-99-ZZTEST.corridor.json.gz: not in tests/fixtures/PROVENANCE.json',
        ]);
        // An entry for a file that is gone (how a deleted Mapbox tile would linger).
        expect(
            manifestProblems(files, {
                files: { ...good, 'tests/fixtures/zz-tile.mvt': { licence: 'synthetic', source: 'fictional tile' } },
            }),
        ).toHaveLength(1);
        const one = (entry: Record<string, string>) =>
            manifestProblems(files, { files: { ...good, 'e2e/fixtures/clip.mp4': entry } });
        // There is no protected licence, and no licence at all is not one either.
        expect(one({ licence: 'protected', source: 'o-charts capture (fictional)' })).toHaveLength(1);
        expect(one({ licence: '', source: 'somewhere (fictional)' })).toHaveLength(1);
        expect(one({ licence: 'synthetic', source: '' })).toHaveLength(1);
        expect(one({ licence: 'cc-by-4.0', source: 'a fictional agency feed' })).toHaveLength(1);
        expect(one({ licence: 'odbl', source: 'OSM (fictional)', credit: 'OSM' })).toHaveLength(1);
        expect(one({ licence: 'third-party-replace', source: 'a fictional vendor tile' })).toHaveLength(1);
        expect(
            one({ licence: 'third-party-replace', source: 'a fictional vendor tile', replacement: '199-ZZ' }),
        ).toEqual([]);
        // A partner's buoy that NDBC only redistributes: WMO Resolution 40, owner credited by name.
        expect(one({ licence: 'wmo-res40', source: 'a fictional partner buoy, via NDBC' })).toHaveLength(1);
        expect(
            one({ licence: 'wmo-res40', source: 'a fictional partner buoy, via NDBC', credit: 'ZZ Met Service' }),
        ).toEqual([]);
        expect(manifestProblems(files, null)).toHaveLength(1);
        expect(manifestProblems(files, { files: [] })).toHaveLength(1);
    });

    it('manifest rule: fixture data that names a proprietary chart as a source fails, whatever its licence', () => {
        const marker = (note: string) =>
            JSON.stringify({ type: 'Feature', properties: { _class: 'isolated', _fix: `ZZ Reef beacon ${note}` } });
        for (const chart of ['Navionics', 'C-MAP', 'BlueChart', 'ChartWorld', 'o-charts', 'oeSENC'])
            expect(
                fixtureSourceProblems('tests/fixtures/zz-markers.json.gz', marker(`retagged per ${chart}`)),
                chart,
            ).toHaveLength(1);
        expect(fixtureSourceProblems('tests/fixtures/zz-markers.json.gz', marker('as OpenStreetMap tags it'))).toEqual(
            [],
        );
        // Test code and prose outside the fixture dirs may name the charts they refuse.
        expect(fixtureSourceProblems('tests/zz.test.ts', marker('retagged per Navionics'))).toEqual([]);
        expect(fixtureSourceProblems('e2e/fixtures/zz.tsx', marker('retagged per Navionics'))).toEqual([]);
    });

    it('real-cell rule: a test reading the real-cells directories fails; other env reads pass', () => {
        const cells = ['THALASSA', 'REAL', 'CELLS', 'DIR'].join('_');
        const bne = ['THALASSA', 'REAL', 'BNE', 'DIR'].join('_');
        expect(realCellProblems('x.test.ts', `const DIR = process.env.${cells} ?? '';`)).toHaveLength(1);
        expect(realCellProblems('x.test.ts', `const dir = process.env['${bne}'];`)).toHaveLength(1);
        expect(realCellProblems('x.test.ts', `// point ${cells} at a scratch folder`)).toHaveLength(1);
        expect(realCellProblems('x.test.ts', `const osm = process.env.THALASSA_REAL_OSM_FILE;`)).toEqual([]);
        expect(realCellProblems('x.test.ts', `const dir = process.env.${cells}_EXTRA;`)).toEqual([]);
    });

    it("real-cell rule: test or tool code that fetches the Pi's installed cells and writes a disk fails", () => {
        const route = ['', 'api', 'enc', 'installed'].join('/');
        const fetch = `const out = execFileSync('curl', ['-s', \`http://pi.invalid:3001${route}/\${id}/data\`]);`;
        // The retired diag cache: every fetched cell kept as a file between runs.
        for (const write of [
            `writeFileSync(\`/tmp/zzCells/\${id}.json\`, out);`,
            `await writeFile(path, out);`,
            `fs.appendFileSync(path, out);`,
            `copyFileSync(tmp, path);`,
            `out.pipe(createWriteStream(path));`,
        ])
            for (const file of [
                'tests/repro/zz.diag.test.ts',
                'tools/zz-capture.mjs',
                'scripts/zz.mjs',
                'e2e/zz.spec.ts',
            ])
                expect(realCellProblems(file, `${fetch}\n${write}`), `${file} ${write}`).toHaveLength(1);
        // Held in memory, it passes; so does a write with no Pi cell fetch.
        expect(realCellProblems('tests/repro/zz.diag.test.ts', `${fetch}\nmemory.set(id, out);`)).toEqual([]);
        expect(realCellProblems('tests/zz.test.ts', `writeFileSync(path, report);`)).toEqual([]);
        // The Pi's own server keeps its store on the boat, and the capture tool is NOAA-only.
        expect(realCellProblems('pi-cache/src/routes/zz.ts', `${fetch}\nwriteFileSync(path, out);`)).toEqual([]);
        expect(realCellProblems('tools/capture-corridor-fixture.mjs', `${fetch}\nwriteFileSync(path, out);`)).toEqual(
            [],
        );
    });
});
