/**
 * Shore Watch, broadcast by the boat's Pi — so a skipper needs a Pi OR a
 * tablet aboard, not both (Shane 2026-08-29: "lets wire up the shore watch to
 * the pi, as long as it still works device to device and pi to device").
 *
 * The constraint that shapes the whole design: the anchor-watch channel is
 * created with `private: true`, so publishing to it needs an authenticated
 * Supabase session. Putting one on the Pi would leave a long-lived user
 * credential on a boat computer that can be stolen with the boat. The diary
 * relay already answered this — the Pi holds only a scoped per-Pi relay
 * credential — so the anchor relay reuses that identity and publishes
 * server-side on the Pi's behalf.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const fn = readFileSync('supabase/functions/anchor-relay/index.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20260829090000_anchor_relay_sessions.sql', 'utf8');
const config = readFileSync('supabase/config.toml', 'utf8');
const sync = readFileSync('services/AnchorWatchSyncService.ts', 'utf8');

describe('the Pi never holds a Supabase credential', () => {
    it('reuses the existing per-Pi relay identity rather than minting a second secret', () => {
        expect(fn).toContain("from('pi_diary_relays')");
        expect(fn).toContain('token_hash');
    });

    it('compares the token in constant time', () => {
        expect(fn).toContain('function secureEqual');
        expect(fn).toContain('diff |= a.charCodeAt(i) ^ b.charCodeAt(i)');
        expect(fn).toContain('secureEqual(await sha256(token), relay.token_hash)');
    });

    it('publishes server-side, so the Pi never joins Realtime', () => {
        expect(fn).toContain('/realtime/v1/api/broadcast');
        expect(fn).toContain('SUPABASE_SERVICE_ROLE_KEY');
        // And the key never leaves the function.
        expect(fn).not.toMatch(/return json\([^)]*serviceRoleKey/);
    });
});

describe('a relay may only reach the channel its owner authorised', () => {
    it('binds relay to session code, with an expiry', () => {
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.pi_anchor_sessions');
        expect(migration).toContain('session_code  TEXT NOT NULL CHECK');
        expect(migration).toContain('expires_at    TIMESTAMPTZ NOT NULL');
    });

    it('refuses an open-ended authorisation at the schema level', () => {
        // Not merely "the app sets a sensible TTL" — the database will not
        // store a standing permission to broadcast a boat's position.
        expect(migration).toContain('pi_anchor_sessions_expiry_bounded');
        expect(migration).toContain("INTERVAL '48 hours'");
    });

    it('checks owner, code and expiry together before broadcasting', () => {
        const guard = fn.slice(fn.indexOf("from('pi_anchor_sessions')"));
        expect(guard).toContain('binding.owner_id !== relay.owner_id');
        expect(guard).toContain('binding.session_code !== sessionCode');
        expect(guard).toContain('Date.parse(binding.expires_at) <= Date.now()');
    });

    it('only lets the OWNER of a relay authorise it', () => {
        // Otherwise a signed-in user could point someone else's Pi at their
        // own channel.
        expect(fn).toContain('relay.owner_id !== ownerId');
    });

    it('tells a bad credential and a lapsed watch apart', () => {
        // The Pi needs to know whether to ask the app to re-authorise or to
        // stop trying.
        expect(fn).toContain("json({ error: 'unauthorised' }, 401)");
        expect(fn).toContain("json({ error: 'not_authorised_for_session' }, 403)");
    });

    it('gives one answer for unknown, disabled and wrong-token', () => {
        const line = fn.slice(fn.indexOf('if (!relay || !relay.enabled'));
        expect(line.slice(0, 200)).toContain("error: 'unauthorised'");
    });
});

describe('device-to-device is untouched', () => {
    it('publishes the same event on the same topic the app already uses', () => {
        // The shore device cannot tell a Pi from a phone, which is exactly
        // what keeps the existing pairing working.
        expect(fn).toContain('topic: `anchor-watch-${sessionCode}`');
        expect(fn).toContain("event: 'position'");
        expect(sync).toContain("channel.on('broadcast', { event: 'position' }");
    });

    it('stamps type and timestamp the way the vessel client does', () => {
        expect(fn).toContain("type: 'position'");
        expect(fn).toContain('timestamp: Date.now()');
    });

    it('changes nothing in the sync service itself', () => {
        expect(sync).not.toContain('anchor-relay');
    });
});

describe('gateway and account hygiene', () => {
    it('adds no gateway bypass — it takes the default and checks identity itself', () => {
        // A durable credentialless exception needs its own approval, and this
        // design does not need one: callers present the anon key (a public
        // JWT) at the gateway, and real identity is established inside — the
        // relay token hash for the Pi, getUser() for the app.
        expect(config).not.toContain('[functions.anchor-relay]');
        expect(fn).toContain('verify_jwt = true');
    });

    it('carries the write fence every user-owned table needs', () => {
        expect(migration).toContain('CREATE TRIGGER account_deletion_write_fence');
        // With the FK column named — a fence with no argument checks nothing.
        expect(migration).toContain("block_tombstoned_account_write('owner_id')");
    });

    it('cascades off the account, so deletion reaches it', () => {
        expect(migration).toContain('REFERENCES auth.users(id) ON DELETE CASCADE');
        expect(migration).toContain('REFERENCES public.pi_diary_relays(relay_id) ON DELETE CASCADE');
    });

    it('is not client-readable — a token hash-s neighbour is not a public table', () => {
        expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('REVOKE ALL ON TABLE public.pi_anchor_sessions FROM PUBLIC, anon, authenticated');
    });
});
