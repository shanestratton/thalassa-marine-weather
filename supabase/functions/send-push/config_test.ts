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
    getInterruptionLevel,
    getThreadId,
    isCriticalType,
    isStaleForDelivery,
    OFFICIAL_WARNING_DEFAULT_TTL_SECONDS,
    OFFICIAL_WARNING_MAX_TTL_SECONDS,
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
    // 129-08 gave the quiet boat a thread of its own (below).
    assertEquals(getThreadId('boat_quiet'), 'thalassa-boat');
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

// Cyclones near the boat (129-09, cyclone-watch). Urgent (300 NM, or the
// forecast track within 72 h) is a safety type; a notice (600 NM) is not.
// One lock-screen notification per storm, the newest replacing the last, and
// an urgent cyclone is still news hours later, so it is not dropped at once.
Deno.test('cyclone urgent is a safety type, the notice is not, and both thread together', () => {
    assertEquals(isCriticalType('cyclone_urgent'), true);
    assertEquals(isCriticalType('cyclone_notice'), false);
    assertEquals(getThreadId('cyclone_urgent'), 'thalassa-cyclone');
    assertEquals(getThreadId('cyclone_notice'), 'thalassa-cyclone');
    assertEquals(getAlertSound('cyclone_urgent'), 'default');
});

Deno.test('one notification per storm: the urgent push replaces the notice', () => {
    assertEquals(getCollapseId('cyclone_notice', { storm_key: 'SH37' }), 'cyclone-SH37');
    assertEquals(getCollapseId('cyclone_urgent', { storm_key: 'SH37' }), 'cyclone-SH37');
    assertEquals(getCollapseId('cyclone_urgent', { storm_key: 'x'.repeat(80) }), null);
    assertEquals(getCollapseId('cyclone_urgent', {}), null);
});

Deno.test('an urgent cyclone stays deliverable for 6 h; a notice for the default 6 h', () => {
    assertEquals(getApnsExpiration('cyclone_urgent', true, NOW), String(NOW_S + 6 * 60 * 60));
    assertEquals(getApnsExpiration('cyclone_notice', false, NOW), String(NOW_S + 6 * 60 * 60));
    assertEquals(isStaleForDelivery('cyclone_urgent', new Date(NOW - 60 * 60_000).toISOString(), NOW), false);
});

// Official warnings at the boat (129-06, official-alerts-watch). One
// lock-screen notification per warning and its updates (collapse id
// provider:chain); kept by APNs until the warning expires and dropped after
// it; Time Sensitive for Severe and Extreme, never Critical (that is for the
// boat's own alarms); an update that does not raise the severity replaces the
// notification without a sound.
Deno.test('an official warning has its own thread and collapses to one per warning', () => {
    assertEquals(getThreadId('official_warning'), 'thalassa-official');
    assertEquals(isCriticalType('official_warning'), false);
    assertEquals(getCollapseId('official_warning', { collapse: 'nws:0123456789abcdef' }), 'nws:0123456789abcdef');
    assertEquals(
        getCollapseId('official_warning', { collapse: 'meteoalarm-gr:0123456789abcdef' }),
        'meteoalarm-gr:0123456789abcdef',
    );
    assertEquals(getCollapseId('official_warning', { collapse: 'nws:urn:oid:2.49.0.1.840.0.zz' }), null);
    assertEquals(getCollapseId('official_warning', { collapse: 'NWS:0123456789abcdef' }), null);
    assertEquals(getCollapseId('official_warning', {}), null);
});

Deno.test('TTL is the warning’s own expiry, capped, and a default without one', () => {
    const in3h = new Date(NOW + 3 * 3_600_000).toISOString();
    assertEquals(getApnsExpiration('official_warning', false, NOW, { expires: in3h }), String(NOW_S + 3 * 3600));
    const in30d = new Date(NOW + 30 * 86_400_000).toISOString();
    assertEquals(
        getApnsExpiration('official_warning', false, NOW, { expires: in30d }),
        String(NOW_S + OFFICIAL_WARNING_MAX_TTL_SECONDS),
    );
    assertEquals(OFFICIAL_WARNING_MAX_TTL_SECONDS, 7 * 86400);
    assertEquals(
        getApnsExpiration('official_warning', false, NOW, {}),
        String(NOW_S + OFFICIAL_WARNING_DEFAULT_TTL_SECONDS),
    );
    assertEquals(getApnsExpiration('official_warning', false, NOW, { expires: 'soon' }), String(NOW_S + 6 * 3600));
    // Expired before the drain reached it: not delivered at all.
    const past = new Date(NOW - 60_000).toISOString();
    assertEquals(isStaleForDelivery('official_warning', new Date(NOW).toISOString(), NOW, { expires: past }), true);
    assertEquals(isStaleForDelivery('official_warning', new Date(NOW).toISOString(), NOW, { expires: in3h }), false);
    assertEquals(isStaleForDelivery('official_warning', new Date(NOW).toISOString(), NOW, {}), false);
});

