/**
 * Measured seas — one shape for every wave-buoy network (build 123, W1-11).
 *
 * Each network (NDBC, Queensland, the Irish Marine Institute, more later) is a
 * provider that turns its own feed into BuoyObs. Everything downstream — QC,
 * "which buoy is nearest", the popup line — sees only this shape, so adding a
 * network is a new provider file, not a new code path.
 */

export type BuoyNetworkId = 'ndbc' | 'qld-des' | 'irish-mi';

/** One observation from one station. Readings are null when not measured. */
export interface BuoyObs {
    /** Network-scoped station key: 'ndbc:46026', 'qld-des:4183', 'irish-mi:M3'. */
    key: string;
    network: BuoyNetworkId;
    /** What people call the station: 'NDBC 46026', 'Brisbane Mk4', 'M3 buoy'. */
    label: string;
    /** Who owns it, always credited. null only when the network does not say. */
    owner: string | null;
    lat: number;
    lon: number;
    /** When it was measured, UTC epoch ms. */
    time: number;
    /** Significant wave height, metres. */
    hsM: number | null;
    /** Peak (dominant) period, seconds. */
    periodS: number | null;
    /** Direction the waves come FROM, degrees true. */
    fromDeg: number | null;
    /** Sea surface temperature, °C. */
    sstC: number | null;
}

/** [south, west, north, east] in degrees; never crosses the antimeridian. */
export type CoverageBox = readonly [number, number, number, number];

export interface BuoyProvider {
    id: BuoyNetworkId;
    /** Short network name for "Couldn't reach … buoys". */
    name: string;
    /**
     * Where this network has wave buoys at all. A tap outside every box fetches
     * nothing, and a failure of a network that could not have covered the tap
     * is not mentioned.
     */
    coverage: readonly CoverageBox[];
    /** The feed sends no CORS header, so only the native app can read it. */
    nativeOnly: boolean;
    /** Every station's recent rows (several per station is fine). */
    fetchLatest(): Promise<BuoyObs[]>;
    /**
     * A second look for a station whose newest row carried no wave reading
     * (NDBC buoys alternate met-only and wave rows). Resolves null when there
     * is nothing better.
     */
    fetchWaves?(station: BuoyObs): Promise<BuoyObs | null>;
    /**
     * Whether fetchWaves could answer for this station at all. Asked BEFORE the
     * per-tap second-look slots are handed out, so shore stations that never
     * measure waves (tide gauges, airports) cannot use them up.
     */
    canLookAgain?(station: BuoyObs): boolean;
}

export interface BuoyUnreachable {
    network: BuoyNetworkId;
    name: string;
    /** 'failed': asked and got no usable answer. 'web': cannot be asked from a browser. */
    reason: 'failed' | 'web';
}

export type NearestBuoyResult =
    | { status: 'found'; obs: BuoyObs; distanceNm: number }
    | {
          status: 'none';
          radiusNm: number;
          unreachable: BuoyUnreachable[];
          /** false: no network the app reads has wave buoys near here, so "none" says nothing about the sea. */
          covered: boolean;
      };
