/**
 * useAisStreamLayer — Sole owner of the 'ais-targets' map source.
 *
 * Fetches server-side AIS targets from Supabase and merges them
 * with local NMEA AIS data. Local targets always take priority.
 *
 * Includes:
 *   - CPA/TCPA collision avoidance calculations
 *   - Ship type decoding (cargo, tanker, fishing, etc.)
 *   - Premium vessel detail popup with collision warnings
 */
import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { AisStreamService } from '../../services/AisStreamService';
import { AisStore } from '../../services/AisStore';
import { supabase } from '../../services/supabase';
import { onLocalAisChange } from './useAisLayer';
import { LocationStore } from '../../stores/LocationStore';
import { NmeaStore } from '../../services/NmeaStore';
import { computeCpa } from '../../utils/cpaCalculation';
import { AisGuardZone } from '../../services/AisGuardZone';
import { triggerHaptic } from '../../utils/system';
import { VesselMetadataService } from '../../services/VesselMetadataService';
import { getMmsiFlag } from '../../utils/MmsiDecoder';
import { isFeatureLockedSync } from '../../managers/FeatureGate';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('useAisStreamLayer');

const FETCH_DEBOUNCE_MS = 1500;
const AIS_SOURCE_ID = 'ais-targets';
const PREDICTED_TRACKS_SOURCE_ID = 'ais-predicted-tracks';
const TRACK_INTERVALS_MIN = [5, 10, 15]; // Projected positions at 5, 10, 15 minutes

/**
 * AIS names, callsigns, destinations, and registry fields are external input.
 * A transponder can therefore supply HTML-looking text deliberately or by
 * accident. Mapbox Popup#setHTML does not sanitise it for us.
 */
function aisDisplayString(value: unknown): string {
    try {
        // AIS and registry fields have tiny protocol-defined limits. Keeping
        // a generous ceiling prevents a malformed response from expanding a
        // popup into megabytes of HTML without truncating legitimate names.
        return String(value ?? '').slice(0, 256);
    } catch {
        // Network JSON cannot normally create a throwing coercion, but popup
        // rendering should still fail closed if a hostile object reaches it.
        return '';
    }
}

export function escapeAisPopupHtml(value: unknown): string {
    return aisDisplayString(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Only remote HTTPS images are accepted in AIS popup markup. */
export function safeAisImageUrl(value: unknown): string | null {
    const hasControlCharacter =
        typeof value === 'string' &&
        [...value].some((character) => character.charCodeAt(0) <= 31 || character === '\u007f');
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || hasControlCharacter) {
        return null;
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
        return parsed.href;
    } catch {
        return null;
    }
}

export function finiteAisDisplayNumber(value: unknown): number | null {
    if (typeof value === 'string' && !value.trim()) return null;
    try {
        const parsed = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function normaliseAisMmsi(value: unknown): number | null {
    let text: string;
    try {
        text = typeof value === 'number' && Number.isInteger(value) ? String(value) : String(value ?? '').trim();
    } catch {
        return null;
    }
    if (!/^\d{9}$/.test(text)) return null;
    const mmsi = Number(text);
    return Number.isSafeInteger(mmsi) && mmsi >= 100_000_000 && mmsi <= 999_999_999 ? mmsi : null;
}

export function normaliseAisCoordinates(value: unknown): [number, number] | null {
    if (!Array.isArray(value) || value.length < 2) return null;
    const parseCoordinate = (coordinate: unknown): number | null => {
        if (typeof coordinate === 'number') return Number.isFinite(coordinate) ? coordinate : null;
        if (
            typeof coordinate !== 'string' ||
            !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(coordinate.trim())
        ) {
            return null;
        }
        const parsed = Number(coordinate);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const lon = parseCoordinate(value[0]);
    const lat = parseCoordinate(value[1]);
    if (lon == null || lat == null || lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    return [lon, lat];
}

export function normaliseAisNavStatus(value: unknown): number {
    const status = finiteAisDisplayNumber(value);
    return status != null && Number.isInteger(status) && status >= 0 && status <= 15 ? status : 15;
}

const UNKNOWN_AIS_STALE_MINUTES = 24 * 60;
const MAX_AIS_FUTURE_SKEW_MS = 5 * 60 * 1000;

function boundedAisField(value: unknown, maxLength: number): string {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).slice(0, maxLength);
}

function normaliseAisTimestamp(value: unknown, now: number): { value: string; staleMinutes: number } {
    const timestamp =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.length <= 64
              ? Date.parse(value)
              : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp > now + MAX_AIS_FUTURE_SKEW_MS) {
        return { value: '', staleMinutes: UNKNOWN_AIS_STALE_MINUTES };
    }
    return {
        value: new Date(timestamp).toISOString(),
        staleMinutes: Math.min(525_600, Math.max(0, Math.floor((now - timestamp) / 60_000))),
    };
}

export function normaliseInternetAisFeature(value: unknown, now = Date.now()): GeoJSON.Feature<GeoJSON.Point> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const geometry =
        candidate.geometry && typeof candidate.geometry === 'object' && !Array.isArray(candidate.geometry)
            ? (candidate.geometry as Record<string, unknown>)
            : null;
    const properties =
        candidate.properties && typeof candidate.properties === 'object' && !Array.isArray(candidate.properties)
            ? (candidate.properties as Record<string, unknown>)
            : null;
    if (!geometry || geometry.type !== 'Point' || !properties) return null;

    const coordinates = normaliseAisCoordinates(geometry.coordinates);
    const mmsi = normaliseAisMmsi(properties.mmsi);
    if (!coordinates || mmsi == null) return null;

    const timestamp = normaliseAisTimestamp(properties.updatedAt ?? properties.updated_at, now);
    const navStatus = normaliseAisNavStatus(properties.navStatus ?? properties.nav_status);
    const shipTypeValue = finiteAisDisplayNumber(properties.shipType ?? properties.ship_type);
    const shipType =
        shipTypeValue != null && Number.isInteger(shipTypeValue) && shipTypeValue >= 0 && shipTypeValue <= 99
            ? shipTypeValue
            : 0;
    const sogValue = finiteAisDisplayNumber(properties.sog);
    const sog = sogValue != null && sogValue >= 0 && sogValue < 102.3 ? sogValue : 0;
    const cogValue = finiteAisDisplayNumber(properties.cog);
    const cog = cogValue != null && cogValue >= 0 && cogValue < 360 ? cogValue : 0;
    const headingValue = finiteAisDisplayNumber(properties.heading);
    const heading =
        headingValue != null &&
        Number.isInteger(headingValue) &&
        ((headingValue >= 0 && headingValue < 360) || headingValue === 511)
            ? headingValue
            : 511;

    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates },
        properties: {
            mmsi,
            name: boundedAisField(properties.name, 120),
            callSign: boundedAisField(properties.callSign ?? properties.call_sign, 20),
            destination: boundedAisField(properties.destination, 120),
            shipType,
            navStatus,
            sog,
            cog,
            heading,
            updatedAt: timestamp.value,
            staleMinutes: timestamp.staleMinutes,
            source: 'aisstream',
            statusColor: navStatusColor(navStatus),
        },
    };
}