Deno.test('Time Sensitive for Severe and Extreme, never Critical; an update without a rise is silent', () => {
    assertEquals(getInterruptionLevel('official_warning', { severity: 'Severe' }), 'time-sensitive');
    assertEquals(getInterruptionLevel('official_warning', { severity: 'Extreme' }), 'time-sensitive');
    assertEquals(getInterruptionLevel('official_warning', { severity: 'Moderate' }), 'active');
    assertEquals(getInterruptionLevel('official_warning', { severity: 'Minor' }), 'active');
    assertEquals(getInterruptionLevel('official_warning', { severity: 'Extreme', silent: true }), 'passive');
    assertEquals(getInterruptionLevel('cyclone_urgent', { severity: 'Extreme' }), undefined);

    const base = { title: 'Gale Warning', body: 'Gale Warning issued … (fictional)', type: 'official_warning' };
    // Even where Apple granted Critical Alerts, an official warning stays Time Sensitive.
    const severe = buildAps({ ...base, threadId: 'thalassa-official', level: 'time-sensitive' }, true);
    assertEquals(severe['interruption-level'], 'time-sensitive');
    assertEquals(severe.sound, 'default');
    const quiet = buildAps({ ...base, threadId: 'thalassa-official', level: 'passive' }, true);
    assertEquals(quiet['interruption-level'], 'passive');
    assertEquals('sound' in quiet, false);
    const advisory = buildAps({ ...base, threadId: 'thalassa-official', level: 'active' }, false);
    assertEquals(advisory['interruption-level'], 'active');
    assertEquals(advisory.sound, 'default');
});

Deno.test('the quiet boat (129-08): one notification per boat, the page Time Sensitive, the all-clear quietly over it', () => {
    const collapse = '0123456789abcdef';
    for (const type of ['boat_quiet', 'boat_quiet_clear']) {
        assertEquals(isCriticalType(type), false, type);
        assertEquals(getThreadId(type), 'thalassa-boat', type);
        assertEquals(getCollapseId(type, { collapse }), `boat-quiet-${collapse}`, type);
        // A quiet boat is still news hours later: the default 6 h, never the safety alarms' 0.
        assertEquals(getApnsExpiration(type, false, NOW), String(NOW_S + 6 * 60 * 60), type);
        assertEquals(isStaleForDelivery(type, new Date(NOW - 50 * 60_000).toISOString(), NOW), false, type);
        // A malformed key collapses nothing: one per boat or not at all.
        for (const bad of [undefined, '', 'NOT-HEX-0123456789', '0123456789abcdef0', 42]) {
            assertEquals(getCollapseId(type, { collapse: bad }), null, `${type} ${String(bad)}`);
        }
    }
    // A page goes at once, day or night, through Focus where allowed; never Critical.
    assertEquals(getInterruptionLevel('boat_quiet', {}), 'time-sensitive');
    // The all-clear replaces it as an ordinary alert, so Sleep Focus keeps it quiet.
    assertEquals(getInterruptionLevel('boat_quiet_clear', {}), 'active');
    const page = buildAps(
        {
            title: 'Kestrel’s Pi is offline, or the boat’s internet is down',
            body: 'b',
            type: 'boat_quiet',
            threadId: 'thalassa-boat',
            level: getInterruptionLevel('boat_quiet', {}),
        },
        true,
    );
    assertEquals(page['interruption-level'], 'time-sensitive');
    assertEquals(page.sound, 'default');
    const clear = buildAps(
        {
            title: 'Kestrel is reporting again',
            body: 'b',
            type: 'boat_quiet_clear',
            threadId: 'thalassa-boat',
            level: 'active',
        },
        true,
    );
    assertEquals(clear['interruption-level'], 'active');
});
