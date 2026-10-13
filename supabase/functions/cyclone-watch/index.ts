/**
 * cyclone-watch — tropical cyclones near each boat (129-09).
 *
 * Runs every 30 min from pg_cron (held migration 20261014120000_cyclone_watch)
 * through invoke_edge_function with the service key. Each run:
 *   1. fetches the storms direct from the warning centres (129-09b, no Esri,
 *      no knackwx: _shared/cyclone/sources.ts fetchCycloneFeed): NHC/CPHC's
 *      official track from NOAA, JTWC's advisory track elsewhere, then the
 *      GFS tracker file for any storm neither covers, then the centre's
 *      position alone from the storm list (NHC, JTWC, NCEP's TC vitals);
 *   2. finds each boat (resolveBoat): the Pi's fix (vessel_telemetry) or the
 *      fix the phone already sends (guardian_profiles' last known, which
 *      check-weather-alerts reads too) while under 72 h old, else the home
 *      port as the app reads it, else the place the weather is set to, else
 *      the older fix. Only accounts with a push device and "Cyclone warnings
 *      near the boat" not turned off. No new position is shared, and
 *      positions are read here and nowhere else;
 *   3. decides with _shared/cyclone/watch.ts (levels, the 72 h track rule,
 *      collapse, re-arming, quiet hours on each boat's own clock from
 *      tz-lookup here on the server: tests/CycloneWatch.test.ts);
 *   4. queues the pushes in push_notification_queue (send-push delivers them,
 *      one lock-screen notification per storm), keeps the per-boat state in
 *      cyclone_watch_alerts, and writes cyclone_watch_status, which the app
 *      reads before it shows the switch.
 * A run where no source answers assesses nothing and clears nothing, and the
 * status says since when the storm lists have been unavailable, and each
 * source since when it has. Logs carry counts only: never a position or a
 * user id.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import tzLookup from 'npm:tz-lookup@6.1.25';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';
import { parseAdeck } from '../_shared/cyclone/adeck.ts';
import { fetchCycloneFeed, fetchGfsAtcfunix } from '../_shared/cyclone/sources.ts';
import {
    type Boat,
    feedPartial,
    gfsOnlyStorms,
    positionOnlyStorms,
    resolveBoat,
    runWatch,
    type WatchState,
    type WatchStorm,
    watchStormsFromFeed,
} from '../_shared/cyclone/watch.ts';

/** cyclone_watch_alerts.storm_key's CHECK: a key it would refuse is never stored or pushed under. */
const STORM_KEY = /^[A-Z0-9]{2,12}$/;

type Row = Record<string, unknown>;
const asRecord = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null);

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

