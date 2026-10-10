// @vitest-environment node
/**
 * REAL-CLOCK guard for curated, time-limited routing data (Phase 0, Shane
 * approved 2026-09-29).
 *
 * Every other suite pins its clock (13 September for the Newport exit), so an
 * expired review kept CI green while the app silently fell back: the Newport
 * exit and RECTRC 407 policy lapsed on 2026-09-19 and nothing went red. This
 * suite deliberately reads the machine clock, and rejects a clock earlier
 * than the day it was written (a pinned or faked one). Each record must be
 * inside its validity, RETIRED on the record, or have its exact lapse
 * acknowledged in services/curatedDataLifecycle.ts with a reason and the
 * fallback behaviour. Any new lapse fails here until someone renews, retires
 * or acknowledges it.
 *
 * Committed regional seeds (supabase/functions/osm-overlay/data/*.json) are
 * deploy seeds, stale by design: the live copy is refreshed out of band and
 * never committed. They are keyed on the REGION
 * (`osm-regional:<region>:committed-seed`), so committing a refreshed seed
 * needs no change here or in the acknowledgements. A lapsed seed is tolerated
 * only while the real runtime (loadRegionalOverlay + selectRegionalOverlay)
 * refuses it, which this suite checks. A NEW region needs its own
 * acknowledgement once its seed lapses.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    CURATED_LAPSE_ACKNOWLEDGEMENTS,
    curatedLapseProblems,
    type CuratedExpiryRecord,
} from '../services/curatedDataLifecycle';
import { NTM_ROUTING_PACKS, PACK_MAX_AGE_MS } from '../services/ntmRouting';
import {
    loadRegionalOverlay,
    REGIONAL_MAX_AGE_MS,
    selectRegionalOverlay,
} from '../supabase/functions/_shared/regional-overlay';

const ROOT = join(__dirname, '..');
const REGIONAL_DIR = 'supabase/functions/osm-overlay/data';
/** When this guard was written (29 Sep in Brisbane). A clock earlier than
 * this is a pinned or faked one, not the real one. */
const GUARD_WRITTEN = Date.parse('2026-09-28T12:00:00Z');

const MONTHS = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
];
/** "1 July 2026" → epoch ms (UTC), NaN when it is not exactly that shape. */
function surveyDay(text: string): number {
    const m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text.trim());
    const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
    if (!m || month < 0) return Number.NaN;
    const ms = Date.UTC(Number(m[3]), month, Number(m[1]));
    return new Date(ms).getUTCDate() === Number(m[1]) ? ms : Number.NaN;
}

interface RegionalSeed {
    file: string;
    bundle: { region?: string; sourceAsOf?: string; coverage?: [number, number, number, number] };
}
function regionalSeeds(): RegionalSeed[] {
    return readdirSync(join(ROOT, REGIONAL_DIR))
        .filter((n) => n.endsWith('.json'))
        .map((name) => ({
            file: `${REGIONAL_DIR}/${name}`,
            bundle: JSON.parse(readFileSync(join(ROOT, REGIONAL_DIR, name), 'utf8')) as RegionalSeed['bundle'],
        }));
}

/** Every curated, time-limited record the app ships, read from the real modules. */
function curatedRecords(): CuratedExpiryRecord[] {
    const records: CuratedExpiryRecord[] = [];
    // The Newport canal-exit profile and channel-track policy (retired on
    // 2026-09-29) were deleted on 2026-10-10 with the rest of the retired
    // chain: they held positions derived from the licensed chart (127-C-a).
    // The runtime ceiling runs PACK_MAX_AGE_MS from the notice's own date on
    // the live feed. A notice reports a survey, so it cannot predate it: the
    // survey day gives the earliest possible lapse and this guard can only
    // flag early, never late.
    for (const pack of NTM_ROUTING_PACKS)
        records.push({
            key: `ntm-pack:${pack.id}:${pack.noticeKey}#r${pack.rev ?? 1}`,
            source: 'services/ntmRouting.ts NTM_ROUTING_PACKS',
            literalFile: 'services/ntmRouting.ts',
            expiresAtMs: surveyDay(pack.surveyed) + PACK_MAX_AGE_MS,
        });
    // Keyed on the region: see the header (committed seeds are stale by design).
    for (const { file, bundle } of regionalSeeds())
        records.push({
            key: `osm-regional:${bundle.region}:committed-seed`,
            source: file,
            literalFile: file,
            expiresAtMs: Date.parse(String(bundle.sourceAsOf)) + REGIONAL_MAX_AGE_MS,
        });
    return records;
}

