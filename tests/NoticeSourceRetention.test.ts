/**
 * A broken notice source must not delete its warnings.
 *
 * The merged cache was replaced wholesale by whichever sources happened to
 * succeed, then stamped with a fresh timestamp. So a UKHO outage silently
 * removed every UKHO navigation warning and the app presented the shorter list
 * as current (audit 2026-09-04, item 6).
 *
 * For navigation warnings that is the worst failure available: a warning that
 * disappears is indistinguishable from a warning that was cancelled.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const svc = readFileSync('services/NoticeToMarinersService.ts', 'utf8');
const code = svc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('notice source retention', () => {
    it('holds each source separately rather than one merged list', () => {
        expect(code).toMatch(/private bySource: Record<\s*string,/);
        expect(code).toMatch(/const list: Notice\[\] = Object\.values\(this\.bySource\)\.flatMap/);
    });

    it('a failed source KEEPS what it last returned', () => {
        expect(code).toMatch(/notices: previous\?\.notices \?\? \[\]/);
        expect(code).toMatch(/failing: true/);
        // …and keeps its OWN age, so it cannot inherit the fresh stamp.
        expect(code).toMatch(/fetchedAt: previous\?\.fetchedAt \?\? 0/);
    });

    it('only gives up when nothing is held from before', () => {
        // The old guard threw whenever every source failed, discarding a
        // perfectly good held set on one bad network moment.
        expect(code).toMatch(
            /!anySucceeded && Object\.values\(this\.bySource\)\.every\(\(s\) => s\.notices\.length === 0\)/,
        );
    });

    it('exposes per-source failure and age, so staleness cannot hide', () => {
        expect(code).toMatch(/getSourceHealth\(\)/);
        expect(code).toMatch(/failing: s\.failing/);
        expect(code).toMatch(/fetchedAt: s\.fetchedAt/);
    });
});