Deno.serve(async (req: Request) => {
    const denied = requireServiceRolePost(req, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (denied) return denied;
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return jsonResponse({ error: 'Server database is not configured' }, 500);

    try {
        const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();

        // ── 1. The storms: the issuer's track, else GFS's, else the centre's position ──
        const [feed, gfs] = await Promise.all([fetchCycloneFeed(nowMs), fetchGfsAtcfunix(nowMs)]);
        const tracked = feed ? watchStormsFromFeed(feed.storms) : [];
        const names = new Map((feed?.storms ?? []).map((s) => [s.key, s.name]));
        const modelled = gfs ? gfsOnlyStorms(parseAdeck(gfs.text), tracked, names) : [];
        const covered = new Set([...tracked, ...modelled].map((s) => s.key));
        const positions = feed ? positionOnlyStorms(feed.storms).filter((s) => !covered.has(s.key)) : [];
        const storms: WatchStorm[] | null = feed || gfs
            ? [...tracked, ...modelled, ...positions].filter((s) => STORM_KEY.test(s.key))
            : null;
        // A storm list, NOAA's or JTWC's tracks, or a JTWC warning no list places: part of the feed is not answering.
        const partial = feedPartial(feed);

        // ── 2. Prior state ──
        const states = new Map<string, WatchState>();
        for (let from = 0;; from += 1000) {
            const { data, error } = await db
                .from('cyclone_watch_alerts')
                .select('user_id, storm_key, state')
                .order('user_id')
                .order('storm_key')
                .range(from, from + 999);
            if (error) throw new Error('state read failed');
            for (const r of data ?? []) {
                const st = asRecord(r.state);
                if (st) states.set(`${r.user_id}|${r.storm_key}`, st as unknown as WatchState);
            }
            if ((data ?? []).length < 1000) break;
        }

        // ── 3. The boats ──
        const boats: Boat[] = [];
        let phoneFailed = 0;
        if ((storms && storms.length > 0) || states.size > 0) {
            const users = new Set<string>();
            for (let from = 0;; from += 1000) {
                const { data, error } = await db
                    .from('push_device_tokens')
                    .select('user_id')
                    .order('id')
                    .range(from, from + 999);
                if (error) throw new Error('device read failed');
                for (const r of data ?? []) if (typeof r.user_id === 'string') users.add(r.user_id);
                if ((data ?? []).length < 1000) break;
            }
            for (const ids of chunk([...users], 200)) {
                const [settingsRes, fixRes, phoneRes, deletingRes] = await Promise.all([
                    db.from('user_settings').select('user_id, settings').in('user_id', ids),
                    db.from('vessel_telemetry').select('owner_id, lat, lon, reported_at').in('owner_id', ids),
                    // The phone's own last fix, already sent for Guardian (check-weather-alerts reads it too).
                    db
                        .from('guardian_profiles')
                        .select('user_id, last_known_lat, last_known_lon, last_known_at')
                        .in('user_id', ids),
                    // An account mid-deletion is write-fenced: never queue for it.
                    db.from('account_deletion_jobs').select('user_id').in('user_id', ids),
                ]);
                if (settingsRes.error || fixRes.error || deletingRes.error) throw new Error('boat read failed');
                // A Guardian read failure loses only that fallback, never the run.
                if (phoneRes.error) phoneFailed++;
                const settings = new Map((settingsRes.data ?? []).map((r) => [r.user_id, asRecord(r.settings)]));
                const fixes = new Map((fixRes.data ?? []).map((r) => [r.owner_id, r]));
                const phones = new Map((phoneRes.error ? [] : phoneRes.data ?? []).map((r) => [r.user_id, r]));
                const deleting = new Set((deletingRes.data ?? []).map((r) => r.user_id));
                for (const userId of ids) {
                    if (deleting.has(userId)) continue;
                    const fix = fixes.get(userId);
                    const phone = phones.get(userId);
                    const boat = resolveBoat(
                        userId,
                        {
                            settings: settings.get(userId) ?? null,
                            telemetry: fix ? { lat: fix.lat, lon: fix.lon, at: fix.reported_at } : null,
                            phone: phone
                                ? { lat: phone.last_known_lat, lon: phone.last_known_lon, at: phone.last_known_at }
                                : null,
                        },
                        nowMs,
                    );
                    if (boat) boats.push(boat);
                }
            }
        }

        // ── 4. Decide ──
        const out = runWatch({ storms, boats, states, nowMs, partial, zoneAt: tzLookup });

        // ── 5. Queue the pushes, then keep the state of those that queued ──
        // One row at a time: each insert posts to send-push at once, and one
        // refused row must not hold back another boat's warning.
        const failed = new Set<string>();
        for (const p of out.pushes) {
            const { error } = await db.from('push_notification_queue').insert({
                recipient_user_id: p.userId,
                notification_type: p.type,
                title: p.title,
                body: p.body,
                data: p.data,
            });
            if (error) failed.add(`${p.userId}|${p.data.storm_key}`);
        }
        const upserts: Row[] = [];
        for (const [id, st] of out.states) {
            const prior = states.get(id);
            const keep = failed.has(id) ? prior : st;
            if (!keep || JSON.stringify(keep) === JSON.stringify(prior)) continue;
            const [user_id, storm_key] = id.split('|');
            upserts.push({ user_id, storm_key, state: keep, updated_at: nowIso });
        }
        // In batches; a refused batch (the account-deletion fence, for one
        // user mid-deletion) is retried row by row, so one refused row cannot
        // unsave the rest and re-send their pushes next run.
        let refused = 0;
        for (const batch of chunk(upserts, 500)) {
            const { error } = await db.from('cyclone_watch_alerts').upsert(batch, { onConflict: 'user_id,storm_key' });
            if (!error) continue;
            for (const row of batch) {
                const { error: rowError } = await db
                    .from('cyclone_watch_alerts')
                    .upsert(row, { onConflict: 'user_id,storm_key' });
                if (rowError) refused++;
            }
        }
        for (const id of states.keys()) {
            if (out.states.has(id)) continue;
            const [user_id, storm_key] = id.split('|');
            await db.from('cyclone_watch_alerts').delete().eq('user_id', user_id).eq('storm_key', storm_key);
        }

        // ── 6. Answer: the app shows the switch once this row exists ──
        const { data: prev } = await db
            .from('cyclone_watch_status')
            .select('unavailable_since, sources')
            .eq('id', 1)
            .maybeSingle();
        // Unavailable while no storm list answers; GFS alone is a model, not the list.
        const unavailableSince = feed ? null : (prev?.unavailable_since ?? nowIso);
        // Each source, and since when it has not answered (kept from the run before).
        const before = asRecord(prev?.sources) ?? {};
        const now: Record<string, string> = {
            nhc: feed?.sources.nhc ?? 'unavailable',
            jtwc: feed?.sources.jtwc ?? 'unavailable',
            vitals: feed?.sources.vitals ?? 'unavailable',
            noaa: feed?.sources.noaa ?? 'unavailable',
            jtwcTracks: feed?.sources.jtwcTracks ?? 'unavailable',
            gfs: gfs ? 'ok' : 'unavailable',
        };
        const sources: Row = {};
        for (const [name, status] of Object.entries(now)) {
            const was = asRecord(before[name]);
            sources[name] = status === 'unavailable'
                ? { unavailable_since: typeof was?.unavailable_since === 'string' ? was.unavailable_since : nowIso }
                : status;
        }
        const { error: statusError } = await db.from('cyclone_watch_status').upsert({
            id: 1,
            ran_at: nowIso,
            unavailable_since: unavailableSince,
            sources,
            storms: storms?.length ?? null,
            pushes: out.pushes.length - failed.size,
        });
        if (statusError) throw new Error('status write failed');

        console.log(
            `[cyclone-watch] storms=${
                storms?.length ?? 'unavailable'
            } boats=${boats.length} pushes=${out.pushes.length} failed=${failed.size} refused=${refused} guardian_failed=${phoneFailed}`,
        );
        return jsonResponse({
            storms: storms?.length ?? null,
            boats: boats.length,
            pushes: out.pushes.length - failed.size,
            unavailable_since: unavailableSince,
        });
    } catch (e) {
        console.error('[cyclone-watch] run failed:', e instanceof Error ? e.message : 'unknown');
        return jsonResponse({ error: 'Cyclone watch failed' }, 500);
    }
});