// Net for records added OUTSIDE the registries above: any literal expiry date
// in shipped source or data. Test files are excluded (they pin synthetic dates).
const SCAN_ROOTS = ['services', 'data', 'config', 'supabase/functions', 'public/notices', 'public/anchorages'];
const EXPIRY_KEYS = [
    'validUntil',
    'validTo',
    'valid_until',
    'valid_to',
    'validThrough',
    'valid_through',
    'reviewedUntil',
    'reviewed_until',
    'expiresAt',
    'expires_at',
    'expiresOn',
    'expires_on',
    'expires',
    'expiry',
    'expiryDate',
    'expiry_date',
    'notAfter',
    'not_after',
    'reviewDueAt',
    'review_due_at',
    'retireAfter',
    'staleAfter',
    'stale_after',
];
/** A date, optionally with a time (T or space), optionally with Z or an offset. */
const DATE_LITERAL = String.raw`\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?`;
const EXPIRY_LITERAL = new RegExp(
    String.raw`["']?\b(${EXPIRY_KEYS.join('|')})\b["']?\s*[:=]\s*["'\x60](${DATE_LITERAL})["'\x60]`,
    'g',
);

function expiryLiterals(text: string): { key: string; value: string; line: number }[] {
    const found: { key: string; value: string; line: number }[] = [];
    for (const m of text.matchAll(EXPIRY_LITERAL))
        found.push({ key: m[1], value: m[2], line: text.slice(0, m.index).split('\n').length });
    return found;
}

/** Past (or unreadable) literal expiries that no record owns. A literal is
 * owned only by a record with the same instant AND the same literalFile:
 * copying a registered validUntil into a new, unregistered policy elsewhere
 * is caught, not waved through by value. */
function escapedLiterals(
    sources: readonly { file: string; text: string }[],
    records: readonly CuratedExpiryRecord[],
    now: number,
): string[] {
    const owned = new Set(records.filter((r) => r.literalFile).map((r) => `${r.literalFile}|${r.expiresAtMs}`));
    const escaped: string[] = [];
    for (const { file, text } of sources)
        for (const { key, value, line } of expiryLiterals(text)) {
            const at = Date.parse(value);
            if (Number.isFinite(at) && at > now) continue;
            if (!owned.has(`${file}|${at}`)) escaped.push(`${file}:${line} ${key}=${value}`);
        }
    return escaped;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) sourceFiles(path, out);
        else if (/\.(ts|tsx|js|mjs|json)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(path);
    }
    return out;
}

let now: number;
beforeAll(() => {
    vi.useRealTimers();
    now = Date.now();
});

describe('curated routing data on the REAL clock', () => {
    it('rejects a clock earlier than the day this guard was written (a pinned or faked one)', () => {
        expect(now).toBeGreaterThanOrEqual(GUARD_WRITTEN);
    });

    it('finds every kind of curated time-limited record', () => {
        const keys = curatedRecords().map((r) => r.key.split(':')[0]);
        for (const kind of ['ntm-pack', 'osm-regional'])
            expect(keys, `no ${kind} records found — did an export move?`).toContain(kind);
    });

    it('every record is current, retired on the record, or has its exact lapse acknowledged', () => {
        expect(curatedLapseProblems(curatedRecords(), CURATED_LAPSE_ACKNOWLEDGEMENTS, now)).toEqual([]);
    });

    it('a lapsed committed regional seed is refused by the real runtime, never served as current', async () => {
        // What makes the region-level acknowledgement honest.
        expect(REGIONAL_MAX_AGE_MS).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
        for (const { file, bundle } of regionalSeeds()) {
            const lapsed = !(now - Date.parse(String(bundle.sourceAsOf)) < REGIONAL_MAX_AGE_MS);
            if (!lapsed) continue;
            let served = false;
            try {
                served = selectRegionalOverlay(await loadRegionalOverlay(bundle), bundle.coverage!, now) !== null;
            } catch {
                served = false;
            }
            expect(served, `${file} has lapsed but the runtime still serves it`).toBe(false);
        }
    });

    it('no past expiry date in shipped source or data escapes the registries above', () => {
        const sources = SCAN_ROOTS.flatMap((root) =>
            sourceFiles(join(ROOT, root)).map((path) => ({
                file: relative(ROOT, path),
                text: readFileSync(path, 'utf8'),
            })),
        );
        expect(escapedLiterals(sources, curatedRecords(), now)).toEqual([]);
    });
});

