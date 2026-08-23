/**
 * THE STRUCTURAL DEFENCE.
 *
 * The entire On Watch design rests on one property: credit is denominated in
 * verified listening TIME and is blind to yield. A boat anchored off Osprey
 * Reef hearing nothing for a month must accrue exactly what a boat in Sydney
 * Harbour hearing thirty sentences a second accrues — because the empty-bay
 * punter is the most valuable contributor in the fleet (the only ear for
 * hundreds of miles, and their silence is itself the evidence that coverage
 * exists there) and they produce zero vessel rows.
 *
 * Every yield-based metric silently punishes exactly that person. And
 * "weight credit by sentences delivered" is the single most natural-sounding
 * suggestion anyone will make about this feature, in the first performance
 * conversation, with the best of intentions.
 *
 * So the property is pinned mechanically rather than left to memory. If a
 * future change routes sentence counts into the credit arithmetic, this fails.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const MIGRATION = readFileSync('supabase/migrations/20260823120000_ais_watch_ledger.sql', 'utf8');
const WORKER = readFileSync('workers/ais-ingest/fleetFeed.ts', 'utf8');
const CLIENT = readFileSync('services/AisShareService.ts', 'utf8');

/** The block that computes what a check-in is worth. */
function creditArithmetic(): string {
    const start = MIGRATION.indexOf('credit_s   := ');
    expect(start).toBeGreaterThan(-1);
    return MIGRATION.slice(start, MIGRATION.indexOf(';', MIGRATION.indexOf('credit_min := ', start)));
}

describe('credit is blind to yield', () => {
    it('computes credit from connected time, elapsed time and a cap — nothing else', () => {
        const expr = creditArithmetic();
        expect(expr).toContain('p_connected_s');
        expect(expr).toContain('elapsed_s');
        expect(expr).toContain('3600');
        // The three ways yield could sneak in.
        expect(expr).not.toContain('p_sentences');
        expect(expr).not.toContain('sentences');
        expect(expr).not.toContain('p_heard');
    });

    it('bounds a claim against wall clock so standing cannot be minted', () => {
        // Without the elapsed_s term, a client claiming 3600 connected seconds
        // every five minutes accrues twelve hours an hour.
        const expr = creditArithmetic();
        expect(expr).toMatch(/LEAST\s*\(/i);
        expect(MIGRATION).toContain('EXTRACT(EPOCH FROM (now_ts - existing.last_seen_at))');
    });

    it('keeps sentences in a column that only ever accumulates', () => {
        // It may be recorded — diagnostics are useful — but the only statement
        // touching it must be an addition, never a read into a decision.
        const writes = MIGRATION.match(/sentences\s*=\s*[^,\n]+/g) ?? [];
        expect(writes.length).toBeGreaterThan(0);
        for (const w of writes) {
            expect(w).toMatch(/sentences\s*=\s*existing\.sentences\s*\+/);
        }
        expect(MIGRATION).toContain('Diagnostics only');
    });

    it('never lets yield reach the standing verdict', () => {
        const start = MIGRATION.indexOf('SELECT CASE');
        const standing = MIGRATION.slice(start, MIGRATION.indexOf('INTO standing', start));
        expect(standing).not.toContain('sentences');
        expect(standing).not.toContain('p_heard');
        expect(standing).not.toContain('last_heard_at');
    });

    it('reports what was heard as a fact about the boat, not a claim on credit', () => {
        // p_heard exists — it drives the `deaf` diagnosis wording — but it may
        // only ever set last_heard_at.
        const uses = MIGRATION.match(/p_heard[^\n]*/g) ?? [];
        expect(uses.length).toBeGreaterThan(0);
        for (const u of uses) {
            const ok =
                u.includes('BOOLEAN') || // the parameter declaration
                u.includes('last_heard_at') ||
                u.includes('THEN now_ts') || // CASE WHEN p_heard THEN now_ts ... setting last_heard_at
                u.trim().startsWith('--');
            expect(ok, `p_heard used outside last_heard_at: ${u}`).toBe(true);
        }
    });
});

describe('the wire carries time, not yield', () => {
    it('sends connected seconds independently of anything heard', () => {
        // The client's claim is built from banked link time. If this ever
        // consulted heardSinceCheckin, the empty bay would claim zero.
        const fn = CLIENT.slice(CLIENT.indexOf('function pendingConnectedSeconds'), CLIENT.indexOf('function loadCard'));
        expect(fn).toContain('connectedPendingMs');
        expect(fn).not.toContain('heardSinceCheckin');
        expect(fn).not.toContain('buffer');
    });

    it('never gates the check-in on having heard something', () => {
        // The original bug, in one line: `if (buffer.length < MIN_FLUSH_
        // SENTENCES) return;` sat ahead of every network path, so a silent
        // receiver made zero requests forever. Whatever guards flush() now,
        // an empty buffer must not be sufficient to stop it.
        const flush = CLIENT.slice(CLIENT.indexOf('async function flush('), CLIENT.indexOf('/** Test seam.'));
        const guard = flush.slice(0, flush.indexOf('const batch'));
        expect(guard).toContain('watchDue');
        // A bare buffer-length early return must not have come back.
        expect(guard).not.toMatch(/if\s*\(\s*buffer\.length\s*<\s*MIN_FLUSH_SENTENCES\s*\)\s*return/);
    });

    it('credits the watch after the sentences are already banked', () => {
        // Invariant 4: a ledger outage must cost nobody their contribution.
        const enqueue = WORKER.indexOf('deps.db.enqueue(record)');
        const credit = WORKER.indexOf("client.rpc('record_ais_watch'");
        expect(enqueue).toBeGreaterThan(-1);
        expect(credit).toBeGreaterThan(enqueue);
        const block = WORKER.slice(WORKER.indexOf('const watch = readWatchEnvelope(req)'), credit + 1400);
        expect(block).toContain('catch');
        expect(block).toContain('watchErrors');
    });
});
