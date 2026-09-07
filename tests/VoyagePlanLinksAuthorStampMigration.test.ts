import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Author-stamped followed-route links (2026-09-08). Two phones on one skipper
 * account could not tell whose route link stood on the active voyage, so the
 * second one to sign in saw nothing and could overwrite it. The migration
 * stamps device + server time on the link row and records the recording
 * device on the voyage. It must stay ADVISORY: no refusal triggers, no new
 * policies — the client reads the stamp and asks, the server never blocks.
 */
const migration = readFileSync('supabase/migrations/20260908150000_voyage_plan_links_author_stamp.sql', 'utf8');
const voyageLogService = readFileSync('services/VoyageLogService.ts', 'utf8');
const voyageService = readFileSync('services/VoyageService.ts', 'utf8');

describe('voyage_plan_links author-stamp migration', () => {
    it('adds the author columns idempotently and server-stamps updated_at', () => {
        expect(migration).toMatch(
            /ALTER TABLE public\.voyage_plan_links[\s\S]+ADD COLUMN IF NOT EXISTS device_id TEXT/i,
        );
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS device_name TEXT/i);
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.voyage_plan_links_touch\(\)/i);
        expect(migration).toMatch(/NEW\.updated_at := now\(\)/i);
        expect(migration).toMatch(/DROP TRIGGER IF EXISTS voyage_plan_links_touch ON public\.voyage_plan_links/i);
        expect(migration).toMatch(
            /CREATE TRIGGER voyage_plan_links_touch[\s\S]+BEFORE INSERT OR UPDATE ON public\.voyage_plan_links/i,
        );
    });

    it('records the recording device on the voyage row', () => {
        expect(migration).toMatch(
            /ALTER TABLE public\.voyages[\s\S]+ADD COLUMN IF NOT EXISTS recording_device_id TEXT/i,
        );
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS recording_device_name TEXT/i);
    });

    it('stays advisory — no refusals, no new policies, no publication changes', () => {
        expect(migration).not.toMatch(/RAISE/i);
        expect(migration).not.toMatch(/CREATE POLICY/i);
        expect(migration).not.toMatch(/ALTER PUBLICATION/i);
        expect(migration).not.toMatch(/DROP POLICY/i);
    });

    it('the app stamps every link write and the cast-off row with the skipperDevice identity', () => {
        expect(voyageLogService).toMatch(/import \{[^}]*getDeviceId[^}]*getDeviceName[^}]*\} from '\.\/skipperDevice'/);
        expect(voyageLogService).toMatch(/device_id: getDeviceId\(\)/);
        expect(voyageLogService).toMatch(/device_name: getDeviceName\(\)/);
        expect(voyageService).toMatch(/recording_device_id: getDeviceId\(\)/);
        expect(voyageService).toMatch(/recording_device_name: getDeviceName\(\)/);
    });
});
