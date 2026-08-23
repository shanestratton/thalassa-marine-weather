/**
 * "if you drill down on a ship, it says AISStream, it should probably now say
 * AIS HUB" (Shane 2026-08-23).
 *
 * He is right, and the reason it was wrong is worse than a stale string: the
 * app never knew. `vessels` has no provenance column — workers/ais-ingest/
 * db.ts upsertBatch writes mmsi, position, kinematics and static data and
 * nothing else — so the boat's own bridge, the AISHub poller and the dead
 * aisstream socket all land in identical rows. The label was hard-coded, and
 * it kept naming a provider long after that provider went silent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/map/useAisStreamLayer.ts', 'utf8');

describe('AIS target attribution', () => {
    it('names the live feed, not the dead one', () => {
        expect(src).toContain("const CLOUD_AIS_SOURCE_LABEL = 'AISHub';");
        // Scoped to what a skipper actually reads. The hook is still FILE-named
        // useAisStreamLayer — a leftover from when aisstream was the only
        // cloud source — and renaming a module is a separate change from
        // correcting a label on the chart.
        const popup = src.slice(src.indexOf('const source = p.source'), src.indexOf('const source = p.source') + 400);
        expect(popup).not.toContain('AISStream');
        expect(src).not.toContain("source: 'aisstream'");
        expect(src).not.toContain("'🌐 AISStream'");
    });

    it('drives the property and the popup from ONE constant', () => {
        // They were two hard-coded strings that had already drifted from the
        // truth together; one source means they cannot drift apart.
        expect(src).toContain('source: CLOUD_AIS_SOURCE_ID,');
        expect(src).toContain('`🌐 ${CLOUD_AIS_SOURCE_LABEL}`');
    });

    it('keeps "local" meaning the boat heard it itself', () => {
        // That one IS per-vessel truth and is load-bearing: AisGuardZone and
        // anchorRadarTargets both branch on it, and the receiver wins MMSI
        // collisions against the cloud feed.
        expect(src).toContain("p.source === 'local' ? '📡 Local NMEA'");
        const guard = readFileSync('services/AisGuardZone.ts', 'utf8');
        expect(guard).toContain("'local'");
    });

    it('says out loud that it is a build-time claim, not row data', () => {
        // The next person will otherwise read the label as provenance and
        // trust it the way this one was trusted.
        expect(src).toContain('has no provenance column');
        expect(src).toContain('not a per-vessel fact');
    });

    it('is still true that the row carries no source', () => {
        // If a source column ever lands, this test should fail and the label
        // should start reading it.
        const db = readFileSync('workers/ais-ingest/db.ts', 'utf8');
        const upsert = db.slice(db.indexOf('private async upsertBatch'), db.indexOf('return row;'));
        expect(upsert).not.toMatch(/row\.source\s*=/);
    });
});
