/** Lazy, visible-Obs-only layer. Never starts a receiver or supplies collision inputs. */
import React from 'react';
import type mapboxgl from 'mapbox-gl';
import { withDeadline } from '../../utils/deadline';
import { supabase } from '../../services/supabase';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    parseReceiverCoverage,
    receiverCoverageFeatures,
    receiverCoverageWindow,
    type ReceiverCoverageStatus,
} from '../../services/ais/receiverCoverage';
const SOURCE = 'thalassa-receiver-coverage140',
    FILL = SOURCE + '-fill',
    LINE = SOURCE + '-line';
const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
// Native fetch can ignore AbortSignal. Bound actual unresolved requests across
// remounts; a timeout must not free a slot for another still-running native call.
let outstandingReads = 0;
export default function ReceiverCoverageLayer({
    mapRef,
    mapReady,
    active,
    onStatus,
}: {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    active: boolean;
    onStatus: (s: ReceiverCoverageStatus) => void;
}) {
    React.useEffect(() => {
        const map = mapRef.current;
        if (!active || !mapReady || !map) {
            onStatus({ state: 'off', partial: false, cells: 0, asOf: null });
            return;
        }
        let retired = false,
            revision = 0,
            controller: AbortController | null = null,
            scheduled: ReturnType<typeof setTimeout> | null = null,
            expiry: ReturnType<typeof setTimeout> | null = null;
        let expiresAt = 0;
        const publish = (
            state: ReceiverCoverageStatus['state'],
            partial = false,
            cells = 0,
            asOf: number | null = null,
        ) => {
            if (!retired) onStatus({ state, partial, cells, asOf });
        };
        const clear = () => {
            expiresAt = 0;
            if (expiry) clearTimeout(expiry);
            expiry = null;
            try {
                (map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined)?.setData(empty);
            } catch {
                /* style retirement */
            }
        };
        const draw = (data: GeoJSON.FeatureCollection) => {
            if (!map.isStyleLoaded()) return;
            if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data });
            else (map.getSource(SOURCE) as mapboxgl.GeoJSONSource).setData(data);
            if (!map.getLayer(FILL))
                map.addLayer({
                    id: FILL,
                    type: 'fill',
                    source: SOURCE,
                    paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.12 },
                });
            if (!map.getLayer(LINE))
                map.addLayer({
                    id: LINE,
                    type: 'line',
                    source: SOURCE,
                    paint: { 'line-color': '#22d3ee', 'line-opacity': 0.5, 'line-width': 1, 'line-dasharray': [2, 2] },
                });
        };
        const refresh = async () => {
            const run = ++revision;
            controller?.abort();
            clear();
            const scope = getAuthIdentityScope();
            if (!scope.userId) {
                publish('signed-out');
                return;
            }
            if (document.visibilityState === 'hidden') return;
            if (outstandingReads >= 2) {
                publish('unavailable');
                return;
            }
            const box = receiverCoverageWindow(map.getBounds());
            if (!box) {
                publish('unavailable');
                return;
            }
            const current = () =>
                !retired &&
                run === revision &&
                isAuthIdentityScopeCurrent(scope) &&
                document.visibilityState !== 'hidden';
            const request = new AbortController(),
                deadline = setTimeout(() => request.abort(), 5000);
            controller = request;
            publish('loading');
            try {
                const reading = supabase
                    .rpc('ais_receiver_coverage', { p_west: box[0], p_south: box[1], p_east: box[2], p_north: box[3] })
                    .abortSignal(request.signal);
                outstandingReads++;
                const result = await withDeadline(
                    Promise.resolve(reading).finally(() => {
                        outstandingReads--;
                    }),
                    5500,
                    'Receiver coverage request',
                );
                if (!current()) return;
                if (request.signal.aborted) {
                    publish('unavailable');
                    return;
                }
                const parsed = !result.error ? parseReceiverCoverage(result.data, Date.now()) : null;
                if (!parsed) {
                    publish('unavailable');
                    return;
                }
                if (parsed.state === 'held') {
                    publish('held');
                    return;
                }
                expiresAt = parsed.expiresAt!;
                draw(receiverCoverageFeatures(parsed));
                publish('available', parsed.partial, parsed.cells.length, parsed.asOf!);
                expiry = setTimeout(
                    () => {
                        if (!current()) return;
                        clear();
                        publish('unavailable');
                    },
                    Math.max(0, expiresAt - Date.now()),
                );
            } catch {
                if (current()) publish('unavailable');
            } finally {
                clearTimeout(deadline);
                if (controller === request) controller = null;
            }
        };
        const schedule = () => {
            revision++;
            controller?.abort();
            clear();
            if (scheduled) clearTimeout(scheduled);
            scheduled = setTimeout(() => {
                scheduled = null;
                void refresh();
            }, 350);
        };
        const auth = subscribeAuthIdentityScope(schedule);
        const visible = () => {
            if (document.visibilityState === 'hidden') {
                revision++;
                controller?.abort();
                clear();
            } else schedule();
        };
        map.on('moveend', schedule);
        map.on('style.load', schedule);
        document.addEventListener('visibilitychange', visible);
        const timer = setInterval(() => {
            if (expiresAt && Date.now() >= expiresAt) clear();
            schedule();
        }, 60000);
        void refresh();
        return () => {
            retired = true;
            revision++;
            controller?.abort();
            if (scheduled) clearTimeout(scheduled);
            if (expiry) clearTimeout(expiry);
            clearInterval(timer);
            auth();
            map.off('moveend', schedule);
            map.off('style.load', schedule);
            document.removeEventListener('visibilitychange', visible);
            try {
                if (map.getLayer(LINE)) map.removeLayer(LINE);
                if (map.getLayer(FILL)) map.removeLayer(FILL);
                if (map.getSource(SOURCE)) map.removeSource(SOURCE);
            } catch {
                /* map already removed */
            }
        };
    }, [mapRef, mapReady, active, onStatus]);
    return null;
}
