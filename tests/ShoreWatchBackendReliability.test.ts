import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    anchorAlarmMessage,
    phoneWatchAlarmCurrent,
    piWatchEndsSoon,
    validAnchorGps,
} from '../supabase/functions/_shared/anchor-alarm';

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

// ── 126-03b: the phone keeping the watch, and a watch that runs for a week ──
describe('Shore Watch when the boat phone keeps the watch (126-03b)', () => {
    const MIN = 60_000;
    const DAY = 24 * 60 * MIN;
    /** The phone branch of send-anchor-alarm, from its test to its else, code only. */
    const phoneBranch = (() => {
        const start = push.indexOf('if (phoneKept) {');
        return start < 0
            ? ''
            : push
                  .slice(start, push.indexOf('} else {', start))
                  .split('\n')
                  .filter((line) => !line.trimStart().startsWith('//'))
                  .join('\n');
    })();
    const piBranch = (() => {
        const start = push.indexOf('if (phoneKept) {');
        const elseAt = start < 0 ? -1 : push.indexOf('} else {', start);
        return elseAt < 0 ? '' : push.slice(elseAt, push.indexOf('if (!stillRelevant)', elseAt));
    })();

    it('says the phone has stopped checking in, never that the anchor dragged', () => {
        const message = anchorAlarmMessage({ alarm_kind: 'contact_lost', watchkeeper: 'phone', distance_m: 0 });
        expect(message).toEqual({
            kind: 'contact_lost',
            title: '⚓ SHORE WATCH — CONTACT LOST',
            body: 'The phone keeping the anchor watch has stopped checking in. The anchor position cannot be confirmed. Check the boat and the phone immediately.',
        });
        // A Pi's (legacy NULL) contact loss keeps its own words.
        expect(anchorAlarmMessage({ alarm_kind: 'contact_lost' }).body).toBe(
            'The boat has stopped reporting. Its anchor position cannot be confirmed. Check the boat and its connection immediately.',
        );
    });

    it('warns "ends soon" in words a crew member can act on', () => {
        expect(anchorAlarmMessage({ alarm_kind: 'session_expiring' })).toEqual({
            kind: 'session_expiring',
            title: '⚓ SHORE WATCH — ENDS SOON',
            body: 'The Pi keeping the anchor watch stops within 12 hours unless the skipper opens Thalassa on the phone that handed it the watch.',
        });
    });

    it.each([
        ['a beat 6 min old while watching', { heartbeatAt: -6 * MIN, vesselState: 'watching' }, true],
        ['a beat 4 min old (it came back)', { heartbeatAt: -4 * MIN, vesselState: 'watching' }, false],
        ['a weighed anchor (ended)', { heartbeatAt: null, vesselState: 'ended' }, false],
        ['a session that never had a phone beat', { heartbeatAt: null, vesselState: null }, false],
    ])('sends a phone contact-lost page only while the phone is still quiet: %s', (_label, row, expected) => {
        const now = Date.parse('2026-10-10T02:00:00Z');
        expect(
            phoneWatchAlarmCurrent({
                kind: 'contact_lost',
                createdAt: now - 30_000,
                heartbeatAt: row.heartbeatAt === null ? null : now + row.heartbeatAt,
                vesselState: row.vesselState,
                now,
            }),
        ).toBe(expected);
    });

    it("judges the phone's own drag push on time alone (120 s), never against a Pi binding", () => {
        const now = Date.parse('2026-10-10T02:00:00Z');
        const drag = (age: number) =>
            phoneWatchAlarmCurrent({ kind: 'drag', createdAt: now - age, heartbeatAt: null, vesselState: null, now });
        expect(drag(60_000)).toBe(true);
        expect(drag(120_000)).toBe(true);
        expect(drag(121_000)).toBe(false);
        expect(phoneBranch).toContain('phoneWatchAlarmCurrent(');
        expect(phoneBranch).not.toMatch(/pi_anchor_sessions|pi_diary_relays|binding/);
    });

    it('reads the phone columns only for phone rows, so a function deployed before the DB push still delivers', () => {
        expect(push).toContain("const phoneKept = record.watchkeeper === 'phone';");
        expect(push).toContain(
            "const sessionColumns: string = phoneKept ? 'expires_at,vessel_heartbeat_at,vessel_state' : 'expires_at';",
        );
        expect(push).toContain('.select(sessionColumns)');
    });

    it('keeps legacy (NULL watchkeeper) rows on the Pi path exactly as before', () => {
        expect(piBranch).toContain(".from('pi_anchor_sessions')");
        expect(piBranch).toContain(
            'stillRelevant = !record.pi_relay_id && Date.now() - Date.parse(record.created_at) <= 120_000;',
        );
        expect(piBranch).toContain('? !!fresh && binding.gps_available && binding.is_dragging');
        expect(piBranch).toContain('? Date.now() - heartbeat > 60_000');
    });

    it('warns "ends soon" from the Pi lease cap (authorised_at + 7 days), 12 hours out', () => {
        const now = Date.parse('2026-10-10T02:00:00Z');
        expect(piWatchEndsSoon(now - 6.4 * DAY, now)).toBe(false);
        expect(piWatchEndsSoon(now - 6.5 * DAY, now)).toBe(true);
        expect(piWatchEndsSoon(Number.NaN, now)).toBe(false);
        expect(piBranch).toContain(
            "select('relay_id,last_heartbeat_at,gps_available,is_dragging,expires_at,authorised_at')",
        );
        expect(piBranch).toContain('piWatchEndsSoon(Date.parse(binding.authorised_at), Date.now())');
        // Kept only so a function deployed ahead of the DB push still warns before a 24 h session ends.
        expect(piBranch).toContain('Date.parse(session.expires_at) - Date.now() <= 15 * 60_000');
    });
});