interface AisTargetPopupHtmlInput {
    thumbnail: unknown;
    shipIcon: unknown;
    displayName: unknown;
    typeLabel: unknown;
    isVerified: boolean;
    flagCountry: unknown;
    navStatus: unknown;
    sog: unknown;
    lastSeen: unknown;
    isPremium: boolean;
    needsOnDemandLookup: boolean;
    lookupSpinnerId: string;
    loa: unknown;
    beam: unknown;
    draft: unknown;
    /** Generated solely from finite CPA values and local label/colour tables. */
    trustedCpaHtml: string;
    mmsi: unknown;
    callSign: unknown;
    cog: unknown;
    heading: unknown;
    destination: unknown;
    source: unknown;
    imoNumber: unknown;
    dataSource: unknown;
    hasDetails: boolean;
    detailBtnId: string;
}

/**
 * Pure renderer kept exported so adversarial tests exercise the exact markup
 * handed to Mapbox, not merely the escaping helper in isolation.
 */
export function buildAisTargetPopupHtml(input: AisTargetPopupHtmlInput): string {
    const thumbnail = safeAisImageUrl(input.thumbnail);
    const navStatus = normaliseAisNavStatus(input.navStatus);
    const statusColor = navStatusColor(navStatus);
    const status = navStatusLabel(navStatus);
    const loa = finiteAisDisplayNumber(input.loa);
    const beam = finiteAisDisplayNumber(input.beam);
    const draft = finiteAisDisplayNumber(input.draft);
    const dims = [
        loa != null && loa > 0 ? `LOA: ${loa.toFixed(1)}m` : null,
        beam != null && beam > 0 ? `Beam: ${beam.toFixed(1)}m` : null,
        draft != null && draft > 0 ? `Draft: ${draft.toFixed(1)}m` : null,
    ].filter((value): value is string => value !== null);
    const dimensionsHtml =
        dims.length > 0
            ? `<div style="display:flex;gap:8px;margin-bottom:10px;padding:6px 8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.15);border-radius:8px;font-size:10px;color:#94a3b8;">
                ${dims.map((dimension) => `<span>${escapeAisPopupHtml(dimension)}</span>`).join('<span style="color:#334155;">•</span>')}
               </div>`
            : '';
    const upgradeBanner = !input.isPremium
        ? `<button type="button" id="${escapeAisPopupHtml(input.detailBtnId)}" style="width:100%;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.15);border-radius:8px;padding:6px 10px;margin-bottom:10px;text-align:center;font-size:10px;color:#38bdf8;cursor:pointer;">
            🔒 Upgrade for vessel photo, dimensions &amp; registry data
           </button>`
        : '';
    const viewDetailsBtn =
        input.isPremium && input.hasDetails
            ? `<button type="button" id="${escapeAisPopupHtml(input.detailBtnId)}" style="width:100%;margin-top:8px;padding:8px 12px;background:linear-gradient(135deg,rgba(14,165,233,0.15),rgba(139,92,246,0.15));border:1px solid rgba(14,165,233,0.25);border-radius:10px;color:#38bdf8;font-size:11px;font-weight:700;letter-spacing:0.5px;cursor:pointer;text-transform:uppercase;transition:all 0.2s;">
            View Full Details ›
           </button>`
            : '';

    return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:rgba(15,23,42,0.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:14px 16px;color:#e2e8f0;min-width:240px;max-width:300px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                ${
                    thumbnail
                        ? `<img src="${escapeAisPopupHtml(thumbnail)}" alt="" referrerpolicy="no-referrer" style="width:44px;height:44px;border-radius:10px;object-fit:cover;border:1px solid rgba(255,255,255,0.1);flex-shrink:0;" />`
                        : `<div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,rgba(14,165,233,0.15),rgba(139,92,246,0.15));border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">${escapeAisPopupHtml(input.shipIcon)}</div>`
                }
                <div style="flex:1;min-width:0;">
                    <div data-vessel-name style="font-weight:800;font-size:14px;letter-spacing:0.3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeAisPopupHtml(input.displayName)}</div>
                    <div style="font-size:10px;color:#94a3b8;display:flex;align-items:center;gap:4px;">
                        <span>${escapeAisPopupHtml(input.typeLabel)}</span>
                        ${input.isVerified ? '<span style="color:#22c55e;font-size:9px;">✓ Verified</span>' : ''}
                        ${input.flagCountry ? `<span style="color:#475569;">•</span><span data-vessel-flag>${escapeAisPopupHtml(input.flagCountry)}</span>` : ''}
                    </div>
                </div>
                <div style="width:10px;height:10px;border-radius:50%;background:${statusColor};box-shadow:0 0 8px ${statusColor};flex-shrink:0;"></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;padding:4px 0;">
                <span style="color:${statusColor};font-weight:700;font-size:11px;">${escapeAisPopupHtml(status)}</span>
                <span style="color:#475569;">•</span>
                <span style="font-size:11px;color:#94a3b8;">${escapeAisPopupHtml(input.sog)}</span>
                <span style="color:#475569;">•</span>
                <span style="font-size:10px;color:${input.lastSeen === 'Live' ? '#22c55e' : '#64748b'};">${escapeAisPopupHtml(input.lastSeen)}</span>
            </div>
            ${upgradeBanner}
            ${
                input.needsOnDemandLookup
                    ? `<div id="${escapeAisPopupHtml(input.lookupSpinnerId)}" style="margin-bottom:10px;">
                        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.15);border-radius:8px;font-size:10px;color:#38bdf8;">
                            <span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(56,189,248,0.3);border-top-color:#38bdf8;border-radius:50%;animation:spin 0.8s linear infinite;"></span>
                            <span>Searching registry…</span>
                        </div>
                       </div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>`
                    : ''
            }
            ${dimensionsHtml}
            ${input.trustedCpaHtml}
            <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:11px;">
                <span style="color:#64748b;">MMSI</span>
                <span style="font-family:monospace;font-size:10px;">${escapeAisPopupHtml(input.mmsi)}</span>
                <span style="color:#64748b;">Call Sign</span>
                <span>${escapeAisPopupHtml(input.callSign)}</span>
                <span style="color:#64748b;">COG / Hdg</span>
                <span>${escapeAisPopupHtml(input.cog)} / ${escapeAisPopupHtml(input.heading)}</span>
                <span style="color:#64748b;">Destination</span>
                <span style="font-weight:600;color:#e2e8f0;">${escapeAisPopupHtml(input.destination)}</span>
                <span style="color:#64748b;">Source</span>
                <span style="font-size:10px;">${escapeAisPopupHtml(input.source)}</span>
                ${input.imoNumber ? `<span style="color:#64748b;">IMO</span><span style="font-family:monospace;font-size:10px;">${escapeAisPopupHtml(input.imoNumber)}</span>` : ''}
                ${input.dataSource ? `<span style="color:#64748b;">Registry</span><span style="font-size:10px;color:#94a3b8;">${escapeAisPopupHtml(input.dataSource)}</span>` : ''}
            </div>
            ${viewDetailsBtn}
        </div>
    `;
}

export interface AisVesselDetailData {
    mmsi: unknown;
    name: unknown;
    flag: unknown;
    flagCountry: unknown;
    type: unknown;
    callSign: unknown;
    imo: unknown;
    loa: unknown;
    beam: unknown;
    draft: unknown;
    thumbnail: unknown;
    destination: unknown;
    sog: unknown;
    cog: unknown;
    heading: unknown;
    status: unknown;
    lastSeen: unknown;
    source: unknown;
    dataSource: unknown;
    isVerified: boolean;
    lat: unknown;
    lon: unknown;
}

export function buildAisVesselDetailHtml(data: AisVesselDetailData): string {
    const thumbnail = safeAisImageUrl(data.thumbnail);
    const heroImg = thumbnail
        ? `<div style="width:100%;height:180px;border-radius:16px 16px 0 0;position:relative;overflow:hidden;">
            <img src="${escapeAisPopupHtml(thumbnail)}" alt="" referrerpolicy="no-referrer" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" />
            <div style="position:absolute;inset:0;background:linear-gradient(transparent 50%,rgba(15,23,42,0.9) 100%);border-radius:16px 16px 0 0;"></div>
            <div style="position:absolute;bottom:12px;left:16px;right:16px;">
                <div style="font-size:20px;font-weight:900;color:white;text-shadow:0 2px 8px rgba(0,0,0,0.5);">${escapeAisPopupHtml(data.flag)} ${escapeAisPopupHtml(data.name)}</div>
                <div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:2px;">${escapeAisPopupHtml(data.type)}${data.isVerified ? ' • ✓ Verified' : ''}</div>
            </div>
           </div>`
        : `<div style="padding:20px 16px 12px;text-align:center;">
            <div style="font-size:48px;margin-bottom:8px;">${escapeAisPopupHtml(data.flag)}</div>
            <div style="font-size:20px;font-weight:900;color:#e2e8f0;">${escapeAisPopupHtml(data.name)}</div>
            <div style="font-size:12px;color:#94a3b8;margin-top:4px;">${escapeAisPopupHtml(data.type)}${data.isVerified ? ' • ✓ Verified' : ''}</div>
           </div>`;
    const row = (label: string, value: unknown, mono = false) => {
        if (value == null || value === '') return '';
        const valStyle = mono ? 'font-family:monospace;font-size:12px;' : 'font-weight:600;';
        return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
            <span style="color:#64748b;font-size:12px;">${escapeAisPopupHtml(label)}</span>
            <span style="color:#e2e8f0;font-size:12px;${valStyle}">${escapeAisPopupHtml(value)}</span>
        </div>`;
    };
    const dimension = (value: unknown): string | null => {
        const parsed = finiteAisDisplayNumber(value);
        return parsed != null && parsed > 0 ? `${parsed.toFixed(1)} m` : null;
    };
    const sog = finiteAisDisplayNumber(data.sog);
    const cog = finiteAisDisplayNumber(data.cog);
    const heading = finiteAisDisplayNumber(data.heading);

    return `
        <div style="width:100%;max-width:400px;max-height:90vh;background:rgba(15,23,42,0.98);border:1px solid rgba(255,255,255,0.1);border-radius:16px 16px 0 0;overflow-y:auto;color:#e2e8f0;animation:slideUp 0.3s ease-out;">
            <button type="button" data-vessel-modal-close style="position:absolute;top:12px;right:12px;z-index:10;width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.15);color:white;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;" aria-label="Close vessel details">✕</button>
            ${heroImg}
            <div style="padding:0 16px 16px;">
                <div style="margin:16px 0 8px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Vessel Specifications</div>
                ${row('MMSI', data.mmsi, true)}
                ${row('IMO', data.imo, true)}
                ${row('Call Sign', data.callSign)}
                ${row('Flag', `${aisDisplayString(data.flag)} ${aisDisplayString(data.flagCountry)}`)}
                ${row('Type', data.type)}
                ${row('LOA', dimension(data.loa))}
                ${row('Beam', dimension(data.beam))}
                ${row('Draft', dimension(data.draft))}
                <div style="margin:16px 0 8px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Navigation</div>
                ${row('Status', data.status)}
                ${row('SOG', sog != null && sog > 0 ? `${sog.toFixed(1)} kn` : 'Stationary')}
                ${row('COG', cog != null ? `${cog.toFixed(0)}°` : '—')}
                ${row('Heading', heading != null && heading !== 511 ? `${heading.toFixed(0)}°` : '—')}
                ${row('Destination', data.destination)}
                ${row('Position', `${aisDisplayString(data.lat)}°, ${aisDisplayString(data.lon)}°`)}
                ${row('Last Seen', data.lastSeen)}
                <div style="margin:16px 0 8px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Data Source</div>
                ${row('Source', data.source)}
                ${row('Registry', data.dataSource)}
                ${row('Verified', data.isVerified ? '✓ Yes' : '✗ No')}
            </div>
        </div>
    `;
}

