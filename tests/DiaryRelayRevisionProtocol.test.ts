import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(resolve(root, 'supabase/migrations/20260727100000_diary_relay_outbox.sql'), 'utf8');
const edge = readFileSync(resolve(root, 'supabase/functions/diary-relay/index.ts'), 'utf8');

describe('diary relay revision and cancellation protocol', () => {
    it('makes revisions positive and keeps cancellation fences private', () => {
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS client_revision INTEGER NOT NULL DEFAULT 1/i);
        expect(migration).toMatch(/CHECK \(client_revision >= 1\)/i);
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.diary_relay_tombstones/i);
        expect(migration).toMatch(/PRIMARY KEY \(owner_id, client_operation_id\)/i);
        expect(migration).toMatch(/ALTER TABLE public\.diary_relay_tombstones ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.diary_relay_tombstones FROM PUBLIC, anon, authenticated/i,
        );
    });

    it('serializes writes with cancellation and returns the canonical higher revision only', () => {
        expect(migration).toContain('pg_advisory_xact_lock');
        expect(migration).toContain('diary_entries_block_tombstoned_write');
        expect(migration).toMatch(
            /ON CONFLICT \(user_id, client_operation_id\) DO UPDATE[\s\S]*?WHERE EXCLUDED\.client_revision > public\.diary_entries\.client_revision/i,
        );
        expect(migration).toContain("RETURN jsonb_build_object('status', 'cancelled')");
        expect(migration).toContain('DELETE FROM public.diary_entries');
    });

    it('uses the atomic RPCs for both authenticated-device and Pi relay actions', () => {
        expect(edge).toContain('function normalizeClientRevision');
        expect(edge).toContain('function nullableBoatId');
        expect(edge).toContain('boat_id: nullableBoatId(raw.boat_id)');
        expect(edge).toContain("admin.rpc('diary_relay_upsert_entry'");
        expect(edge).toContain("admin.rpc('diary_relay_cancel_entry'");
        expect(edge).toContain("if (body.action === 'upsert') return deviceUpsert(req, body);");
        expect(edge).toContain(
            "if (body.action === 'cancel' || body.action === 'delete') return cancelDiary(req, body);",
        );
        expect(edge).toContain('hasRelayCredentialHeaders(req)');
    });

    it('keeps an established Pi credential stable during ordinary re-pair attempts', () => {
        expect(edge).toContain('already_paired: true');
        expect(edge).toContain('function existingPairingResponse');
        expect(edge).toContain('if (!relay.enabled)');
        expect(edge).toContain('Reissuing a token every');
    });

    it('claims an unpaired Pi atomically without letting a read race replace its owner', () => {
        expect(edge).toContain(".from('pi_diary_relays').insert(");
        expect(edge).not.toContain(".from('pi_diary_relays').upsert(");
        expect(edge).toContain("if (pairError.code === '23505')");
        expect(edge).toContain('const afterConflict = await loadRelayPairing(admin, relayId);');
        expect(edge).toContain('return existingPairingResponse(afterConflict.relay, relayId, caller.userId);');
        expect(edge).toContain('This Pi pairing is disabled; reset it before pairing again');
    });
});
