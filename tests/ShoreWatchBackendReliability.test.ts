import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anchorAlarmMessage, validAnchorGps } from '../supabase/functions/_shared/anchor-alarm';

const sql = readFileSync('supabase/migrations/20260923170000_shore_watch_reliability.sql', 'utf8');
const relay = readFileSync('supabase/functions/anchor-relay/index.ts', 'utf8');
const push = readFileSync('supabase/functions/send-anchor-alarm/index.ts', 'utf8');
const now = Date.parse('2026-09-23T06:00:00Z');
const fresh = { timestamp: now, gpsTimestamp: now, vessel: { latitude: -20, longitude: 149 } };

describe('Shore Watch cloud alarm contract', () => {
    it('accepts current GPS but not an old fix made to look fresh by transport time', () => {
        expect(validAnchorGps(fresh, now)).toBe(true);
        expect(validAnchorGps({ vessel: { ...fresh.vessel, timestamp: now } }, now)).toBe(true);
        expect(validAnchorGps({ timestamp: now, vessel: { ...fresh.vessel, timestamp: now - 36_000 } }, now)).toBe(
            false,
        );
        expect(validAnchorGps({ timestamp: now, vessel: fresh.vessel }, now)).toBe(false);
        expect(validAnchorGps({ ...fresh, gpsTimestamp: now - 35_001 }, now)).toBe(false);
        expect(validAnchorGps({ ...fresh, gpsTimestamp: now + 5_001 }, now)).toBe(false);
        expect(validAnchorGps({ ...fresh, gpsAvailable: false }, now)).toBe(false);
        expect(validAnchorGps({ ...fresh, type: 'status' }, now)).toBe(false);
        expect(validAnchorGps({ timestamp: now }, now)).toBe(false);
        expect(validAnchorGps({ ...fresh, vessel: { latitude: NaN, longitude: 149 } }, now)).toBe(false);
    });

    it.each(['contact_lost', 'gps_lost', 'session_expiring'])('never describes %s as anchor dragging', (alarm_kind) => {
        const message = anchorAlarmMessage({ alarm_kind, distance_m: 0, swing_radius_m: 0 });
        expect(message.kind).toBe(alarm_kind);
        expect(message.title).not.toContain('DRAG');
        expect(message.body).not.toContain('drifted');
    });

    it('keeps existing untyped drag events compatible', () => {
        expect(anchorAlarmMessage({ distance_m: 62.2, swing_radius_m: 50 })).toEqual({
            title: '⚓ ANCHOR DRAG ALARM',
            kind: 'drag',
            body: 'Your vessel has drifted 62m from anchor (50m swing radius). Check immediately!',
        });
    });

    it('updates only an existing live binding, capped by its owners hard session expiry', () => {
        expect(sql).toContain('FOR UPDATE');
        expect(sql).toContain('b.expires_at <= now()');
        expect(sql).toContain('s.owner_user_id = p_owner_id AND s.expires_at > now()');
        expect(sql).toContain("LEAST(now() + interval '6 hours', hard_expiry");
        expect(sql).not.toContain('UPDATE public.anchor_watch_sessions');
        expect(sql).toContain('FROM PUBLIC, anon, authenticated');
        expect(relay).toContain("body.action === 'stop'");
        expect(relay).toContain(".eq('session_code', sessionCode)");
    });

    it('persists watchdog status and alarms before attempting realtime delivery', () => {
        expect(relay).toContain("const action = body.action ?? 'broadcast'");
        expect(relay.indexOf("admin.rpc('record_pi_anchor_heartbeat'")).toBeLessThan(
            relay.indexOf('const response = await fetch'),
        );
        expect(sql).toContain("now() - interval '60 seconds'");
        expect(sql).toContain('b.contact_alarm_at IS NULL');
        expect(sql).toContain("now() + interval '15 minutes'");
        expect(sql).toContain('resolved_at IS NULL');
    });

    it('does not activate or alter any scheduled jobs in the migration', () => {
        const executable = sql
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('--'))
            .join('\n');
        expect(executable).not.toMatch(/cron\.(schedule|unschedule|alter_job)/);
    });

    it('keeps missing-token and partial-delivery events pending with original event time', () => {
        const noTokens = push.slice(push.indexOf('if (!tokens || tokens.length === 0)'), push.indexOf('// Send push'));
        expect(noTokens).toContain('releaseClaim');
        expect(noTokens).not.toContain('notified_at:');
        expect(push).toContain('notified_device_tokens');
        expect(push).toContain('results.some((result) => !result.ok)');
        expect(push).toContain('observed_at: observedAt');
        expect(push).toContain('Date.now() + 60_000');
        expect(push).toContain('Condition recovered or unconfirmed stale event');
        expect(push).toContain('alarm_kind: kind');
    });

    it('allows token upsert only for the same owner with live membership', () => {
        expect(sql).toContain('CREATE POLICY anchor_token_owner_update');
        expect(sql).toContain(
            'USING (user_id = auth.uid() AND public.is_anchor_watch_member(session_code, auth.uid()))',
        );
        expect(sql).toContain(
            'WITH CHECK (user_id = auth.uid() AND public.is_anchor_watch_member(session_code, auth.uid()))',
        );
    });
});