/**
 * Project a position forward by given minutes at given COG/SOG.
 * Returns [lon, lat].
 */
function projectPosition(lat: number, lon: number, cogDeg: number, sogKn: number, minutes: number): [number, number] {
    const hours = minutes / 60;
    const distNm = sogKn * hours;
    const distDeg = distNm / 60; // 1° latitude ≈ 60 NM
    const cogRad = (cogDeg * Math.PI) / 180;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const newLat = lat + distDeg * Math.cos(cogRad);
    const newLon = lon + (distDeg * Math.sin(cogRad)) / cosLat;
    return [newLon, newLat];
}

// Convert map zoom to a sensible radius in nautical miles
function zoomToRadiusNm(zoom: number): number {
    if (zoom >= 14) return 5;
    if (zoom >= 12) return 10;
    if (zoom >= 10) return 25;
    if (zoom >= 8) return 50;
    if (zoom >= 6) return 100;
    return 200;
}

export function longitudeWithinPaddedBounds(
    longitude: number,
    west: number,
    east: number,
    paddingRatio = 0.4,
): boolean {
    if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(west) ||
        !Number.isFinite(east) ||
        !Number.isFinite(paddingRatio) ||
        paddingRatio < 0
    ) {
        return false;
    }

    let unwrappedEast = east;
    while (unwrappedEast < west) unwrappedEast += 360;
    const width = unwrappedEast - west;
    const padding = width * paddingRatio;
    if (width + padding * 2 >= 360) return true;

    const centre = (west + unwrappedEast) / 2;
    const wrapped = centre + ((((longitude - centre + 180) % 360) + 360) % 360) - 180;
    return wrapped >= west - padding && wrapped <= unwrappedEast + padding;
}

