/**
 * GpsReceiverStatusService — one truthful GPS-receiver status for the UI.
 *
 * There are three very different things that used to be folded into the
 * ambiguous "External GPS" label:
 *
 *  - a vessel NMEA position feed (we know its gateway, not the antenna),
 *  - an iOS accessory actually producing the current Core Location fix,
 *  - a merely high-accuracy location, which is useful but proves no hardware.
 *
 * Keeping those sources separate makes the skipper's status reliable and lets
 * us name a Bad Elf/MFi receiver whenever iOS makes that metadata available.
 */

import {
    BackgroundLocationService,
    type ConnectedExternalAccessory,
    type NativeGpsReceiverInfo,
} from './BackgroundLocationService';
import { NmeaGpsProvider, type NmeaGpsFeedStatus } from './NmeaGpsProvider';
import { NmeaListenerService, type NmeaConnectionInfo } from './NmeaListenerService';
import { NmeaStore } from './NmeaStore';
import { GpsPrecision } from './shiplog/GpsPrecisionTracker';

export type GpsReceiverKind = 'vessel-nmea' | 'ios-accessory' | 'precision-location' | 'phone';

export interface GpsReceiverStatus {
    /** Whether there is a connected / proven non-phone receiver to surface. */
    active: boolean;
    kind: GpsReceiverKind;
    /** Short, source-specific row label. */
    label: string;
    /** Human-readable connection and position-feed state. */
    detail: string;
    /** True only for a vessel NMEA position feed. */
    isNmea: boolean;
    satellites: number | null;
    hdop: number | null;
    avgAccuracy: number | null;
    qualityLabel: string | null;
    /** Best available device/gateway identity, never an invented model. */
    deviceName: string | null;
}

export interface GpsReceiverStatusInput {
    now: number;
    nmea: {
        connection: NmeaConnectionInfo;
        feedStatus: NmeaGpsFeedStatus;
        fixAgeMs: number | null;
        satellites: number | null;
        hdop: number | null;
        qualityLabel: string;
    };
    native: NativeGpsReceiverInfo;
    precision: {
        active: boolean;
        avgAccuracy: number | null;
    };
}

// A Core Location cache older than this can still prove an accessory was used
// *then*, but not that it is supplying the position now.
const ACCESSORY_SOURCE_FRESH_MS = 30_000;

const GPS_ACCESSORY_TOKENS = [
    'bad elf',
    'gps',
    'gnss',
    'xgps',
    'garmin glo',
    'global sat',
    'dualgps',
    'geode',
    'trimble',
    'leica',
    'topcon',
];

const EMPTY_NATIVE_INFO: NativeGpsReceiverInfo = {
    source: {
        hasLocation: false,
        timestampMs: null,
        externalAccessory: false,
        simulated: false,
    },
    accessories: [],
};

function isLikelyGpsAccessory(accessory: ConnectedExternalAccessory): boolean {
    const descriptor = [accessory.manufacturer, accessory.name, accessory.modelNumber]
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();
    return GPS_ACCESSORY_TOKENS.some((token) => descriptor.includes(token));
}

/** Return a compact name without exposing serial numbers or protocol strings. */
export function formatGpsAccessoryName(accessory: ConnectedExternalAccessory): string | null {
    const name = accessory.name?.trim() || null;
    const manufacturer = accessory.manufacturer?.trim() || null;
    const model = accessory.modelNumber?.trim() || null;

    if (name) {
        if (manufacturer && !name.toLowerCase().includes(manufacturer.toLowerCase())) {
            return `${manufacturer} ${name}`;
        }
        return name;
    }
    if (manufacturer && model) return `${manufacturer} ${model}`;
    return manufacturer ?? model;
}

