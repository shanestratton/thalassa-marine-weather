/**
 * cyclone-watch — tropical cyclones near each boat (129-09).
 *
 * Runs every 30 min from pg_cron (held migration 20261014120000_cyclone_watch)
 * through invoke_edge_function with the service key. Each run:
 *   1. fetches the storms: the Esri feed's forecast positions (NHC/CPHC
 *      official, JTWC advisory elsewhere), and the GFS tracker file for any
 *      storm that feed lacks;
 *   2. finds each boat (resolveBoat): the Pi's fix (vessel_telemetry) or the
 *      fix the phone already sends (guardian_profiles' last known, which
 *      check-weather-alerts reads too) while under 72 h old, else the home
 *      port as the app reads it, else the place the weather is set to, else
 *      the older fix. Only accounts with a push device and "Cyclone warnings
 *      near the boat" not turned off. No new position is shared, and
 *      positions are read here and nowhere else;
 *   3. decides with _shared/cyclone/watch.ts (levels, the 72 h track rule,
 *      collapse, re-arming, quiet hours: tests/CycloneWatch.test.ts);
 *   4. queues the pushes in push_notification_queue (send-push delivers them,
 *      one lock-screen notification per storm), keeps the per-boat state in
 *      cyclone_watch_alerts, and writes cyclone_watch_status, which the app
 *      reads before it shows the switch.
 * A run where no source answers assesses nothing and clears nothing, and the
 * status says since when the data has been unavailable. Logs carry counts
 * only: never a position or a user id.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';
import { cycleIso, parseAdeck } from '../_shared/cyclone/adeck.ts';
import { fetchEsriForecast, fetchGfsAtcfunix } from '../_shared/cyclone/sources.ts';
import {
    type Boat,
    gcDistanceNm,
    resolveBoat,
    runWatch,
    TRACK_WINDOW_MS,
    type WatchState,
    type WatchStorm,
    watchStormsFromEsri,
} from '../_shared/cyclone/watch.ts';

const H = 3_600_000;
/** cyclone_watch_alerts.storm_key's CHECK: a key it would refuse is never stored or pushed under. */
const STORM_KEY = /^[A-Z0-9]{2,12}$/;

type Row = Record<string, unknown>;
const asRecord = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null);

/** GFS tracker storms the Esri feed does not carry (not invests): the model's track, labelled as such. */
function gfsOnlyStorms(text: string, known: WatchStorm[]): WatchStorm[] {
    const out: WatchStorm[] = [];
    for (const t of parseAdeck(text)) {
        const iso = cycleIso(t.cycle);
        if ((t.tech !== 'AVNO' && t.tech !== 'GFSO') || !iso || Number(t.storm.slice(2)) >= 90) continue;
        if (t.points[0]?.tau !== 0) continue;
        const t0 = Date.parse(iso);
        const current = { lat: t.points[0].lat, lon: t.points[0].lon };
        if (known.some((k) => k.key === t.storm || gcDistanceNm(k.current, current) < 300)) continue;
        const winds = t.points.filter((p) => p.tau * H <= TRACK_WINDOW_MS && p.vmax !== null).map((p) => p.vmax!);
        out.push({
            key: t.storm,
            name: `Tropical cyclone ${t.storm}`,
            issuer: 'GFS',
            advisory: t.cycle,
            issuedMs: t0,
            current,
            track: t.points.map((p) => ({ lat: p.lat, lon: p.lon, t: t0 + p.tau * H })),
            maxWindKts: winds.length ? Math.max(...winds) : null,
        });
    }
    return out;
}

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

        // ── 1. The storms ──
        const [esri, gfs] = await Promise.all([fetchEsriForecast(), fetchGfsAtcfunix(nowMs)]);
        const fromEsri = esri ? watchStormsFromEsri(esri) : [];
        const storms: WatchStorm[] | null = esri || gfs
            ? [...fromEsri, ...(gfs ? gfsOnlyStorms(gfs.text, fromEsri) : [])].filter((s) => STORM_KEY.test(s.key))
            : null;

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
        const out = runWatch({ storms, boats, states, nowMs });

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
            .select('unavailable_since')
            .eq('id', 1)
            .maybeSingle();
        const unavailableSince = esri ? null : (prev?.unavailable_since ?? nowIso);
        const { error: statusError } = await db.from('cyclone_watch_status').upsert({
            id: 1,
            ran_at: nowIso,
            unavailable_since: unavailableSince,
            sources: { esri: esri ? 'ok' : 'unavailable', gfs: gfs ? 'ok' : 'unavailable' },
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
