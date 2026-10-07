/**
 * ship_logs.position_source — which receiver produced each logged position
 * (build 123, package VL; thalassa-vessel-gps-truth: "modal opt-in AND
 * per-point tagging", 2026-08-30).
 *
 * WRITTEN, NOT APPLIED. `supabase db push` needs Shane's per-action yes; until
 * then the client writes the field only behind a column-present probe
 * (services/shiplog/positionSourceColumn.ts), so an unknown column can never
 * wedge or dead-letter the offline queue.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIX_SOURCES } from '../services/shiplog/trackSourcePlan';

const migration = readFileSync('supabase/migrations/20261007183000_ship_log_position_source.sql', 'utf8');

describe('ship-log position-source migration', () => {
    it('is additive and nullable: old rows stay null, meaning unknown', () => {
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS position_source TEXT\s*;/i);
        expect(migration).not.toMatch(/position_source TEXT NOT NULL/i);
        expect(migration).not.toMatch(/DEFAULT/i);
        expect(migration).not.toMatch(/UPDATE\s+public\.ship_logs/i);
    });

    it('checks the value against exactly the client vocabulary', () => {
        expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS ship_logs_position_source_check/i);
        const check = migration.match(/position_source IN \(([^)]*)\)/i)?.[1] ?? '';
        const values = [...check.matchAll(/'([^']+)'/g)].map((match) => match[1]);
        expect(values).toEqual([...FIX_SOURCES]);
        expect(migration).toMatch(/position_source IS NULL\s+OR/i);
    });

    it('touches nothing but the one column (no RLS, grants, triggers or functions)', () => {
        expect(migration).not.toMatch(/CREATE (OR REPLACE )?FUNCTION|TRIGGER|GRANT|REVOKE|POLICY/i);
    });
});