function formatAge(ageMs: number): string {
    if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s`;
    if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
    return `${Math.round(ageMs / 3_600_000)}h`;
}

function appendNmeaFixDetails(status: GpsReceiverStatus, input: GpsReceiverStatusInput): GpsReceiverStatus {
    const details = [status.detail, input.nmea.qualityLabel];
    if (input.nmea.satellites !== null) details.push(`${input.nmea.satellites} sats`);
    if (input.nmea.hdop !== null) details.push(`HDOP ${input.nmea.hdop.toFixed(1)}`);
    return { ...status, detail: details.join(' · ') };
}

/**
 * Pure resolver exported for regression tests. Priority is deliberate:
 * a live vessel NMEA position is the source Thalassa uses first; a proven
 * accessory is next; high accuracy remains a non-device-specific fallback.
 */
export function resolveGpsReceiverStatus(input: GpsReceiverStatusInput): GpsReceiverStatus {
    const { nmea, native, precision, now } = input;

    if (nmea.connection.status === 'connected' && nmea.feedStatus !== 'unavailable') {
        const detail =
            nmea.feedStatus === 'live'
                ? `Live via ${nmea.connection.deviceLabel}`
                : `Last GPS sentence ${formatAge(nmea.fixAgeMs ?? 0)} ago via ${nmea.connection.deviceLabel}`;
        return appendNmeaFixDetails(
            {
                active: true,
                kind: 'vessel-nmea',
                label: 'On-board GPS',
                detail,
                isNmea: true,
                satellites: nmea.satellites,
                hdop: nmea.hdop,
                avgAccuracy: null,
                qualityLabel: nmea.qualityLabel,
                deviceName: nmea.connection.deviceLabel,
            },
            input,
        );
    }

    const sourceAgeMs = native.source.timestampMs === null ? null : Math.max(0, now - native.source.timestampMs);
    const accessoryIsSupplyingLocation =
        native.source.hasLocation &&
        native.source.externalAccessory &&
        native.source.simulated !== true &&
        sourceAgeMs !== null &&
        sourceAgeMs <= ACCESSORY_SOURCE_FRESH_MS;
    const likelyGpsAccessories = native.accessories.filter(isLikelyGpsAccessory);
    // It is safe to bind the sole available MFi accessory to a verified
    // external location. With multiple accessories, never guess which one
    // iOS selected to supply Core Location.
    const identifiedAccessory = accessoryIsSupplyingLocation
        ? likelyGpsAccessories.length === 1
            ? likelyGpsAccessories[0]
            : native.accessories.length === 1
              ? native.accessories[0]
              : null
        : (likelyGpsAccessories[0] ?? null);
    const deviceName = identifiedAccessory ? formatGpsAccessoryName(identifiedAccessory) : null;

    if (accessoryIsSupplyingLocation || identifiedAccessory) {
        const baseDetail = accessoryIsSupplyingLocation
            ? sourceAgeMs && sourceAgeMs > 4_000
                ? `Connected to iPhone · Supplying position (${formatAge(sourceAgeMs)} ago)`
                : 'Connected to iPhone · Supplying position'
            : 'Connected to iPhone · iPhone GPS currently in use';
        return {
            active: true,
            kind: 'ios-accessory',
            label: deviceName ?? 'External GPS',
            detail:
                !deviceName && native.accessories.length > 1 && accessoryIsSupplyingLocation
                    ? `${baseDetail} · Multiple accessories connected`
                    : baseDetail,
            isNmea: false,
            satellites: null,
            hdop: null,
            avgAccuracy: null,
            qualityLabel: null,
            deviceName,
        };
    }

    // A healthy NMEA transport still deserves a transparent state even when
    // it has not sent an RMC/GGA sentence yet. Do not falsely call it live.
    if (nmea.connection.status === 'connected') {
        return {
            active: true,
            kind: 'vessel-nmea',
            label: 'On-board GPS',
            detail: `${nmea.connection.deviceLabel} connected · Waiting for GPS position`,
            isNmea: true,
            satellites: null,
            hdop: null,
            avgAccuracy: null,
            qualityLabel: null,
            deviceName: nmea.connection.deviceLabel,
        };
    }

    if (precision.active) {
        const precisionDetail =
            precision.avgAccuracy !== null
                ? `±${precision.avgAccuracy.toFixed(1)}m · Device identity unavailable`
                : 'Device identity unavailable';
        return {
            active: true,
            kind: 'precision-location',
            label: 'High-precision location',
            detail: precisionDetail,
            isNmea: false,
            satellites: null,
            hdop: null,
            avgAccuracy: precision.avgAccuracy,
            qualityLabel: 'High precision',
            deviceName: null,
        };
    }

    return {
        active: false,
        kind: 'phone',
        label: 'GPS Receiver',
        detail: 'iPhone GPS in use',
        isNmea: false,
        satellites: null,
        hdop: null,
        avgAccuracy: null,
        qualityLabel: null,
        deviceName: null,
    };
}

class GpsReceiverStatusServiceClass {
    private nativeInfo: NativeGpsReceiverInfo = EMPTY_NATIVE_INFO;
    private refreshing: Promise<GpsReceiverStatus> | null = null;

    getStatus(now = Date.now()): GpsReceiverStatus {
        const nmeaState = NmeaStore.getState();
        return resolveGpsReceiverStatus({
            now,
            nmea: {
                connection: NmeaListenerService.getConnectionInfo(),
                feedStatus: NmeaGpsProvider.getFeedStatus(now),
                fixAgeMs: NmeaGpsProvider.getFixAgeMs(now),
                satellites: nmeaState.satellites.value === null ? null : Math.round(nmeaState.satellites.value),
                hdop: nmeaState.hdop.value,
                qualityLabel: NmeaGpsProvider.getQualityLabel(),
            },
            native: this.nativeInfo,
            precision: {
                active: GpsPrecision.isPrecision(),
                avgAccuracy: GpsPrecision.isPrecision()
                    ? Math.round(GpsPrecision.getAverageAccuracy() * 10) / 10
                    : null,
            },
        });
    }

    /** Refreshes native accessory state only; it never starts location services. */
    async refresh(): Promise<GpsReceiverStatus> {
        if (this.refreshing) return this.refreshing;
        this.refreshing = (async () => {
            this.nativeInfo = await BackgroundLocationService.getGpsReceiverInfo();
            return this.getStatus();
        })();
        try {
            return await this.refreshing;
        } finally {
            this.refreshing = null;
        }
    }
}

export const GpsReceiverStatusService = new GpsReceiverStatusServiceClass();
