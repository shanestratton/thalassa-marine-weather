/**
 * ingest-official-alerts — the issuers' official warnings, every 5 minutes (129-05).
 *
 * Runs from pg_cron (held migration 20261014150000_official_alerts) through
 * invoke_edge_function with the service key. Each run reads
 * official_alert_providers, takes every provider whose licence flag is on
 * (a provider that is off is never fetched), and for each, in isolation:
 *   1. asks its feed with a conditional GET (a 304 writes nothing);
 *   2. turns the answer into alerts (_shared/official-alerts/adapters.ts,
 *      CAP 1.2 in _shared/cap.ts), the issuer's text verbatim in every
 *      language it sent;
 *   3. compares each alert's content hash with the stored one and writes only
 *      what is new, changed or withdrawn, through official_alerts_apply();
 *   4. loads a few missing zone shapes (NWS);
 *   5. records the provider's health: last success, last error, and since
 *      when it has been unavailable.
 * The logic is in _shared/official-alerts/ingest.ts
 * (tests/OfficialAlertsIngest.test.ts). Logs carry counts only.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';
import type { AdapterName, Known, ProviderRow } from '../_shared/official-alerts/adapters.ts';
import { type AlertStore, applyBatches, createHttp, runIngest, USER_AGENT } from '../_shared/official-alerts/ingest.ts';

type Row = Record<string, unknown>;
const asRecord = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const iso = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

Deno.serve(async (req: Request) => {
    const denied = requireServiceRolePost(req, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (denied) return denied;
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return jsonResponse({ error: 'Server database is not configured' }, 500);

    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

    const store: AlertStore = {
        async providers() {
            const { data, error } = await db
                .from('official_alert_providers')
                .select(
                    'id, adapter, issuer, feed_url, enabled, config, feed_state, last_success_at, last_error, last_error_at, unavailable_since',
                )
                .order('id');
            if (error) throw new Error('provider read failed');
            return (data ?? []).map((r): ProviderRow => ({
                id: String(r.id),
                adapter: r.adapter as AdapterName,
                name: String(r.issuer),
                feedUrl: iso(r.feed_url),
                enabled: r.enabled === true,
                config: asRecord(r.config),
                feedState: asRecord(r.feed_state),
                lastSuccessAt: iso(r.last_success_at),
                lastError: iso(r.last_error),
                lastErrorAt: iso(r.last_error_at),
                unavailableSince: iso(r.unavailable_since),
            }));
        },
        async known(providerId) {
            const out = new Map<string, Known>();
            for (let from = 0;; from += 1000) {
                const { data, error } = await db
                    .from('official_alerts')
                    .select('identifier, content_hash, withdrawn_at, expires_at')
                    .eq('provider_id', providerId)
                    .order('identifier')
                    .range(from, from + 999);
                if (error) throw new Error('alert read failed');
                for (const r of data ?? []) {
                    out.set(String(r.identifier), {
                        hash: String(r.content_hash),
                        live: r.withdrawn_at === null,
                        expiresAt: iso(r.expires_at),
                    });
                }
                if ((data ?? []).length < 1000) break;
            }
            return out;
        },
        async missingZones(providerId, keys) {
            const have = new Set<string>();
            for (let i = 0; i < keys.length; i += 200) {
                const { data, error } = await db
                    .from('official_alert_zones')
                    .select('code')
                    .eq('provider_id', providerId)
                    .in('code', keys.slice(i, i + 200));
                if (error) throw new Error('zone read failed');
                for (const r of data ?? []) have.add(String(r.code));
            }
            return keys.filter((k) => !have.has(k));
        },
        async apply(providerId, change) {
            for (const args of applyBatches(providerId, change)) {
                const { error } = await db.rpc('official_alerts_apply', args);
                if (error) throw new Error('apply failed');
            }
        },
    };

    try {
        const summary = await runIngest({
            store,
            http: createHttp(fetch, { userAgent: USER_AGENT }),
            nowMs: Date.now(),
        });
        const counts = summary.ran.map((r) => ({
            provider: r.provider,
            ok: r.ok,
            notModified: r.notModified,
            writes: r.writes,
            upserts: r.upserts,
            withdrawn: r.withdrawn,
            zones: r.zones,
            error: r.error,
        }));
        console.log(JSON.stringify({ ingest: counts, off: summary.off.length, deferred: summary.deferred.length }));
        return jsonResponse({ ran: counts, off: summary.off, deferred: summary.deferred });
    } catch (err) {
        console.error('ingest-official-alerts failed:', err instanceof Error ? err.message : 'unknown');
        return jsonResponse({ error: 'ingest failed' }, 500);
    }
});