describe('the guard itself', () => {
    const lapsed = (extra: Partial<CuratedExpiryRecord> = {}): CuratedExpiryRecord => ({
        key: 'synthetic:record:r1',
        source: 'synthetic',
        expiresAtMs: now - 1,
        ...extra,
    });
    const ack = {
        key: 'synthetic:record:r1',
        acknowledgedOn: '2026-09-29',
        reason: 'Synthetic acknowledgement reason',
        fallback: 'Synthetic fallback behaviour',
    };

    it('fails on a NEW unacknowledged lapse and passes a current record', () => {
        expect(curatedLapseProblems([lapsed()], [], now)).toHaveLength(1);
        expect(curatedLapseProblems([lapsed({ expiresAtMs: now + 60_000 })], [], now)).toEqual([]);
        expect(curatedLapseProblems([lapsed({ expiresAtMs: Number.NaN })], [], now)).toHaveLength(1);
    });

    it('accepts a complete retirement or an exact acknowledgement, and nothing thinner', () => {
        const retirement = {
            retiredOn: '2026-09-29',
            decidedBy: 'Synthetic owner decision',
            reason: 'Synthetic retirement reason',
            fallback: 'Synthetic fallback behaviour',
        };
        expect(curatedLapseProblems([lapsed({ retirement })], [], now)).toEqual([]);
        expect(curatedLapseProblems([lapsed({ retirement: { retiredOn: '2026-09-29' } })], [], now)).toHaveLength(1);
        expect(curatedLapseProblems([lapsed()], [ack], now)).toEqual([]);
        expect(curatedLapseProblems([lapsed()], [{ ...ack, fallback: '' }], now)).toHaveLength(1);
        // A renewed record is a new key: the old acknowledgement does not carry over.
        expect(curatedLapseProblems([lapsed({ key: 'synthetic:record:r2' })], [ack], now)).toHaveLength(2);
    });

    it('flags an acknowledgement that matches no record', () => {
        expect(curatedLapseProblems([], [ack], now)).toHaveLength(1);
    });

    it('the source net sees a literal expiry wherever and however it is written', () => {
        expect(expiryLiterals(`const x = { validUntil: '2020-01-01T00:00:00Z' };`)).toEqual([
            { key: 'validUntil', value: '2020-01-01T00:00:00Z', line: 1 },
        ]);
        expect(expiryLiterals(`\n"review_due_at": "2026-01-01"`)).toEqual([
            { key: 'review_due_at', value: '2026-01-01', line: 2 },
        ]);
        // Offsets, no zone, a space separator, fractional seconds.
        for (const value of [
            '2026-10-01T00:00:00+10:00',
            '2026-10-01T00:00:00-0300',
            '2026-10-01T00:00:00',
            '2026-10-01 00:00',
            '2026-10-01T00:00:00.000Z',
        ])
            expect(expiryLiterals(`validUntil: "${value}"`).map((m) => m.value)).toEqual([value]);
        // More key names.
        for (const key of ['reviewedUntil', 'validThrough', 'expires', 'expiresOn'])
            expect(expiryLiterals(`${key} = '2020-01-01'`).map((m) => m.key)).toEqual([key]);
        // A retirement date is a past fact by design, never an expiry.
        expect(expiryLiterals(`retiredOn: '2026-09-29'`)).toEqual([]);
    });

    it('owns a literal by file AND value: the same instant copied elsewhere escapes', () => {
        const record = lapsed({ expiresAtMs: Date.parse('2020-01-01T00:00:00Z'), literalFile: 'services/a.ts' });
        const text = `validUntil: '2020-01-01T00:00:00Z'`;
        expect(escapedLiterals([{ file: 'services/a.ts', text }], [record], now)).toEqual([]);
        expect(escapedLiterals([{ file: 'services/b.ts', text }], [record], now)).toEqual([
            'services/b.ts:1 validUntil=2020-01-01T00:00:00Z',
        ]);
        // A record with no literal file owns no literal at all.
        expect(
            escapedLiterals([{ file: 'services/a.ts', text }], [{ ...record, literalFile: undefined }], now),
        ).toHaveLength(1);
        // An unreadable literal is never waved through.
        expect(escapedLiterals([{ file: 'services/a.ts', text: `expiry: '2026-13-45'` }], [record], now)).toHaveLength(
            1,
        );
    });
});