export function buildGuardZoneCircle(lat: number, lon: number, radiusNm: number, segments = 64): [number, number][] {
    if (
        !Number.isFinite(lat) ||
        lat < -90 ||
        lat > 90 ||
        !Number.isFinite(lon) ||
        lon < -180 ||
        lon > 180 ||
        !Number.isFinite(radiusNm) ||
        radiusNm <= 0 ||
        !Number.isSafeInteger(segments) ||
        segments < 8 ||
        segments > 512
    ) {
        return [];
    }

    const angularDistance = radiusNm / 3440.065;
    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;
    const points: [number, number][] = [];
    for (let index = 0; index <= segments; index += 1) {
        const bearing = (index / segments) * Math.PI * 2;
        const pointLat = Math.asin(
            Math.sin(latRad) * Math.cos(angularDistance) +
                Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing),
        );
        const pointLon =
            lonRad +
            Math.atan2(
                Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
                Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(pointLat),
            );
        const wrappedLon = (((((pointLon * 180) / Math.PI + 180) % 360) + 360) % 360) - 180;
        points.push([wrappedLon, (pointLat * 180) / Math.PI]);
    }
    return points;
}

/** Keep only the AIS features whose position falls inside the current map
 *  viewport, padded ~40% on each side so targets just off-screen don't pop in
 *  and out while panning. The longitude comparison unwraps around the viewport
 *  centre, so Fiji/Chatham/Alaska views crossing ±180° remain usable. */
function clipFeaturesToView(map: mapboxgl.Map, features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
    const bounds = map.getBounds();
    if (!bounds) return { type: 'FeatureCollection', features };
    const w = bounds.getWest();
    const e = bounds.getEast();
    const s = bounds.getSouth();
    const n = bounds.getNorth();
    const padLat = (n - s) * 0.4;
    const minLat = s - padLat;
    const maxLat = n + padLat;
    const inView = features.filter((f) => {
        const c = (f.geometry as GeoJSON.Point | undefined)?.coordinates;
        const coordinates = normaliseAisCoordinates(c);
        if (!coordinates) return false;
        const [lon, lat] = coordinates;
        return longitudeWithinPaddedBounds(lon, w, e) && lat >= minLat && lat <= maxLat;
    });
    return { type: 'FeatureCollection', features: inView };
}

/**
 * Map AIS navigational status code to a display colour.
 */
function navStatusColor(status: number): string {
    switch (status) {
        case 0:
            return '#22c55e';
        case 1:
            return '#f59e0b';
        case 2:
            return '#ef4444';
        case 3:
            return '#f97316';
        case 4:
            return '#f97316';
        case 5:
            return '#94a3b8';
        case 6:
            return '#ef4444';
        case 7:
            return '#06b6d4';
        case 8:
            return '#22c55e';
        case 15:
            return '#38bdf8';
        default:
            return '#38bdf8';
    }
}

function navStatusLabel(status: number): string {
    switch (status) {
        case 0:
            return 'Under Way (Engine)';
        case 1:
            return 'At Anchor';
        case 2:
            return 'Not Under Command';
        case 3:
            return 'Restricted Manoeuvrability';
        case 4:
            return 'Constrained by Draught';
        case 5:
            return 'Moored';
        case 6:
            return 'Aground';
        case 7:
            return 'Fishing';
        case 8:
            return 'Under Way (Sail)';
        case 14:
            return 'AIS-SART Active';
        case 15:
            return 'Not Defined';
        default:
            return 'Unknown';
    }
}

