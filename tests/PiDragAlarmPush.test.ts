/**
 * A Pi-detected drag must be able to wake a locked phone.
 *
 * Until 2026-09-04 it could not. anchor_alarm_events — the table whose INSERT
 * trigger calls send-anchor-alarm and pushes via APNs — had exactly ONE writer
 * in the codebase (AnchorWatchSyncService), gated on `role === 'vessel'`: a
 * phone aboard. The Pi never joins Realtime and could never reach it.
 *
 * So the one arrangement designed to let the skipper LEAVE THE BOAT was the
 * one with no push path: a dragging anchor reached a foregrounded WKWebView
 * with the anchor page mounted, or nobody at all.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const relay = readFileSync('supabase/functions/anchor-relay/index.ts', 'utf8');
const broadcaster = readFileSync('pi-cache/src/anchorBroadcaster.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20260923170000_shore_watch_reliability.sql', 'utf8');

describe('the relay raises a drag alarm the phone can be pushed', () => {
    it('inserts an alarm event when the Pi reports isAlarm', () => {
        expect(relay).toContain('p_drag: gpsAvailable && p.isAlarm === true');
        expect(relay).toContain("admin.rpc('record_pi_anchor_heartbeat'");
        expect(migration).toContain('IF p_gps_available AND p_drag AND NOT EXISTS');
        expect(migration).toContain('INSERT INTO public.anchor_alarm_events');
    });

    it('is RISING EDGE only — the Pi posts every 10s', () => {
        // Level-triggered, this would queue ~360 critical alerts an hour.
        expect(migration).toContain("alarm_kind = 'drag' AND created_at > now() - interval '10 minutes'");
    });

    it('attributes the alarm to the VERIFIED relay owner, never the request body', () => {
        expect(relay).toContain('p_owner_id: relay.owner_id');
        // And that owner was matched against the binding before we get here.
        expect(relay).toMatch(/binding\.owner_id !== relay\.owner_id/);
        expect(relay).toMatch(/binding\.session_code !== sessionCode/);
    });

    it('reads the field names the Pi actually sends', () => {
        // A silently-null distance would make the push text useless, so these
        // are checked against the emitter rather than assumed.
        expect(broadcaster).toMatch(/vessel: \{ latitude: fix\.latitude, longitude: fix\.longitude/);
        expect(broadcaster).toMatch(/swingRadius: assignment\.swingRadius,/);
        expect(relay).toContain('finiteOrZero(p.distance)');
        expect(relay).toContain('finiteOrZero(p.swingRadius)');
        expect(relay).toContain('gpsAvailable ? vessel.latitude : null');
    });

    it('the Pi has already confirmed the drag before this fires', () => {
        // So an edge here is a confirmed drag, not a single GPS outlier.
        expect(broadcaster).toMatch(/export const ALARM_CONFIRM_COUNT = 3;/);
    });
});
