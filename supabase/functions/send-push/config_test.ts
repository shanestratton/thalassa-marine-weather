/**
 * send-push's per-type APNs settings (build 126, package 126-04b adds the
 * Pi's three types). The two Pi alarms are safety types: Time Sensitive, or
 * Critical only when Apple has granted the entitlement; the anchor alarm's
 * own sound; one notification per vessel on the lock screen. A collision
 * alarm is never delivered late (expiry '0', and a queue row older than a
 * few minutes is dropped); a distress beacon stays relevant for 10 minutes.
 * The Pi's notices are ordinary. Every type that existed before is unchanged.
 */
import {
    buildAps,
    getAlertSound,
    getApnsExpiration,
    getCollapseId,
    getThreadId,
    isCriticalType,
    isStaleForDelivery,
    PI_ALARM_SOUND,
} from './config.ts';

function assertEquals(actual: unknown, expected: unknown, note = ''): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`${note} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const NOW = Date.UTC(2026, 9, 9, 16, 14, 0);
const NOW_S = Math.floor(NOW / 1000);

Deno.test('the two Pi alarms are safety types; the Pi notice is not', () => {
    assertEquals(isCriticalType('collision_alarm'), true);
    assertEquals(isCriticalType('distress_alarm'), true);
    assertEquals(isCriticalType('pi_watch_notice'), false);
});

Deno.test('Time Sensitive without the entitlement, Critical with it, with the anchor alarm sound', () => {
    const payload = { title: 'Collision risk: NORDLICHT', body: 'CPA 0.08 NM in 4 min.', type: 'collision_alarm' };
    const plain = buildAps({ ...payload, isCritical: true, threadId: 'thalassa-collision' }, false);
    assertEquals(plain['interruption-level'], 'time-sensitive');
    assertEquals(plain.sound, PI_ALARM_SOUND);
    assertEquals(PI_ALARM_SOUND, 'thalassa-anchor-alarm.wav');
    const entitled = buildAps({ ...payload, isCritical: true, threadId: 'thalassa-collision' }, true);
    assertEquals(entitled['interruption-level'], 'critical');
    assertEquals(entitled.sound, { critical: 1, name: PI_ALARM_SOUND, volume: 1.0 });
    const distress = buildAps(
        { title: 'Distress', body: 'x', type: 'distress_alarm', isCritical: true, threadId: 'thalassa-distress' },
        false,
    );
    assertEquals(distress.sound, PI_ALARM_SOUND);
    const notice = buildAps(
        { title: 'Night watch blind', body: 'x', type: 'pi_watch_notice', isCritical: false, threadId: 'x' },
        true,
    );
    assertEquals(notice['interruption-level'], 'active');
    assertEquals(notice.sound, 'default');
    assertEquals(getAlertSound('pi_watch_notice'), 'default');
});

Deno.test('one notification per vessel: collapse by MMSI, threads of their own', () => {
    assertEquals(getCollapseId('collision_alarm', { mmsi: 211000001 }), 'collision-211000001');
    assertEquals(getCollapseId('distress_alarm', { mmsi: 970000003 }), 'distress-970000003');
    assertEquals(getCollapseId('collision_alarm', {}), null);
    assertEquals(getCollapseId('collision_alarm', { mmsi: 'x;rm' }), null, 'only a real MMSI');
    assertEquals(getCollapseId('pi_watch_notice', { mmsi: 211000001 }), null);
    assertEquals(getThreadId('collision_alarm'), 'thalassa-collision');
    assertEquals(getThreadId('distress_alarm'), 'thalassa-distress');
    assertEquals(getThreadId('pi_watch_notice'), 'thalassa-general');
});

Deno.test('a collision alarm expires at once; a distress after 10 min; the notice after the default 6 h', () => {
    assertEquals(getApnsExpiration('collision_alarm', true, NOW), '0');
    assertEquals(getApnsExpiration('distress_alarm', true, NOW), String(NOW_S + 10 * 60));
    assertEquals(getApnsExpiration('pi_watch_notice', false, NOW), String(NOW_S + 6 * 60 * 60));
});

Deno.test('a Pi alarm row the retry drain finds late is dropped, not delivered as news', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    assertEquals(isStaleForDelivery('collision_alarm', iso(NOW - 60_000), NOW), false);
    assertEquals(isStaleForDelivery('collision_alarm', iso(NOW - 3 * 60_000 - 1), NOW), true);
    assertEquals(isStaleForDelivery('distress_alarm', iso(NOW - 9 * 60_000), NOW), false);
    assertEquals(isStaleForDelivery('distress_alarm', iso(NOW - 10 * 60_000 - 1), NOW), true);
    // Every other type keeps the drain's own one-hour fence.
    assertEquals(isStaleForDelivery('anchor_alarm', iso(NOW - 50 * 60_000), NOW), false);
    assertEquals(isStaleForDelivery('pi_watch_notice', iso(NOW - 50 * 60_000), NOW), false);
    assertEquals(isStaleForDelivery('collision_alarm', 'not a date', NOW), false);
});

Deno.test('every type that existed before is unchanged', () => {
    for (
        const type of [
            'anchor_alarm',
            'bolo_alert',
            'suspicious_alert',
            'drag_warning',
            'geofence_alert',
            'severe_weather_alert',
        ]
    ) {
        assertEquals(isCriticalType(type), true, type);
        assertEquals(getAlertSound(type), 'default', type);
        assertEquals(getApnsExpiration(type, true, NOW), '0', type);
    }
    for (const type of ['dm', 'sos', 'hail', 'pin_drop', 'weather_alert', 'boat_quiet', 'watch_schedule_published']) {
        assertEquals(isCriticalType(type), false, type);
        assertEquals(getAlertSound(type), 'default', type);
    }
    assertEquals(getThreadId('dm'), 'thalassa-messages');
    assertEquals(getThreadId('anchor_alarm'), 'thalassa-anchor');
    assertEquals(getThreadId('drag_warning'), 'thalassa-guardian');
    assertEquals(getThreadId('weather_alert'), 'thalassa-weather');
    assertEquals(getThreadId('hail'), 'thalassa-social');
    assertEquals(getThreadId('boat_quiet'), 'thalassa-general');
    assertEquals(getCollapseId('bolo_alert', { mmsi: 211000001 }), 'bolo-211000001');
    assertEquals(getCollapseId('geofence_alert', { mmsi: 211000001 }), 'geofence-211000001');
    assertEquals(getCollapseId('anchor_alarm', {}), 'anchor-alarm');
    assertEquals(getCollapseId('dm', { mmsi: 211000001 }), null);
    assertEquals(getApnsExpiration('dm', false, NOW), String(NOW_S + 24 * 60 * 60));
    assertEquals(getApnsExpiration('weather_alert', false, NOW), String(NOW_S + 60 * 60));
    assertEquals(getApnsExpiration('boat_quiet', false, NOW), String(NOW_S + 6 * 60 * 60));
    const plain = buildAps({
        title: 't',
        body: 'b',
        type: 'dm',
        isCritical: false,
        threadId: 'thalassa-messages',
        badge: 3,
    }, true);
    assertEquals(plain, {
        alert: { title: 't', body: 'b' },
        'thread-id': 'thalassa-messages',
        badge: 3,
        sound: 'default',
        'interruption-level': 'active',
    });
    const anchor = buildAps({
        title: 't',
        body: 'b',
        type: 'anchor_alarm',
        isCritical: true,
        threadId: 'thalassa-anchor',
    }, true);
    assertEquals(anchor.sound, { critical: 1, name: 'default', volume: 1.0 });
    assertEquals(anchor['interruption-level'], 'critical');
});
