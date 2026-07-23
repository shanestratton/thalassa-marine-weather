import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260723104200_checklist_offline_sync.sql', 'utf8');
const syncService = readFileSync('services/vessel/SyncService.ts', 'utf8');

describe('checklist offline sync migration', () => {
    it('creates both outbox-backed tables with stable pull cursors', () => {
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.checklists/i);
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.checklist_runs/i);
        expect(migration).toMatch(/public\.checklists[\s\S]+updated_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
        expect(migration).toMatch(/public\.checklist_runs[\s\S]+updated_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
        expect(migration).toMatch(/jsonb_typeof\(items\) = 'array'/i);
    });

    it('keeps vessel-reference templates owner-private and publishes changes', () => {
        expect(migration.match(/user_id = auth\.uid\(\)/gi)).toHaveLength(4);
        expect(migration).not.toMatch(/can_access_vessel_register/i);
        expect(migration).not.toMatch(/can_access_passage/i);
        expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/gi);
        expect(migration).toMatch(/ADD TABLE public\.checklists/i);
        expect(migration).toMatch(/ADD TABLE public\.checklist_runs/i);
    });

    it('includes checklist records in the canonical sync engine', () => {
        expect(syncService).toMatch(/'checklists'/);
        expect(syncService).toMatch(/'checklist_runs'/);
    });
});
