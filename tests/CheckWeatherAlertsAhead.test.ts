/**
 * check-weather-alerts as deployed (129-07): the edge function reads the
 * accounts, fetches in batches, and writes what the pure decisions return
 * (supabase/functions/_shared/forecast-alerts/lookahead.ts,
 * tests/ForecastAlertsAhead.test.ts). These are the wiring rules a source
 * read can hold it to:
 *   - every Open-Meteo request is built by requestParams, so every one pins
 *     its models, and the places go in batches, not one request each;
 *   - the silent 60-request cap is gone: places past the run's hard ceiling
 *     are counted, logged and reported, never skipped in silence;
 *   - every page of user_settings is read (PostgREST answers 1000 rows a
 *     request and cuts the rest off without an error), and only the six
 *     settings the check uses;
 *   - over the ceiling the places rotate, and a skipper who waits is told;
 *   - an alert is covered only by an official warning this skipper was
 *     sent (official_alert_deliveries), and a push claims the weaker
 *     strengths of its day too;
 *   - the boat's clock is tz-lookup on the server, and the official warnings
 *     at each place come from official_alerts_watch_match;
 *   - nothing logs a position, a URL or the key.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const edge = readFileSync('supabase/functions/check-weather-alerts/index.ts', 'utf8');

describe('check-weather-alerts looks ahead in batches', () => {
    it('builds every request with the shared, model-pinned builder, a batch at a time', () => {
        expect(edge).toContain("from '../_shared/forecast-alerts/lookahead.ts'");
        expect(edge).toMatch(/requestParams\(kind, batch\)/);
        expect(edge).toMatch(/batchPoints\(/);
        expect(edge).toContain("ahead: 'https://customer-api.open-meteo.com/v1/forecast'");
        expect(edge).toContain("sea: 'https://customer-marine-api.open-meteo.com/v1/marine'");
        expect(edge).toContain("now: 'https://customer-api.open-meteo.com/v1/forecast'");
        // No request is built by hand any more.
        expect(edge).not.toMatch(/current: WEATHER_VARS/);
        expect(edge).not.toMatch(/new URLSearchParams\(\{\s*latitude:/);
    });

    it('has no silent cap: a run over its ceiling says so, and reports the count', () => {
        expect(edge).not.toContain('MAX_WEATHER_REQS');
        expect(edge).toContain('MAX_PLACES_PER_RUN');
        expect(edge).toMatch(/console\.warn\(\s*`\[check-weather-alerts\] \$\{skipped\} places over the run's ceiling/);
        expect(edge).toMatch(/skipped,/);
    });

    it('reads every page of user_settings, and only the six settings it uses', () => {
        // Not the whole settings blob of every account into the function's memory.
        expect(edge).not.toContain(".select('user_id, settings')");
        for (const path of [
            'notifications:settings->notifications',
            'units:settings->units',
            'coords:settings->defaultLocationCoords',
            'place:settings->defaultLocation',
            'hours:settings->alertLookaheadHours',
            'good_window:settings->goodWindowAlerts',
        ]) {
            expect(edge).toContain(path);
        }
        expect(edge).toMatch(/\.select\(SETTINGS_COLUMNS\)/);
        expect(edge).toMatch(/readAllRows(<[^>]+>)?\(/);
        expect(edge).toMatch(/\.order\('user_id'\)\s*\.range\(from, to\)/);
    });

    it('over its ceiling, rotates the places and tells the skippers who wait, instead of dropping their status', () => {
        expect(edge).toMatch(/placesThisRun\(/);
        expect(edge).toMatch(/statusRows\.set\([^;]*overCapacityLine\(/s);
    });

    it('covers an alert only with an official warning this skipper was sent', () => {
        expect(edge).toContain(".from('official_alert_deliveries')");
        expect(edge).toMatch(/\.eq\('channel', 'push'\)/);
        expect(edge).toMatch(/deliveredOfficial\(/);
        // Every in-force warning at the place still holds a good window back.
        expect(edge).toMatch(/officialAtPlace/);
    });

    it('claims the weaker strengths of the day with a push, so an easing forecast stays quiet', () => {
        // Once the push is queued: one upsert of those keys, ignoring any already claimed.
        expect(edge).toMatch(
            /alertsQueued\+\+;[^]*?from\('weather_alerts_log'\)\.upsert\(\s*push\.alsoClaims\.map\([^]*?ignoreDuplicates: true/,
        );
    });

    it('reads the hour under way from hourly series, and the sea at the place it asked', () => {
        expect(edge).toMatch(/readNow\(/);
        expect(edge).not.toMatch(/readCurrent\(/);
        expect(edge).toMatch(/waveChain\([^;]*\{\s*lat: c\.place\.lat,\s*lon: c\.place\.lon,?\s*\}/s);
    });

    it('keeps the boat’s clock on the server, and asks which official warnings cover each place', () => {
        expect(edge).toContain("import tzLookup from 'npm:tz-lookup@6.1.25';");
        expect(edge).toMatch(/boatZone\(\{ lat: [^}]+\}, tzLookup\)/);
        expect(edge).toContain("db.rpc('official_alerts_watch_match', { p_points: points })");
        // Without the 129-06 migration the match is absent: the alert is sent, not lost.
        expect(edge).toMatch(/official warnings unavailable this run/);
    });

    it('claims each push once, as before, and sends the look-ahead decision’s own type and text', () => {
        expect(edge).toContain("{ onConflict: 'user_id,alert_key', ignoreDuplicates: true }");
        expect(edge).toMatch(/notification_type: push\.type/);
        expect(edge).toMatch(/title: push\.title/);
        expect(edge).toMatch(/body: push\.body/);
        expect(edge).toMatch(/decideForAccount\(/);
    });

    it('never logs a position, a user id in full, a URL or the key', () => {
        expect(edge).not.toMatch(/console\.\w+\([^)]*\b(lat|lon|position)\b/);
        expect(edge).not.toMatch(/console\.\w+\([^;]*userId\b(?!\.slice)/);
        expect(edge).not.toMatch(/console\.\w+\([^;]*\b(url|query|apikey)\b/i);
    });

    it('answers the cron with the version, the call volume and the counts', () => {
        expect(edge).toMatch(/version: FORECAST_ALERTS_VERSION/);
        expect(edge).toMatch(/estimateCallVolume\(/);
        expect(edge).toMatch(/held,/);
        expect(edge).toMatch(/covered,/);
    });
});
