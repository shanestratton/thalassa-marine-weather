/**
 * GribRequestBuilder — GRIB request configuration, size estimation, and Saildocs formatting.
 *
 * Calculates estimated file size from bounding box, resolution, parameters, and time steps.
 * Formats Saildocs email strings for Iridium GO! users.
 * Generates the download URL for direct HTTP mode.
 */
import type { GribRequest, GribBoundingBox, GribParameter } from '../types';

// ── Parameter metadata ──
export interface GribParameterInfo {
    key: GribParameter;
    label: string;
    description: string;
    saildocsCode: string;     // Saildocs parameter code
    essential: boolean;       // On by default
    bytesPerPoint: number;    // Estimated GRIB2 encoding overhead per grid point
}

export const GRIB_PARAMETERS: GribParameterInfo[] = [
    { key: 'wind', label: 'Wind Speed & Direction', description: '10m wind U/V components', saildocsCode: 'WIND', essential: true, bytesPerPoint: 4 },
    { key: 'pressure', label: 'MSLP', description: 'Mean Sea Level Pressure', saildocsCode: 'PRESS', essential: true, bytesPerPoint: 2 },
    { key: 'waves', label: 'Wave Height', description: 'Significant wave height + period', saildocsCode: 'HTSGW,PERPW', essential: false, bytesPerPoint: 4 },
    { key: 'precip', label: 'Precipitation', description: 'Total precipitation rate', saildocsCode: 'APCP', essential: false, bytesPerPoint: 2 },
    { key: 'cape', label: 'CAPE Index', description: 'Convective instability', saildocsCode: 'CAPE', essential: false, bytesPerPoint: 2 },
    { key: 'sst', label: 'Sea Surface Temp', description: 'Ocean surface temperature', saildocsCode: 'SSTK', essential: false, bytesPerPoint: 2 },
];

// ── Resolution options ──
export const RESOLUTION_OPTIONS: { value: GribRequest['resolution']; label: string; description: string }[] = [
    { value: 1.0, label: '1.0°', description: '~111km — Tiny file, sparse grid' },
    { value: 0.5, label: '0.5°', description: '~56km — Good balance' },
    { value: 0.25, label: '0.25°', description: '~28km — High detail, larger file' },
];

// ── Time step options ──
export const TIME_STEP_OPTIONS: { value: GribRequest['timeStep']; label: string }[] = [
    { value: 3, label: 'Every 3h' },
    { value: 6, label: 'Every 6h' },
    { value: 12, label: 'Every 12h' },
];

// ── Forecast hours options ──
export const FORECAST_HOURS_OPTIONS: { value: GribRequest['forecastHours']; label: string }[] = [
    { value: 48, label: '2 days' },
    { value: 72, label: '3 days' },
    { value: 96, label: '4 days' },
    { value: 120, label: '5 days' },
];

// ── GRIB Request Builder ──

export class GribRequestBuilder {
    /**
     * Estimate the GRIB file size in bytes.
     *
     * Formula:
     *   latPoints = ceil(|north - south| / resolution)
     *   lonPoints = ceil(|east - west| / resolution)
     *   gridPoints = latPoints × lonPoints
     *   timeSteps = forecastHours / timeStep
     *   bytesPerStep = sum(param.bytesPerPoint for each param) × gridPoints
     *   totalBytes = bytesPerStep × timeSteps + GRIB_OVERHEAD
     */
    static estimateSize(request: GribRequest): number {
        const { bbox, parameters, resolution, timeStep, forecastHours } = request;

        const latSpan = Math.abs(bbox.north - bbox.south);
        const lonSpan = Math.abs(bbox.east - bbox.west);

        const latPoints = Math.max(1, Math.ceil(latSpan / resolution) + 1);
        const lonPoints = Math.max(1, Math.ceil(lonSpan / resolution) + 1);
        const gridPoints = latPoints * lonPoints;

        const timeSteps = Math.max(1, Math.ceil(forecastHours / timeStep));

        // Sum bytes per grid point across selected parameters
        let bytesPerPoint = 0;
        for (const paramKey of parameters) {
            const info = GRIB_PARAMETERS.find(p => p.key === paramKey);
            if (info) bytesPerPoint += info.bytesPerPoint;
        }

        // GRIB2 header overhead (~200 bytes per parameter per time step)
        const headerOverhead = parameters.length * timeSteps * 200;

        return (gridPoints * bytesPerPoint * timeSteps) + headerOverhead;
    }

    /**
     * Format the estimated size as a human-readable string.
     */
    static formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    /**
     * Calculate grid point count for display.
     */
    static getGridInfo(request: GribRequest): { latPoints: number; lonPoints: number; totalPoints: number; timeSteps: number } {
        const latSpan = Math.abs(request.bbox.north - request.bbox.south);
        const lonSpan = Math.abs(request.bbox.east - request.bbox.west);
        const latPoints = Math.max(1, Math.ceil(latSpan / request.resolution) + 1);
        const lonPoints = Math.max(1, Math.ceil(lonSpan / request.resolution) + 1);
        return {
            latPoints,
            lonPoints,
            totalPoints: latPoints * lonPoints,
            timeSteps: Math.max(1, Math.ceil(request.forecastHours / request.timeStep)),
        };
    }

