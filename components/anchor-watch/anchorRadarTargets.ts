/**
 * anchorRadarTargets — the anchor radar's vessel list, receiver-first.
 *
 * Both anchor surfaces (the Glass hero card and the Anchor Watch page) used
 * to draw INTERNET AIS only, polled every 30 s. At anchor is precisely where
 * that is backwards: the trawler dragging toward you at 2 am is a LOCAL
 * target on the boat's own receiver — seconds old, no shore station or
 * cellular link involved — while the internet copy of the same vessel is
 * minutes stale or missing (Class B coverage is patchy on aisstream.io).
 *
 * So the radar now merges both, with the chart layer's politics
 * (useAisStreamLayer): the receiver always wins an MMSI collision, internet
 * fills in what the receiver can't hear, and internet targets older than a
 * cutoff are dropped entirely rather than drawn as live dots in the
 * anchorage. Local targets re-render on every AisStore update — the 30 s
 * cadence only governs the internet fill.
 *
 * Degrades to exactly the old behaviour when the boat feed is off (AisStore
 * empty — e.g. watching from home), and to receiver-only when offline at
 * anchor.
 */
import { useEffect, useRef, useState } from 'react';
import { AisStore } from '../../services/AisStore';
import { AisStreamService } from '../../services/AisStreamService';
import { useSettingsStore } from '../../stores/settingsStore';
import { calculateDistance } from '../../utils/navigationCalculations';
import type { AisTarget } from '../../types/navigation';
import { navStatusColorSimple } from './anchorUtils';
import type { AisTargetDot } from './SwingCircleCanvas';

/** Same radius + limit both surfaces have always used. */
export const ANCHOR_RADAR_RADIUS_NM = 2;
const ANCHOR_RADAR_LIMIT = 50;
const INTERNET_FETCH_INTERVAL_MS = 30_000;

/** An internet position older than this is not a live dot in an anchorage.
 *  (Local targets need no cutoff — AisStore expires them at 10 minutes.) */
const INTERNET_STALE_CUTOFF_MS = 30 * 60_000;

interface AnchorPoint {
    latitude: number;
    longitude: number;
}

/** Pure merge — receiver targets first, internet fill, MMSI-deduped. */
export function mergeAnchorRadarTargets(
    anchor: AnchorPoint,
    localTargets: ReadonlyMap<number, AisTarget>,
    internetFeatures: readonly GeoJSON.Feature[],
    nowMs: number,
    ownMmsi?: number,
): AisTargetDot[] {
    const dots: AisTargetDot[] = [];
    const seen = new Set<number>();

    for (const target of localTargets.values()) {
        if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) continue;
        if (target.mmsi === ownMmsi) continue; // ownship echo is not a neighbour
        if (calculateDistance(anchor.latitude, anchor.longitude, target.lat, target.lon) > ANCHOR_RADAR_RADIUS_NM) {
            continue;
        }
        seen.add(target.mmsi);
        dots.push({
            mmsi: target.mmsi,
            name: target.name || `MMSI ${target.mmsi}`,
            lat: target.lat,
            lon: target.lon,
            cog: Number.isFinite(target.cog) ? target.cog : 0,
            sog: Number.isFinite(target.sog) ? target.sog : 0,
            statusColor: navStatusColorSimple(target.navStatus ?? 15),
        });
    }

    for (const feature of internetFeatures) {
        if (dots.length >= ANCHOR_RADAR_LIMIT) break;
        const coords = (feature.geometry as GeoJSON.Point | undefined)?.coordinates;
        if (!coords || coords.length < 2) continue;
        const p = feature.properties ?? {};
        const mmsi = Number(p.mmsi);
        if (!Number.isFinite(mmsi) || seen.has(mmsi) || mmsi === ownMmsi) continue;
        const updatedAt = Date.parse(String(p.updatedAt ?? p.updated_at ?? ''));
        if (Number.isFinite(updatedAt) && nowMs - updatedAt > INTERNET_STALE_CUTOFF_MS) continue;
        seen.add(mmsi);
        dots.push({
            mmsi,
            name: (typeof p.name === 'string' && p.name) || `MMSI ${mmsi}`,
            lat: coords[1],
            lon: coords[0],
            cog: Number(p.cog ?? 0),
            sog: Number(p.sog ?? 0),
            statusColor: navStatusColorSimple(Number(p.navStatus ?? p.nav_status ?? 15)),
        });
    }

    return dots;
}

function ownVesselMmsi(): number | undefined {
    const raw = Number(useSettingsStore.getState().settings?.vessel?.mmsi);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * The one hook behind both anchor radars. Internet fill polls every 30 s
 * (skipped while backgrounded); receiver updates re-merge immediately via
 * the AisStore subscription.
 */
export function useAnchorRadarTargets(anchor: AnchorPoint | null, enabled: boolean): AisTargetDot[] {
    const [dots, setDots] = useState<AisTargetDot[]>([]);
    const internetRef = useRef<readonly GeoJSON.Feature[]>([]);
    const anchorRef = useRef(anchor);
    anchorRef.current = anchor;

    const anchorLatitude = anchor?.latitude ?? null;
    const anchorLongitude = anchor?.longitude ?? null;

    useEffect(() => {
        if (!enabled || anchorLatitude === null || anchorLongitude === null) {
            internetRef.current = [];
            setDots([]);
            return;
        }
        let cancelled = false;

        const recompute = () => {
            const at = anchorRef.current;
            if (cancelled || !at) return;
            setDots(
                mergeAnchorRadarTargets(at, AisStore.getTargets(), internetRef.current, Date.now(), ownVesselMmsi()),
            );
        };

        const fetchInternet = async () => {
            const at = anchorRef.current;
            if (!at) return;
            try {
                const geojson = await AisStreamService.fetchNearby({
                    lat: at.latitude,
                    lon: at.longitude,
                    radiusNm: ANCHOR_RADAR_RADIUS_NM,
                    limit: ANCHOR_RADAR_LIMIT,
                });
                if (cancelled) return;
                internetRef.current = Array.isArray(geojson?.features) ? geojson.features : [];
            } catch {
                // Offline at anchor — the receiver's targets still render.
            }
            recompute();
        };

        void fetchInternet();
        const interval = setInterval(() => {
            if (document.hidden) return; // battery: skip when backgrounded
            void fetchInternet();
        }, INTERNET_FETCH_INTERVAL_MS);
        const unsubscribe = AisStore.subscribe(recompute);
        recompute();

        return () => {
            cancelled = true;
            clearInterval(interval);
            unsubscribe();
        };
    }, [enabled, anchorLatitude, anchorLongitude]);

    return dots;
}