// ── Ship type decoder (ITU-R M.1371-5, Table 53) ──────────────

function decodeShipType(code: number): { icon: string; label: string } {
    if (code >= 20 && code <= 29) return { icon: '🚤', label: 'Wing in Ground' };
    if (code === 30) return { icon: '🎣', label: 'Fishing Vessel' };
    if (code === 31) return { icon: '🚢', label: 'Towing' };
    if (code === 32) return { icon: '🚢', label: 'Towing (Large)' };
    if (code === 33) return { icon: '⛏️', label: 'Dredger' };
    if (code === 34) return { icon: '🤿', label: 'Diving Operations' };
    if (code === 35) return { icon: '⚓', label: 'Military' };
    if (code === 36) return { icon: '⛵', label: 'Sailing Vessel' };
    if (code === 37) return { icon: '🚤', label: 'Pleasure Craft' };
    if (code >= 40 && code <= 49) return { icon: '🚀', label: 'High Speed Craft' };
    if (code === 50) return { icon: '🧭', label: 'Pilot Vessel' };
    if (code === 51) return { icon: '🔍', label: 'SAR Vessel' };
    if (code === 52) return { icon: '🚢', label: 'Tug' };
    if (code === 53) return { icon: '🚢', label: 'Port Tender' };
    if (code === 54) return { icon: '🏭', label: 'Anti-Pollution' };
    if (code === 55) return { icon: '🚔', label: 'Law Enforcement' };
    if (code === 58) return { icon: '🏥', label: 'Medical Transport' };
    if (code === 59) return { icon: '🚢', label: 'Non-combatant Ship' };
    if (code >= 60 && code <= 69) {
        const label = code === 69 ? 'Cruise Ship' : 'Passenger Ship';
        return { icon: '🛳️', label };
    }
    if (code >= 70 && code <= 79) {
        const labels: Record<number, string> = {
            70: 'Cargo Ship',
            71: 'Cargo — Hazmat (A)',
            72: 'Cargo — Hazmat (B)',
            73: 'Cargo — Hazmat (C)',
            74: 'Cargo — Hazmat (D)',
            75: 'Car Carrier',
            76: 'Bulk Carrier',
            77: 'Container Ship',
            78: 'RoRo Cargo',
            79: 'Cargo (Other)',
        };
        return { icon: '🚢', label: labels[code] || 'Cargo Ship' };
    }
    if (code >= 80 && code <= 89) {
        const labels: Record<number, string> = {
            80: 'Tanker',
            81: 'Tanker — Hazmat (A)',
            82: 'Tanker — Hazmat (B)',
            83: 'Tanker — Hazmat (C)',
            84: 'Tanker — Hazmat (D)',
            85: 'LNG / LPG Carrier',
            86: 'Chemical Tanker',
            87: 'Oil Tanker',
            88: 'Gas Carrier',
            89: 'Tanker (Other)',
        };
        return { icon: '🚢', label: labels[code] || 'Tanker' };
    }
    if (code >= 90 && code <= 99) return { icon: '🚢', label: 'Other Vessel' };
    return { icon: '🚢', label: 'Unknown Type' };
}

