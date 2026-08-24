/**
 * The Lady Musgrave loop (2026-08-22): the Plan page died unattended after
 * ~10 minutes — phone AND web, always at the southern end of the GBR — with
 * no interaction at all.
 *
 * The engine of the crash was a hydration↔merge feedback loop with no brake:
 *
 *   merge lists a cell missing → walk downloads it, download SUCCEEDS
 *   (validation, identity, bbox all pass) → success clears the cell's
 *   failure cooldown → import bumps the registry → debounced re-merge
 *   (~27 MB register + parses) → the blob STILL cannot be read back →
 *   missing again → walk again → …
 *
 * The failure cooldown never armed because it only covered download FAILURE
 * — a download that succeeds while producing nothing readable looped at
 * merge speed. Shane's flight trail showed it verbatim: walk-start(1cells) →
 * walk-done → merge → walk-start(1cells), with heap tags climbing
 * h154→h420 monotonically until the process died.
 *
 * The fix is the fruitless-success latch: success is provisional until the
 * next merge reads the blob. A cell whose "successful" walk is followed by
 * the same missing verdict gets the failure cooldown with escalation, so the
 * loop degrades to one bounded retry per cooldown regardless of what the
 * underlying read-back defect turns out to be.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fruitlessWalkCooldownMs } from '../services/enc/EncHazardService';

const src = readFileSync('services/enc/EncHazardService.ts', 'utf8');

describe('hydration fruitless-success latch', () => {
    it('escalates the cooldown per consecutive fruitless walk, capped at an hour', () => {
        expect(fruitlessWalkCooldownMs(1)).toBe(60_000);
        expect(fruitlessWalkCooldownMs(2)).toBe(120_000);
        expect(fruitlessWalkCooldownMs(3)).toBe(240_000);
        // Without the cap, walk #13 would cool for ~68 days — an over-eager
        // latch must not permanently bury a cell that a later fix or manifest
        // update would make readable.
        expect(fruitlessWalkCooldownMs(13)).toBe(3_600_000);
        expect(fruitlessWalkCooldownMs(50)).toBe(3_600_000);
    });

    it('never cools for less than the plain failure cooldown', () => {
        // Zero/negative inputs must not produce a shorter-than-normal retry —
        // that would make the guarded path retry FASTER than a plain failure.
        expect(fruitlessWalkCooldownMs(0)).toBeGreaterThanOrEqual(60_000);
        expect(fruitlessWalkCooldownMs(-1)).toBeGreaterThanOrEqual(60_000);
    });

    // The latch is wired across three private points in EncHazardService —
    // walk-success recording, walk-build checking, and merge read-back
    // clearing. They are deliberately not exported (the loop is an internal
    // hazard), so the wiring is pinned structurally.
    it('records success provisionally, checks at walk build, clears on read-back', () => {
        // runOne's success branch must record the cell for the next merge's
        // verdict, right where the cooldown is cleared.
        const okAt = src.indexOf('hydrationCooldownUntil.delete(id);');
        expect(okAt).toBeGreaterThan(-1);
        // Anchor the closing brace AFTER the ok branch — a file-global
        // indexOf lands on an earlier `} else {` and slices backwards.
        const okBranch = src.slice(okAt, src.indexOf('} else {', okAt));
        expect(okBranch).toContain('lastWalkOkCells.add(id)');

        // The walk builder must convert last-walk-success + still-missing
        // into an armed, escalating cooldown before the cooldown filter runs.
        const walkGuard = src.slice(
            src.indexOf('for (const id of cellIds)'),
            src.indexOf('const walk = cellIds.filter'),
        );
        expect(walkGuard).toContain('fruitlessWalkCooldownMs');
        expect(walkGuard).toContain('hydrationCooldownUntil.set(id');
        expect(walkGuard).toContain("crumb('enc:walk-loop'");

        // A good read-back retires the latch so a healthy cell never trips it.
        const readBack = src.slice(
            src.indexOf('// A good read-back retires'),
            src.indexOf('loadedBlobs.set(cell.id, blob);'),
        );
        expect(readBack).toContain('lastWalkOkCells.delete(cell.id)');
        expect(readBack).toContain('fruitlessOkWalks.delete(cell.id)');
    });

    it('stays quiet for ordinary not-yet-hydrated cells', () => {
        // The read-failure warn must be scoped to the contradiction — a cold
        // coast lists dozens of legitimately-missing cells per merge, and a
        // guard that spams becomes a guard that gets deleted.
        const missingBranch = src.slice(src.indexOf('if (!blob) {'), src.indexOf('missingBlobs.push(cell.id);'));
        expect(missingBranch).toContain('lastWalkOkCells.has(cell.id)');
    });
});
