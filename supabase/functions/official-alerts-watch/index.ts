/**
 * official-alerts-watch — official marine warnings at each boat, to its lock
 * screen (129-06).
 *
 * Runs every 5 min from pg_cron (held migration 20261014160000, two minutes
 * after each ingest-official-alerts run) through invoke_edge_function with
 * the service key. Its own function, not a step of the ingest: the ingest
 * reads public feeds only, sharded and bounded in time, and this reads
 * accounts and boat positions; apart, neither can stall or leak into the
 * other. Each run:
 *   1. finds each boat as cyclone-watch does (resolveBoat): the Pi's fix or
 *      the fix the phone already sends for Guardian while under 72 h old,
 *      else the home port as the app reads it, else the place the weather is
 *      set to, else the older fix. Only accounts with a push device, not
 *      mid-deletion, with "Official marine warnings at the boat" not off;
 *   2. asks official_alerts_watch_match once per 500 boats for the warnings
 *      in force at each (polygon or zone, a marine one within 3 NM, enabled
 *      issuers, never withdrawn or expired; one row per boat, so PostgREST's
 *      1000-row cap never cuts a reply), and reads those warnings and every
 *      page of the deliveries so far (_shared/official-alerts/watchReads.ts);
 *   3. decides with _shared/official-alerts/watch.ts (marine and coastal
 *      only; Severe and Extreme at once; advisories wait out 22:00-07:00 at
 *      the boat unless they begin within 3 h; once per account per warning,
 *      updates quietly unless the severity rises);
 *   4. queues each push in push_notification_queue (send-push delivers it as
 *      official_warning: collapse id provider:chain, TTL its expiry, Time
 *      Sensitive for Severe and Extreme), records each that queued in
 *      official_alert_deliveries, and writes official_alerts_watch_status,
 *      which the app reads before it shows its switches.
 * A boat's position goes to the database's match and nowhere else: it is
 * never stored, pushed or logged. Logs carry counts only, never a position
 * or a user id.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import tzLookup from 'npm:tz-lookup@6.1.25';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';
import type { StoredInfo } from '../_shared/official-alerts/normalize.ts';
import {
    decideOfficialPushes,
    officialWatchBoat,
    type WatchAlert,
    type WatchedBoat,
} from '../_shared/official-alerts/watch.ts';
import { matchBoats, readPriorDeliveries } from '../_shared/official-alerts/watchReads.ts';

type Row = Record<string, unknown>;
const asRecord = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

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

        // ── 1. The boats ──
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
        const boats: WatchedBoat[] = [];
        let phoneFailed = 0;
        for (const ids of chunk([...users], 200)) {
            const [settingsRes, fixRes, phoneRes, deletingRes] = await Promise.all([
                db.from('user_settings').select('user_id, settings').in('user_id', ids),
                db.from('vessel_telemetry').select('owner_id, lat, lon, reported_at').in('owner_id', ids),
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
                const boat = officialWatchBoat(
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

        // ── 2. The warnings in force at each boat ──
        const matchedIds = await matchBoats(
            boats,
            (points) => db.rpc('official_alerts_watch_match', { p_points: points }),
        );
        const alertIds = [...new Set([...matchedIds.values()].flatMap((s) => [...s]))];
        const alerts = new Map<number, WatchAlert>();
        if (alertIds.length > 0) {
            const { data: providers, error: providerError } = await db
                .from('official_alert_providers')
                .select('id, attribution')
                .eq('enabled', true);
            if (providerError) throw new Error('provider read failed');
            const credit = new Map((providers ?? []).map((p) => [p.id, String(p.attribution ?? '')]));
            for (const ids of chunk(alertIds, 200)) {
                const { data, error } = await db
                    .from('official_alerts')
                    .select(
                        'id, provider_id, identifier, sender, refs, zones, sent_at, onset_at, effective_at, expires_at, infos',
                    )
                    .in('id', ids);
                if (error) throw new Error('alert read failed');
                for (const r of data ?? []) {
                    if (!credit.has(r.provider_id) || !Array.isArray(r.infos)) continue;
                    alerts.set(r.id, {
                        id: r.id,
                        provider: r.provider_id,
                        identifier: r.identifier,
                        sender: str(r.sender),
                        refs: strings(r.refs),
                        zones: strings(r.zones),
                        sentAt: r.sent_at,
                        onsetAt: str(r.onset_at),
                        effectiveAt: str(r.effective_at),
                        expiresAt: str(r.expires_at),
                        infos: r.infos as StoredInfo[],
                        attribution: credit.get(r.provider_id) ?? '',
                    });
                }
            }
        }
        const matches = new Map<string, WatchAlert[]>();
        for (const [userId, ids] of matchedIds) {
            const list = [...ids].map((id) => alerts.get(id)).filter((a): a is WatchAlert => !!a);
            if (list.length > 0) matches.set(userId, list);
        }

        // ── 3. The deliveries so far, to those accounts: every page ──
        const prior = await readPriorDeliveries([...matches.keys()], (ids, from, to) =>
            db
                .from('official_alert_deliveries')
                .select('user_id, alert_id, provider_id, identifier, refs, chain_key, severity, delivered_at')
                .eq('channel', 'push')
                .in('user_id', ids)
                .order('user_id')
                .order('delivered_at')
                .order('alert_id')
                .range(from, to));

        // ── 4. Decide, queue, record ──
        const out = decideOfficialPushes({
            boats: boats.filter((b) => matches.has(b.userId)),
            matches,
            prior,
            nowMs,
            zoneAt: tzLookup,
        });
        // One row at a time: each insert posts to send-push at once, and one
        // refused row must not hold back another boat's warning. A delivery is
        // recorded only for a push that queued; one that fails to record is
        // sent again next run, which is better than a warning missed.
        let failed = 0;
        let unrecorded = 0;
        for (const { push, delivery } of out.sends) {
            const { error } = await db.from('push_notification_queue').insert({
                recipient_user_id: push.userId,
                notification_type: push.type,
                title: push.title,
                body: push.body,
                data: push.data,
            });
            if (error) {
                failed++;
                continue;
            }
            const { error: recordError } = await db
                .from('official_alert_deliveries')
                .upsert(delivery, { onConflict: 'user_id,alert_id,channel' });
            if (recordError) unrecorded++;
        }

        // ── 5. Answer: the app shows its switches once this row exists ──
        const { error: statusError } = await db.from('official_alerts_watch_status').upsert({
            id: 1,
            ran_at: nowIso,
            boats: boats.length,
            pushes: out.sends.length - failed,
            held: out.held,
            failed,
        });
        if (statusError) throw new Error('status write failed');

        console.log(
            `[official-alerts-watch] boats=${boats.length} at_risk=${matches.size} alerts=${alerts.size} pushes=${
                out.sends.length - failed
            } held=${out.held} failed=${failed} unrecorded=${unrecorded} guardian_failed=${phoneFailed}`,
        );
        return jsonResponse({ boats: boats.length, pushes: out.sends.length - failed, held: out.held, failed });
    } catch (e) {
        console.error('[official-alerts-watch] run failed:', e instanceof Error ? e.message : 'unknown');
        return jsonResponse({ error: 'Official alerts watch failed' }, 500);
    }
});