export function useAisStreamLayer(map: mapboxgl.Map | null, enabled: boolean): void {
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestGeneration = useRef(0);
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    const cachedServerFeatures = useRef<GeoJSON.Feature[]>([]);

    const mergeAndWrite = useCallback(() => {
        if (!map || !enabled) return;

        const localGeoJson = AisStore.toGeoJSON();
        const localMmsis = new Set(localGeoJson.features.map((f) => f.properties?.mmsi));

        const now = Date.now();

        const internetFeatures = cachedServerFeatures.current.flatMap((feature) => {
            const normalised = normaliseInternetAisFeature(feature, now);
            if (!normalised || localMmsis.has(normalised.properties?.mmsi)) return [];
            return [normalised];
        });

        const merged: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                ...localGeoJson.features.map((f) => ({
                    ...f,
                    properties: { ...f.properties, source: 'local', staleMinutes: 0 },
                })),
                ...internetFeatures,
            ],
        };

        // ── Vicinity clip (Shane 2026-07-17: "show boats in the vicinity of
        // where we are, not randomly around the world — pan to the Whitsundays
        // and see the yachts up there, none down here"). The internet fetch is
        // already centre+radius, but AisStore.toGeoJSON() dumps EVERY local
        // target regardless of the view. Clip the merged set to the current
        // viewport, padded ~40% so targets just off-screen stay put while
        // panning, so only vessels near where you're LOOKING ever render. ──
        const clipped = clipFeaturesToView(map, merged.features);

        const source = map.getSource(AIS_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
        if (source) {
            source.setData(clipped);
        }

        // ── Generate predicted track lines for moving vessels ──
        const trackFeatures: GeoJSON.Feature[] = [];
        for (const feat of clipped.features) {
            const p = feat.properties;
            if (!p) continue;
            const sog = finiteAisDisplayNumber(p.sog) ?? 0;
            const cog = finiteAisDisplayNumber(p.cog) ?? 0;
            const stale = finiteAisDisplayNumber(p.staleMinutes) ?? 0;

            // Skip stationary, very stale, or no-position vessels
            if (sog < 0.5 || stale > 60) continue;
            const coords = (feat.geometry as GeoJSON.Point)?.coordinates;
            if (!coords || coords.length < 2) continue;

            const normalisedCoords = normaliseAisCoordinates(coords);
            if (!normalisedCoords) continue;
            const [lon, lat] = normalisedCoords;
            const color = navStatusColor(normaliseAisNavStatus(p.navStatus ?? p.nav_status));

            // Build projected line: current pos → 5 → 10 → 15 min
            const lineCoords: [number, number][] = [[lon, lat]];
            for (const minutes of TRACK_INTERVALS_MIN) {
                const projected = projectPosition(lat, lon, cog, sog, minutes);
                lineCoords.push(projected);

                // Time-tick dot at each interval
                trackFeatures.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: projected },
                    properties: { statusColor: color, staleMinutes: stale, minutes },
                });
            }

            // The track line itself
            trackFeatures.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: lineCoords },
                properties: { statusColor: color, staleMinutes: stale },
            });
        }

        const trackSource = map.getSource(PREDICTED_TRACKS_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
        if (trackSource) {
            trackSource.setData({ type: 'FeatureCollection', features: trackFeatures });
        }

        // ── Guard Zone check ──
        const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState(), now);
        const newAlerts = own ? AisGuardZone.checkFeatures(own.lat, own.lon, merged.features) : [];
        if (newAlerts.length > 0) {
            triggerHaptic('heavy');
            // Dispatch custom event for UI to show alert toast
            window.dispatchEvent(new CustomEvent('ais-guard-alert', { detail: newAlerts }));
        }

        // ── Guard Zone radius circle on map ──
        const guardSource = map.getSource('ais-guard-zone') as mapboxgl.GeoJSONSource | undefined;
        if (guardSource) {
            const gz = AisGuardZone.getState();
            if (gz.enabled && own) {
                const pts = buildGuardZoneCircle(own.lat, own.lon, gz.radiusNm);
                guardSource.setData({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [pts] },
                    properties: {},
                });
            } else {
                guardSource.setData({ type: 'FeatureCollection', features: [] });
            }
        }
    }, [map, enabled]);

    const fetchAndMerge = useCallback(
        async (expectedGeneration = requestGeneration.current) => {
            if (!map || !enabled || !supabase) {
                mergeAndWrite();
                return;
            }

            const center = map.getCenter();
            const zoom = map.getZoom();
            const radiusNm = zoomToRadiusNm(zoom);

            try {
                const geojson = await AisStreamService.fetchNearby({
                    lat: center.lat,
                    lon: center.lng,
                    radiusNm,
                });

                if (expectedGeneration !== requestGeneration.current) return;
                cachedServerFeatures.current = Array.isArray(geojson?.features) ? geojson.features : [];
            } catch (e) {
                log.warn('[useAisStreamLayer] Fetch failed:', e);
            }

            if (expectedGeneration !== requestGeneration.current) return;
            mergeAndWrite();

            // ── Pre-fetch vessel metadata for visible targets ──
            // So data is ready before users tap (eliminates MMSI-only popup delay)
            const mmsis = (cachedServerFeatures.current || [])
                .map((f) => f.properties?.mmsi)
                .filter((m): m is number => typeof m === 'number' && m > 0);
            if (mmsis.length > 0) {
                const unique = [...new Set(mmsis)].slice(0, 50);
                VesselMetadataService.batchLookup(unique).catch(() => {
                    /* silent — best-effort pre-fetch */
                });
            }
        },
        [map, enabled, mergeAndWrite],
    );

    // Listen for local AIS data changes → re-merge
    useEffect(() => {
        if (!map || !enabled) return;
        const unsub = onLocalAisChange(() => mergeAndWrite());
        return unsub;
    }, [map, enabled, mergeAndWrite]);

    // Debounced fetch on map idle
    useEffect(() => {
        if (!map || !enabled) return;
        // A generation token rejects responses from the previous map/visibility
        // lifecycle without causing all future responses to be discarded after
        // AIS is disabled and re-enabled.
        const generation = ++requestGeneration.current;

        const onIdle = () => {
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
            debounceTimer.current = setTimeout(() => fetchAndMerge(generation), FETCH_DEBOUNCE_MS);
        };

        map.on('idle', onIdle);
        fetchAndMerge(generation);

        return () => {
            if (requestGeneration.current === generation) requestGeneration.current += 1;
            map.off('idle', onIdle);
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    }, [map, enabled, fetchAndMerge]);

    // ── Adaptive polling — 10s on fast WiFi, 60s on cellular/slow ──
    useEffect(() => {
        if (!map || !enabled) return;

        const getInterval = (): number => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const conn = (navigator as any).connection;
            if (!conn) return 10_000; // API unavailable — assume fast
            const type: string = conn.type ?? '';
            const ect: string = conn.effectiveType ?? '4g';
            // Cellular or slow effective connection → 60s
            if (type === 'cellular') return 60_000;
            if (ect === '2g' || ect === 'slow-2g' || ect === '3g') return 60_000;
            // WiFi/ethernet with fast effective type → 10s
            return 10_000;
        };

        let timer: ReturnType<typeof setTimeout>;
        const tick = () => {
            fetchAndMerge();
            timer = setTimeout(tick, getInterval());
        };
        timer = setTimeout(tick, getInterval());
        return () => clearTimeout(timer);
    }, [map, enabled, fetchAndMerge]);

    // ── Premium vessel popup on tap ──
    useEffect(() => {
        if (!map || !enabled) return;

        let detailButtonTimer: ReturnType<typeof setTimeout> | null = null;
        let detailModalCloseTimer: ReturnType<typeof setTimeout> | null = null;
        let detailModal: HTMLDivElement | null = null;
        const removeDetailModal = () => {
            if (detailModalCloseTimer) {
                clearTimeout(detailModalCloseTimer);
                detailModalCloseTimer = null;
            }
            detailModal?.remove();
            detailModal = null;
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handleClick = (e: any) => {
            if (!e.features || e.features.length === 0) return;

            const f = e.features[0];
            const p = f.properties;
            if (!p) return;

            const coords = normaliseAisCoordinates((f.geometry as GeoJSON.Point | undefined)?.coordinates);
            const mmsi = normaliseAisMmsi(p.mmsi);
            if (!coords || mmsi == null) return;
            const [targetLon, targetLat] = coords;

            if (popupRef.current) popupRef.current.remove();

            // ── Identity — "Bingo" interception ──
            const isPremium = !isFeatureLockedSync('vessel_intel');
            const flagEmoji = getMmsiFlag(mmsi);
            const intel = isPremium ? VesselMetadataService.getVesselIntel(mmsi) : null;

            // ── On-demand lookup: if premium user and no vessel name, fire Edge Function ──
            const needsOnDemandLookup = isPremium && !intel?.name;
            const popupInstanceId = `${mmsi}-${Date.now()}`;
            const lookupSpinnerId = `lookup-spinner-${popupInstanceId}`;
            if (needsOnDemandLookup) {
                VesselMetadataService.onDemandLookup(mmsi).then((result) => {
                    const spinnerEl = document.getElementById(lookupSpinnerId);
                    if (result && result.vessel_name && popupRef.current) {
                        // Update spinner to show success
                        if (spinnerEl) {
                            spinnerEl.textContent = '';
                            const successDiv = document.createElement('div');
                            successDiv.style.cssText =
                                'display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.15);border-radius:8px;font-size:10px;color:#22c55e;';
                            const checkSpan = document.createElement('span');
                            checkSpan.textContent = `\u2713 Found: ${result.flag_emoji || ''} ${result.vessel_name}`;
                            successDiv.appendChild(checkSpan);
                            spinnerEl.appendChild(successDiv);
                        }
                        // Update the name/flag in the existing popup header (in-place, no flash)
                        const popup = popupRef.current;
                        if (popup) {
                            const el = popup.getElement();
                            if (el) {
                                const nameEl = el.querySelector('[data-vessel-name]') as HTMLElement;
                                if (nameEl) nameEl.textContent = result.vessel_name || '';
                                const flagEl = el.querySelector('[data-vessel-flag]') as HTMLElement;
                                if (flagEl)
                                    flagEl.textContent = `${result.flag_emoji || ''} ${result.flag_country || ''}`;
                            }
                        }
                    } else {
                        // Not found — update spinner to show result
                        if (spinnerEl) {
                            spinnerEl.textContent = '';
                            const noDataDiv = document.createElement('div');
                            noDataDiv.style.cssText =
                                'padding:6px 10px;background:rgba(100,116,139,0.08);border:1px solid rgba(100,116,139,0.15);border-radius:8px;font-size:10px;color:#64748b;';
                            noDataDiv.textContent = 'No registry data found';
                            spinnerEl.appendChild(noDataDiv);
                        }
                    }
                });
            }

            // Enriched name: DB name > AIS name > decoded country vessel > MMSI fallback
            const vesselName = intel?.name ?? p.name ?? null;
            const displayName = vesselName ? `${intel?.flag ?? flagEmoji} ${vesselName}` : `${flagEmoji} MMSI ${mmsi}`;

            // Derive colours locally instead of accepting arbitrary CSS from
            // a GeoJSON property.
            const navStatus = normaliseAisNavStatus(p.navStatus ?? p.nav_status);
            const status = navStatusLabel(navStatus);
            const sogVal = finiteAisDisplayNumber(p.sog) ?? 0;
            const cogValue = finiteAisDisplayNumber(p.cog);
            const cogVal = cogValue ?? 0;
            const sog = sogVal > 0 ? `${sogVal.toFixed(1)} kn` : 'Stationary';
            const cogStr = cogValue != null ? `${cogValue.toFixed(0)}°` : '—';
            const headingValue = finiteAisDisplayNumber(p.heading);
            const hdg = headingValue != null && headingValue !== 511 ? `${headingValue.toFixed(0)}°` : '—';
            const destination = p.destination || '—';
            const source = p.source === 'local' ? '📡 Local NMEA' : '🌐 AISStream';

            // ── Ship type — always fill from best source ──
            const vesselType = intel?.metadata?.vessel_type ?? null;
            const shipType = finiteAisDisplayNumber(p.shipType ?? p.ship_type) ?? 0;
            const { icon: shipIcon, label: shipLabel } = decodeShipType(shipType);
            const typeLabel = vesselType || (shipLabel !== 'Unknown' ? shipLabel : 'Vessel');

            // ── Call sign — merge AIS + DB ──
            const callSign = intel?.metadata?.call_sign || p.callSign || '—';

            // ── Thumbnail ──
            const thumbnail = safeAisImageUrl(intel?.thumbnail);

            // ── Flag country (always available from decoder) ──
            const flagCountry = intel?.metadata?.flag_country || intel?.country || null;

            // ── Dimensions — always show what we have ──
            const loa = finiteAisDisplayNumber(intel?.metadata?.loa);
            const beam = finiteAisDisplayNumber(intel?.metadata?.beam);
            const draft = finiteAisDisplayNumber(intel?.metadata?.draft);

            // ── IMO + Data Source (premium) ──
            const imoNumber = intel?.metadata?.imo_number ?? null;
            const dataSource = intel?.metadata?.data_source ?? null;
            const isVerified = intel?.metadata?.is_verified === true;

            // ── Last seen ──
            let lastSeen = '—';
            const ts = p.updatedAt || p.lastUpdated;
            if (ts) {
                const timestamp = new Date(ts).getTime();
                if (Number.isFinite(timestamp)) {
                    const mins = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
                    if (mins < 1) lastSeen = 'Just now';
                    else if (mins < 60) lastSeen = `${mins}m ago`;
                    else {
                        const hrs = Math.floor(mins / 60);
                        const rem = mins % 60;
                        lastSeen = rem > 0 ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
                    }
                }
            }
            if (p.source === 'local') lastSeen = 'Live';

            // ── CPA / TCPA ──
            const nmea = NmeaStore.getState();
            const own = resolveOwnshipPosition(nmea, LocationStore.getState());
            const targetStaleMinutes = finiteAisDisplayNumber(p.staleMinutes);
            const cpaResult =
                own && targetStaleMinutes != null && targetStaleMinutes <= 30
                    ? computeCpa(own.lat, own.lon, own.cog, own.sog, targetLat, targetLon, cogVal, sogVal, navStatus)
                    : null;

            let cpaSection = '';
            if (
                cpaResult &&
                [cpaResult.cpa, cpaResult.tcpa, cpaResult.distance, cpaResult.bearing].every(Number.isFinite)
            ) {
                const { cpa, tcpa, distance, bearing, risk } = cpaResult;
                const rc: Record<string, string> = {
                    DANGER: '#ef4444',
                    CAUTION: '#f59e0b',
                    SAFE: '#22c55e',
                    NONE: '#64748b',
                };
                const noneLabel = tcpa < 0 ? '↔ Diverging' : '🔇 No Risk';
                const rl: Record<string, string> = {
                    DANGER: '⚠️ DANGER — Risk of Collision',
                    CAUTION: '⚡ CAUTION — Close Approach',
                    SAFE: '✅ Safe Passage',
                    NONE: noneLabel,
                };
                const riskColor = rc[risk] || '#64748b';

                const banner =
                    risk === 'DANGER' || risk === 'CAUTION'
                        ? `<div style="background:${riskColor}18;border:1px solid ${riskColor}40;border-radius:8px;padding:6px 10px;margin-bottom:10px;text-align:center;font-size:11px;font-weight:700;color:${riskColor};letter-spacing:0.3px;">${rl[risk]}</div>`
                        : '';

                const tcpaStr =
                    tcpa < 0 ? 'Diverging' : tcpa < 60 ? `${tcpa.toFixed(0)} min` : `${(tcpa / 60).toFixed(1)} hrs`;

                cpaSection = `
                    ${banner}
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;padding:8px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
                        <div style="text-align:center;">
                            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Distance</div>
                            <div style="font-size:14px;font-weight:700;color:#e2e8f0;">${distance.toFixed(1)} NM</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Bearing</div>
                            <div style="font-size:14px;font-weight:700;color:#e2e8f0;">${bearing.toFixed(0)}°</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">CPA</div>
                            <div style="font-size:14px;font-weight:700;color:${riskColor};">${cpa.toFixed(2)} NM</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">TCPA</div>
                            <div style="font-size:14px;font-weight:700;color:${riskColor};">${tcpaStr}</div>
                        </div>
                    </div>
                `;
            }

            const detailBtnId = `vessel-detail-${popupInstanceId}`;
            const modalData: AisVesselDetailData | null =
                isPremium && intel?.metadata
                    ? {
                          mmsi,
                          name: vesselName || `MMSI ${mmsi}`,
                          flag: intel?.flag ?? flagEmoji,
                          flagCountry: flagCountry || 'Unknown',
                          type: typeLabel,
                          callSign,
                          imo: imoNumber,
                          loa,
                          beam,
                          draft,
                          thumbnail: thumbnail || null,
                          destination,
                          sog: sogVal,
                          cog: cogVal,
                          heading: headingValue,
                          status,
                          lastSeen,
                          source,
                          dataSource,
                          isVerified,
                          lat: targetLat.toFixed(5),
                          lon: targetLon.toFixed(5),
                      }
                    : null;

            // Every external text value is escaped before it reaches setHTML.
            // AIS static data is user-programmable at the transmitting vessel;
            // registry metadata and thumbnail URLs are network input too.
            const html = buildAisTargetPopupHtml({
                thumbnail,
                shipIcon,
                displayName,
                typeLabel,
                isVerified,
                flagCountry,
                navStatus,
                sog,
                lastSeen,
                isPremium,
                needsOnDemandLookup,
                lookupSpinnerId,
                loa,
                beam,
                draft,
                trustedCpaHtml: cpaSection,
                mmsi,
                callSign,
                cog: cogStr,
                heading: hdg,
                destination,
                source,
                imoNumber,
                dataSource,
                hasDetails: Boolean(intel?.metadata),
                detailBtnId,
            });

            popupRef.current = new mapboxgl.Popup({
                closeButton: true,
                closeOnClick: true,
                maxWidth: '320px',
                className: 'ais-vessel-popup',
                offset: 14,
            })
                .setLngLat(coords)
                .setHTML(html)
                .addTo(map);

            // ── Attach detail modal click handler ──
            if (isPremium && intel?.metadata && modalData) {
                if (detailButtonTimer) clearTimeout(detailButtonTimer);
                detailButtonTimer = setTimeout(() => {
                    detailButtonTimer = null;
                    const btn = document.getElementById(detailBtnId);
                    if (btn) {
                        btn.addEventListener('click', () => {
                            // Remove popup
                            if (popupRef.current) popupRef.current.remove();

                            // Create full-screen modal overlay
                            removeDetailModal();
                            document.getElementById('vessel-detail-modal')?.remove();
                            const overlay = document.createElement('div');
                            overlay.id = 'vessel-detail-modal';
                            overlay.style.cssText = `position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:fadeIn 0.2s ease-out;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`;
                            overlay.innerHTML = buildAisVesselDetailHtml(modalData);

                            document.body.appendChild(overlay);
                            detailModal = overlay;

                            // Close handlers
                            const closeModal = () => {
                                overlay.style.animation = 'fadeOut 0.2s ease-in';
                                if (detailModalCloseTimer) clearTimeout(detailModalCloseTimer);
                                detailModalCloseTimer = setTimeout(() => {
                                    overlay.remove();
                                    if (detailModal === overlay) detailModal = null;
                                    detailModalCloseTimer = null;
                                }, 200);
                            };
                            overlay.addEventListener('click', (ev) => {
                                if (ev.target === overlay) closeModal();
                            });
                            overlay
                                .querySelector<HTMLButtonElement>('[data-vessel-modal-close]')
                                ?.addEventListener('click', closeModal);
                        });
                    }
                }, 100);
            } else if (!isPremium) {
                document.getElementById(detailBtnId)?.addEventListener('click', () => {
                    window.dispatchEvent(new CustomEvent('trigger-paywall'));
                });
            }
        };

        const handleMouseEnter = () => {
            map.getCanvas().style.cursor = 'pointer';
        };
        const handleMouseLeave = () => {
            map.getCanvas().style.cursor = '';
        };

        map.on('click', 'ais-targets-circle', handleClick);
        map.on('mouseenter', 'ais-targets-circle', handleMouseEnter);
        map.on('mouseleave', 'ais-targets-circle', handleMouseLeave);

        return () => {
            map.off('click', 'ais-targets-circle', handleClick);
            map.off('mouseenter', 'ais-targets-circle', handleMouseEnter);
            map.off('mouseleave', 'ais-targets-circle', handleMouseLeave);
            if (popupRef.current) {
                popupRef.current.remove();
                popupRef.current = null;
            }
            if (detailButtonTimer) {
                clearTimeout(detailButtonTimer);
                detailButtonTimer = null;
            }
            removeDetailModal();
        };
    }, [map, enabled]);
}