    /**
     * Format a Saildocs email request string.
     *
     * Syntax: send GFS:south,north,west,east|resLat,resLon|0,forecastHours..timeStep|PARAMS
     * Example: send GFS:-30,-10,150,175|1,1|0,72..12|WIND,PRESS,HTSGW
     */
    static formatSaildocsRequest(request: GribRequest): string {
        const { bbox, parameters, resolution, timeStep, forecastHours, model } = request;

        // Saildocs uses south,north,west,east
        const area = `${bbox.south},${bbox.north},${bbox.west},${bbox.east}`;
        const grid = `${resolution},${resolution}`;
        const time = `0,${forecastHours}..${timeStep}`;

        // Map parameters to Saildocs codes
        const paramCodes = parameters
            .map(key => GRIB_PARAMETERS.find(p => p.key === key)?.saildocsCode)
            .filter(Boolean)
            .join(',');

        return `send ${model}:${area}|${grid}|${time}|${paramCodes}`;
    }

    /**
     * Generate the full mailto: URI for Saildocs email.
     * Opens the native email client pre-populated.
     */
    static getSaildocsMailtoUri(request: GribRequest): string {
        const body = GribRequestBuilder.formatSaildocsRequest(request);
        const subject = 'Thalassa GRIB Request';
        return `mailto:query@saildocs.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }

    /**
     * Build the direct download URL for a GRIB request.
     * Uses NOAA's NOMADS GRIB filter service.
     */
    static buildDownloadUrl(request: GribRequest): string {
        const { bbox, parameters, resolution, timeStep, forecastHours, model } = request;

        if (model === 'GFS') {
            // NOAA NOMADS GFS GRIB filter
            const base = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl';
            const params = new URLSearchParams();

            // Latest run
            params.set('dir', '/gfs.latest');
            params.set('file', 'gfs.t00z.pgrb2.0p25.f000'); // Placeholder

            // Bounding box
            params.set('subregion', '');
            params.set('toplat', String(bbox.north));
            params.set('bottomlat', String(bbox.south));
            params.set('leftlon', String(bbox.west));
            params.set('rightlon', String(bbox.east));

            // Level
            params.set('lev_10_m_above_ground', 'on'); // Wind
            params.set('lev_mean_sea_level', 'on');     // Pressure

            // Variables based on parameters
            for (const key of parameters) {
                switch (key) {
                    case 'wind': params.set('var_UGRD', 'on'); params.set('var_VGRD', 'on'); break;
                    case 'pressure': params.set('var_PRMSL', 'on'); break;
                    case 'waves': params.set('var_HTSGW', 'on'); params.set('var_PERPW', 'on'); break;
                    case 'precip': params.set('var_APCP', 'on'); break;
                    case 'cape': params.set('var_CAPE', 'on'); break;
                    case 'sst': params.set('var_TMP', 'on'); break;
                }
            }

            return `${base}?${params.toString()}`;
        }

        // ECMWF — placeholder URL (requires ECMWF API key)
        return `https://api.ecmwf.int/v1/grib?north=${bbox.north}&south=${bbox.south}&west=${bbox.west}&east=${bbox.east}`;
    }

    /**
     * Validate a bounding box.
     */
    static validateBBox(bbox: GribBoundingBox): string[] {
        const errors: string[] = [];
        if (bbox.north <= bbox.south) errors.push('North must be greater than South');
        if (bbox.north > 90 || bbox.north < -90) errors.push('North latitude out of range (-90 to 90)');
        if (bbox.south > 90 || bbox.south < -90) errors.push('South latitude out of range (-90 to 90)');
        if (bbox.west > 180 || bbox.west < -180) errors.push('West longitude out of range (-180 to 180)');
        if (bbox.east > 180 || bbox.east < -180) errors.push('East longitude out of range (-180 to 180)');

        const latSpan = Math.abs(bbox.north - bbox.south);
        const lonSpan = Math.abs(bbox.east - bbox.west);
        if (latSpan > 60) errors.push('Area too large: latitude span > 60°');
        if (lonSpan > 60) errors.push('Area too large: longitude span > 60°');
        if (latSpan < 1) errors.push('Area too small: latitude span < 1°');
        if (lonSpan < 1) errors.push('Area too small: longitude span < 1°');

        return errors;
    }

    /**
     * Get the default essential parameters.
     */
    static getDefaultParameters(): GribParameter[] {
        return GRIB_PARAMETERS.filter(p => p.essential).map(p => p.key);
    }

    /**
     * Create a default GribRequest centered on user's location.
     */
    static createDefault(lat = -25, lon = 155): GribRequest {
        return {
            bbox: {
                north: lat + 10,
                south: lat - 10,
                west: lon - 10,
                east: lon + 10,
            },
            parameters: GribRequestBuilder.getDefaultParameters(),
            resolution: 1.0,
            timeStep: 6,
            forecastHours: 72,
            model: 'GFS',
        };
    }
}
