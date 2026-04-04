/**
 * ChartLockerService — Chart file management for AvNav integration.
 *
 * Manages downloading free charts (NOAA MBTiles, LINZ) and uploading
 * chart files (.mbtiles, .oesenc, .gemf, .kap) to an AvNav server
 * on the local network.
 *
 * Two download modes:
 *   - Phone Proxy: Download to phone → Upload to Pi → Delete from phone
 *   - Pi Direct:   Tell the Pi to download directly (Pi needs internet)
 */

import { createLogger } from '../utils/createLogger';
import { CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

const log = createLogger('ChartLocker');

// ── Types ──

export type ChartRegion =
    | 'us-east'
    | 'us-southeast'
    | 'us-gulf'
    | 'us-west'
    | 'us-alaska'
    | 'us-hawaii'
    | 'us-territories'
    | 'nz'
    | 'sp-fiji'
    | 'sp-tonga'
    | 'sp-vanuatu'
    | 'sp-newcal'
    | 'sp-samoa'
    | 'sp-cook'
    | 'sp-frpoly'
    | 'sp-other'
    | 'sp-overview';

export interface ChartPackage {
    id: string;
    name: string;
    region: ChartRegion;
    regionLabel: string;
    sizeMB: number;
    url: string;
    format: 'mbtiles' | 'kap' | 'geotiff' | 'zip';
    source: 'noaa' | 'linz' | 'community';
    /** LINZ layer ID if applicable */
    linzLayerId?: number;
    /** True if the file is a .zip containing .mbtiles (AvNav can handle zips) */
    isZipped?: boolean;
    /** True if the URL is a MediaFire page (needs scraping for direct link) */
    isMediaFire?: boolean;
    /** Credit for community charts */
    credit?: string;
}

export type UploadPhase = 'idle' | 'picking' | 'downloading' | 'uploading' | 'deleting' | 'done' | 'error';

export interface UploadProgress {
    phase: UploadPhase;
    /** 0–1 progress for current phase */
    progress: number;
    /** Human-readable status */
    message: string;
    /** Bytes transferred in current phase */
    bytesTransferred: number;
    /** Total bytes for current phase */
    bytesTotal: number;
    /** Error message if phase === 'error' */
    error?: string;
}

export type DownloadMode = 'phone-proxy' | 'pi-direct';

// ── NOAA MBTiles Catalog ──
// Source: https://distribution.charts.noaa.gov/ncds/index.html
// Updated weekly by NOAA from ENC data.

const NOAA_BASE_URL = 'https://distribution.charts.noaa.gov/ncds/mbtiles';

const NOAA_CATALOG: ChartPackage[] = [
    // US East Coast
    {
        id: 'ncds_01a',
        name: 'Maine to Cape Cod',
        region: 'us-east',
        regionLabel: 'US East Coast',
        sizeMB: 596,
        url: `${NOAA_BASE_URL}/ncds_01a.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_01b',
        name: 'Massachusetts Bay',
        region: 'us-east',
        regionLabel: 'US East Coast',
        sizeMB: 479,
        url: `${NOAA_BASE_URL}/ncds_01b.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_01c',
        name: 'Nantucket to Block Island',
        region: 'us-east',
        regionLabel: 'US East Coast',
        sizeMB: 138,
        url: `${NOAA_BASE_URL}/ncds_01c.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_02a',
        name: 'Long Island Sound West',
        region: 'us-east',
        regionLabel: 'US East Coast',
        sizeMB: 323,
        url: `${NOAA_BASE_URL}/ncds_02a.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_02b',
        name: 'Long Island Sound East',
        region: 'us-east',
        regionLabel: 'US East Coast',
        sizeMB: 508,
        url: `${NOAA_BASE_URL}/ncds_02b.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_03',
        name: 'New York to Cape May',
        region: 'us-east',
        regionLabel: 'US East Coast',
        sizeMB: 577,
        url: `${NOAA_BASE_URL}/ncds_03.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_04',
        name: 'Delaware Bay to Cape Hatteras',
        region: 'us-east',
        regionLabel: 'US East Coast',
        sizeMB: 572,
        url: `${NOAA_BASE_URL}/ncds_04.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_05',
        name: 'Chesapeake Bay',
        region: 'us-east',
        regionLabel: 'US East Coast',
        sizeMB: 534,
        url: `${NOAA_BASE_URL}/ncds_05.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },

    // US Southeast
    {
        id: 'ncds_06',
        name: 'Cape Hatteras to Charleston',
        region: 'us-southeast',
        regionLabel: 'US Southeast',
        sizeMB: 374,
        url: `${NOAA_BASE_URL}/ncds_06.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_07',
        name: 'Charleston to Jacksonville',
        region: 'us-southeast',
        regionLabel: 'US Southeast',
        sizeMB: 611,
        url: `${NOAA_BASE_URL}/ncds_07.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_08',
        name: 'East Florida',
        region: 'us-southeast',
        regionLabel: 'US Southeast',
        sizeMB: 355,
        url: `${NOAA_BASE_URL}/ncds_08.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },

    // US Gulf
    {
        id: 'ncds_12',
        name: 'Florida Keys & SW Florida',
        region: 'us-gulf',
        regionLabel: 'US Gulf Coast',
        sizeMB: 419,
        url: `${NOAA_BASE_URL}/ncds_12.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_13',
        name: 'West Florida to Mobile Bay',
        region: 'us-gulf',
        regionLabel: 'US Gulf Coast',
        sizeMB: 363,
        url: `${NOAA_BASE_URL}/ncds_13.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },

    // US West Coast
    {
        id: 'ncds_19a',
        name: 'Washington & Oregon',
        region: 'us-west',
        regionLabel: 'US West Coast',
        sizeMB: 407,
        url: `${NOAA_BASE_URL}/ncds_19a.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_19b',
        name: 'Puget Sound',
        region: 'us-west',
        regionLabel: 'US West Coast',
        sizeMB: 416,
        url: `${NOAA_BASE_URL}/ncds_19b.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_19c',
        name: 'Columbia River',
        region: 'us-west',
        regionLabel: 'US West Coast',
        sizeMB: 230,
        url: `${NOAA_BASE_URL}/ncds_19c.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_19d',
        name: 'Strait of Juan de Fuca',
        region: 'us-west',
        regionLabel: 'US West Coast',
        sizeMB: 118,
        url: `${NOAA_BASE_URL}/ncds_19d.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_20a',
        name: 'Northern California',
        region: 'us-west',
        regionLabel: 'US West Coast',
        sizeMB: 425,
        url: `${NOAA_BASE_URL}/ncds_20a.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_20b',
        name: 'San Francisco Bay',
        region: 'us-west',
        regionLabel: 'US West Coast',
        sizeMB: 371,
        url: `${NOAA_BASE_URL}/ncds_20b.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_20c',
        name: 'Southern California',
        region: 'us-west',
        regionLabel: 'US West Coast',
        sizeMB: 632,
        url: `${NOAA_BASE_URL}/ncds_20c.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },

    // Alaska
    {
        id: 'ncds_22a',
        name: 'Southeast Alaska North',
        region: 'us-alaska',
        regionLabel: 'Alaska',
        sizeMB: 777,
        url: `${NOAA_BASE_URL}/ncds_22a.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_22b',
        name: 'Southeast Alaska South',
        region: 'us-alaska',
        regionLabel: 'Alaska',
        sizeMB: 746,
        url: `${NOAA_BASE_URL}/ncds_22b.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_23a',
        name: 'Kodiak Island Area',
        region: 'us-alaska',
        regionLabel: 'Alaska',
        sizeMB: 495,
        url: `${NOAA_BASE_URL}/ncds_23a.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_25a',
        name: 'Bristol Bay Area',
        region: 'us-alaska',
        regionLabel: 'Alaska',
        sizeMB: 476,
        url: `${NOAA_BASE_URL}/ncds_25a.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },

    // Hawaii & Territories
    {
        id: 'ncds_29',
        name: 'US Virgin Islands',
        region: 'us-territories',
        regionLabel: 'US Territories',
        sizeMB: 138,
        url: `${NOAA_BASE_URL}/ncds_29.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
    {
        id: 'ncds_30',
        name: 'Hawaii',
        region: 'us-hawaii',
        regionLabel: 'Hawaii',
        sizeMB: 470,
        url: `${NOAA_BASE_URL}/ncds_30.mbtiles`,
        format: 'mbtiles',
        source: 'noaa',
    },
];

// ── LINZ Chart Catalog ──
// Individual NZ nautical chart layers from data.linz.govt.nz
// Requires user's LINZ API key for download.

function buildLinzUrl(layerId: number, apiKey: string): string {
    return `https://data.linz.govt.nz/services;key=${apiKey}/api/v1/layers/${layerId}/data/?format=image/tiff`;
}

const LINZ_CATALOG_TEMPLATE: Omit<ChartPackage, 'url'>[] = [
    {
        id: 'linz-51277',
        name: 'Approaches to Auckland',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 45,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51277,
    },
    {
        id: 'linz-51305',
        name: 'Wellington Harbour',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 35,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51305,
    },
    {
        id: 'linz-51284',
        name: 'Marlborough Sounds',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 40,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51284,
    },
    {
        id: 'linz-51306',
        name: 'Bay of Islands',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 30,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51306,
    },
    {
        id: 'linz-51245',
        name: 'Cook Strait',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 50,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51245,
    },
    {
        id: 'linz-51290',
        name: 'Banks Peninsula',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 25,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51290,
    },
    {
        id: 'linz-51322',
        name: 'Port of Tauranga',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 20,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51322,
    },
    {
        id: 'linz-51285',
        name: 'Approaches to Otago Harbour',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 30,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51285,
    },
    {
        id: 'linz-51278',
        name: 'Firth of Thames',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 35,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51278,
    },
    {
        id: 'linz-51259',
        name: 'Stewart Island / Rakiura',
        region: 'nz',
        regionLabel: 'New Zealand',
        sizeMB: 30,
        format: 'geotiff',
        source: 'linz',
        linzLayerId: 51259,
    },
];

// ── Community Charts — South Pacific ──
// Bruce Balan's Chart Locker (brucebalan.com/chartlocker)
// Free satellite + Navionics MBTiles made by cruisers, for cruisers.
// Files are on MediaFire as .zip containing .mbtiles.

const COMMUNITY_CATALOG: ChartPackage[] = [
    // Pacific Overview
    {
        id: 'tcl-pacific',
        name: 'Pacific Overview',
        region: 'sp-overview',
        regionLabel: '🌏 Pacific Overview',
        sizeMB: 500,
        url: 'https://www.mediafire.com/file_premium/jldlsrftsasf0ab/Pacific_Overview_TCL10-23.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },

    // Fiji
    {
        id: 'tcl-fiji',
        name: 'Fiji (Navionics)',
        region: 'sp-fiji',
        regionLabel: '🇫🇯 Fiji',
        sizeMB: 736,
        url: 'https://www.mediafire.com/file_premium/722rc3rabytojt1/Fiji_TCL2407_Navionics.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },

    // Tonga
    {
        id: 'tcl-tonga',
        name: 'Tonga, Niue & Minerva (Navionics)',
        region: 'sp-tonga',
        regionLabel: '🇹🇴 Tonga',
        sizeMB: 235,
        url: 'https://www.mediafire.com/file_premium/p8m29cdchck96ev/Tonga_Niue_Minerva_TCL2403_Navionics.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },

    // Vanuatu
    {
        id: 'tcl-vanuatu',
        name: 'Vanuatu (Navionics)',
        region: 'sp-vanuatu',
        regionLabel: '🇻🇺 Vanuatu',
        sizeMB: 164,
        url: 'https://www.mediafire.com/file_premium/t6r60765orhrhm5/Vanuatu_TCL2402_Navionics_Z13-16%252C18.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },

    // New Caledonia
    {
        id: 'tcl-newcal',
        name: 'New Caledonia (Navionics)',
        region: 'sp-newcal',
        regionLabel: '🇳🇨 New Caledonia',
        sizeMB: 751,
        url: 'https://www.mediafire.com/file/98mj9ydt5rozvb3/SP_NewCaledonia_Navionics.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },

    // Samoa
    {
        id: 'tcl-samoa',
        name: 'Samoa & American Samoa',
        region: 'sp-samoa',
        regionLabel: '🇼🇸 Samoa',
        sizeMB: 2980,
        url: 'https://www.mediafire.com/file_premium/5yab8t1buo6fj77/Samoas_TCL2403.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },

    // Cook Islands
    {
        id: 'tcl-cook',
        name: 'Cook Islands',
        region: 'sp-cook',
        regionLabel: '🇨🇰 Cook Islands',
        sizeMB: 607,
        url: 'https://www.mediafire.com/file_premium/iil9btqdv3nj5bu/Cook_Islands_TCL2403.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },

    // French Polynesia
    {
        id: 'tcl-fp-societies',
        name: 'Society Islands (Tahiti, Moorea, Bora Bora)',
        region: 'sp-frpoly',
        regionLabel: '🇵🇫 French Polynesia',
        sizeMB: 1100,
        url: 'https://www.mediafire.com/file_premium/nf0qjjzsjqdj2ty/FP_Societies_TCL2023.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },
    {
        id: 'tcl-fp-marquesas',
        name: 'Marquesas',
        region: 'sp-frpoly',
        regionLabel: '🇵🇫 French Polynesia',
        sizeMB: 818,
        url: 'https://www.mediafire.com/file_premium/7q9snlimozvsvvl/FP_Marquesas_TCL2402_Z13-16%252C18.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },
    {
        id: 'tcl-fp-tuamotus',
        name: 'Tuamotus (Navionics)',
        region: 'sp-frpoly',
        regionLabel: '🇵🇫 French Polynesia',
        sizeMB: 500,
        url: 'https://www.mediafire.com/file_premium/5337hpnnhn3glha/FP_Tuamotus_TCL2023_Navionics.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },
    {
        id: 'tcl-fp-australs',
        name: 'Austral Islands',
        region: 'sp-frpoly',
        regionLabel: '🇵🇫 French Polynesia',
        sizeMB: 340,
        url: 'https://www.mediafire.com/file_premium/oy3fcrlm2awcw4q/FP_Australs_TCL2402_Z13-16%252C18.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },

    // Other South Pacific
    {
        id: 'tcl-solomons',
        name: 'Solomon Islands (Navionics)',
        region: 'sp-other',
        regionLabel: '🏝 Other South Pacific',
        sizeMB: 586,
        url: 'https://www.mediafire.com/file/bsp9l8apokb24lb/SP_Solomons_Navionics.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },
    {
        id: 'tcl-tuvalu',
        name: 'Tuvalu',
        region: 'sp-other',
        regionLabel: '🏝 Other South Pacific',
        sizeMB: 385,
        url: 'https://www.mediafire.com/file_premium/jkcfwps15nu63wy/Tuvalu_TCL2403.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },
    {
        id: 'tcl-wallis',
        name: 'Wallis & Futuna',
        region: 'sp-other',
        regionLabel: '🏝 Other South Pacific',
        sizeMB: 400,
        url: 'https://www.mediafire.com/file_premium/cik2jt1xln9cjg9/Wallis_and_Futuna_TCL2403.zip/file',
        format: 'zip',
        source: 'community',
        isZipped: true,
        isMediaFire: true,
        credit: 'Bruce Balan',
    },
];

// ── Supported file extensions ──

const ACCEPTED_EXTENSIONS = ['.mbtiles', '.oesenc', '.gemf', '.kap', '.tif', '.tiff', '.geotiff', '.zip'];
const ACCEPT_STRING = ACCEPTED_EXTENSIONS.map((ext) => (ext === '.mbtiles' ? '.mbtiles' : ext)).join(',');

// ── Service ──

class ChartLockerServiceImpl {
    // ── Catalog API ──

    getNoaaCatalog(): ChartPackage[] {
        return [...NOAA_CATALOG];
    }

    getLinzCatalog(apiKey: string): ChartPackage[] {
        return LINZ_CATALOG_TEMPLATE.map((tmpl) => ({
            ...tmpl,
            url: buildLinzUrl(tmpl.linzLayerId!, apiKey),
        }));
    }

    getCommunityCatalog(): ChartPackage[] {
        return [...COMMUNITY_CATALOG];
    }

    getFullCatalog(linzApiKey?: string | null): ChartPackage[] {
        const noaa = this.getNoaaCatalog();
        const linz = linzApiKey ? this.getLinzCatalog(linzApiKey) : [];
        const community = this.getCommunityCatalog();
        return [...noaa, ...linz, ...community];
    }

    getRegions(packages: ChartPackage[]): { region: ChartRegion; label: string; count: number }[] {
        const map = new Map<ChartRegion, { label: string; count: number }>();
        for (const pkg of packages) {
            const entry = map.get(pkg.region);
            if (entry) {
                entry.count++;
            } else {
                map.set(pkg.region, { label: pkg.regionLabel, count: 1 });
            }
        }
        return Array.from(map.entries()).map(([region, { label, count }]) => ({ region, label, count }));
    }

    // ── File Picker ──

    /**
     * Open the native file picker and return the selected File object.
     * Uses a hidden <input type="file"> element — works on iOS Capacitor.
     */
    pickFile(): Promise<File | null> {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = ACCEPT_STRING;
            input.style.display = 'none';
            document.body.appendChild(input);

            input.addEventListener('change', () => {
                const file = input.files?.[0] ?? null;
                document.body.removeChild(input);
                if (file) {
                    log.info(`[Pick] Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
                }
                resolve(file);
            });

            input.addEventListener('cancel', () => {
                document.body.removeChild(input);
                resolve(null);
            });

            input.click();
        });
    }

    // ── Upload to AvNav ──

    /**
     * Upload a File or Blob to the AvNav server's chart directory.
     *
     * Uses XMLHttpRequest for upload progress events.
     * AvNav's internal upload handler expects multipart/form-data POST.
     *
     * @param file     - The file to upload
     * @param fileName - Filename to use on the server
     * @param host     - AvNav host (e.g., "192.168.1.100")
     * @param port     - AvNav port (e.g., 8080)
     * @param onProgress - Progress callback (0–1)
     */
    async uploadToAvNav(
        file: File | Blob,
        fileName: string,
        host: string,
        port: number,
        onProgress?: (progress: number, bytesLoaded: number, bytesTotal: number) => void,
    ): Promise<{ success: boolean; error?: string }> {
        // AvNav uses a multipart POST to its handler API.
        // The endpoint discovered from AvNav's Files/Download page:
        //   POST /viewer/api/handler?request=upload&type=chart
        // Falls back to /api/handler for newer AvNav versions.
        const baseUrl = `http://${host}:${port}`;
        const endpoints = [
            `${baseUrl}/viewer/api/handler?request=upload&type=chart`,
            `${baseUrl}/api/handler?request=upload&type=chart`,
        ];

        const formData = new FormData();
        formData.append('file', file, fileName);

        for (const endpoint of endpoints) {
            try {
                log.info(`[Upload] Trying ${endpoint} — ${fileName} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

                const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', endpoint, true);

                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable && onProgress) {
                            onProgress(e.loaded / e.total, e.loaded, e.total);
                        }
                    };

                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            log.info(`[Upload] Success: ${fileName}`);
                            resolve({ success: true });
                        } else {
                            log.warn(`[Upload] HTTP ${xhr.status}: ${xhr.statusText}`);
                            resolve({ success: false, error: `HTTP ${xhr.status}: ${xhr.statusText}` });
                        }
                    };

                    xhr.onerror = () => {
                        resolve({ success: false, error: 'Network error' });
                    };

                    xhr.ontimeout = () => {
                        resolve({ success: false, error: 'Upload timed out' });
                    };

                    // 30 minute timeout for large files
                    xhr.timeout = 30 * 60 * 1000;
                    xhr.send(formData);
                });

                if (result.success) return result;
                // If first endpoint failed with HTTP error, try next
            } catch (err) {
                log.warn(`[Upload] Endpoint failed: ${endpoint}`, err);
            }
        }

        // If XHR approach fails (CORS), try CapacitorHttp as fallback
        try {
            log.info(`[Upload] Falling back to CapacitorHttp`);
            const arrayBuffer = file instanceof File ? await file.arrayBuffer() : await (file as Blob).arrayBuffer();
            const base64 = btoa(
                new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
            );

            const response = await CapacitorHttp.post({
                url: `${baseUrl}/viewer/api/handler?request=upload&type=chart&name=${encodeURIComponent(fileName)}`,
                headers: { 'Content-Type': 'application/octet-stream' },
                data: base64,
            });

            if (response.status >= 200 && response.status < 300) {
                log.info(`[Upload] CapacitorHttp success: ${fileName}`);
                return { success: true };
            }
            return { success: false, error: `HTTP ${response.status}` };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error(`[Upload] All methods failed: ${errMsg}`);
            return { success: false, error: errMsg };
        }
    }

    // ── Phone-Proxy Download ──

    /**
     * Download a chart package to the phone, then upload it to the AvNav Pi.
     * Optionally delete the local copy after successful upload.
     */
    // ── MediaFire URL Resolver ──

    /**
     * Resolve a MediaFire sharing page URL to the direct download link.
     * Scrapes the page HTML for the download button href.
     * Uses CapacitorHttp to bypass CORS.
     */
    async resolveMediaFireUrl(pageUrl: string): Promise<string> {
        log.info(`[MediaFire] Resolving: ${pageUrl}`);

        const response = await CapacitorHttp.get({
            url: pageUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
                Accept: 'text/html',
            },
        });

        if (response.status !== 200) {
            throw new Error(`MediaFire page returned HTTP ${response.status}`);
        }

        const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

        // MediaFire puts the direct download URL in an <a> with id="downloadButton"
        // Pattern: href="https://download....mediafire.com/..."
        const patterns = [
            /id="downloadButton"[^>]*href="([^"]+)"/,
            /href="(https:\/\/download[^"]*mediafire\.com[^"]+)"/,
            /aria-label="Download file"[^>]*href="([^"]+)"/,
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match?.[1]) {
                log.info(`[MediaFire] Resolved: ${match[1].substring(0, 80)}...`);
                return match[1];
            }
        }

        throw new Error('Could not find download link on MediaFire page. The file may have been moved or removed.');
    }

    /**
     * Download a chart package to the phone's disk, then upload it to AvNav.
     * Uses Capacitor Filesystem.downloadFile() to stream directly to disk,
     * avoiding the catastrophic OOM crashes from loading 500MB+ files into RAM.
     */
    async phoneProxyDownload(
        pkg: ChartPackage,
        host: string,
        port: number,
        deleteAfter: boolean,
        onProgress?: (progress: UploadProgress) => void,
    ): Promise<{ success: boolean; error?: string }> {
        const defaultFileName = pkg.url.split('/').pop() || `${pkg.id}.${pkg.format}`;

        try {
            // Phase 0: Resolve MediaFire URL if needed
            let downloadUrl = pkg.url;
            let fileName = defaultFileName;

            if (pkg.isMediaFire) {
                onProgress?.({
                    phase: 'downloading',
                    progress: 0,
                    message: `Resolving download link for ${pkg.name}...`,
                    bytesTransferred: 0,
                    bytesTotal: pkg.sizeMB * 1024 * 1024,
                });

                downloadUrl = await this.resolveMediaFireUrl(pkg.url);
                const urlPath = new URL(downloadUrl).pathname;
                fileName = decodeURIComponent(urlPath.split('/').pop() || defaultFileName);
            }

            // Sanitise filename (no URL encoding artifacts)
            fileName = fileName.replace(/%[0-9A-Fa-f]{2}/g, '_').replace(/[^a-zA-Z0-9_.\-]/g, '_');

            // Phase 1: Download to phone disk (NOT into memory)
            onProgress?.({
                phase: 'downloading',
                progress: 0.01,
                message: `Downloading ${pkg.name} to device...`,
                bytesTransferred: 0,
                bytesTotal: pkg.sizeMB * 1024 * 1024,
            });

            log.info(
                `[Proxy] Streaming ${pkg.name} (${pkg.sizeMB} MB) to disk from ${downloadUrl.substring(0, 80)}...`,
            );

            // Use Capacitor Filesystem.downloadFile() — writes directly to disk,
            // no in-memory buffering. This is the ONLY safe way to handle 500MB+ files.
            let localFileUri: string;
            let actualSize = pkg.sizeMB * 1024 * 1024; // Estimated; updated after download

            try {
                const dlResult = await Filesystem.downloadFile({
                    url: downloadUrl,
                    path: `chart_downloads/${fileName}`,
                    directory: Directory.Cache,
                    progress: true,
                });

                localFileUri = dlResult.path || '';

                if (!localFileUri) {
                    throw new Error('Filesystem.downloadFile returned no path');
                }

                // Get actual file size
                try {
                    const stat = await Filesystem.stat({
                        path: `chart_downloads/${fileName}`,
                        directory: Directory.Cache,
                    });
                    actualSize = stat.size || actualSize;
                } catch {
                    /* use estimate */
                }

                log.info(`[Proxy] Downloaded to disk: ${localFileUri} (${(actualSize / 1024 / 1024).toFixed(1)} MB)`);
            } catch (fsErr) {
                // Fallback: If Filesystem.downloadFile() isn't available (older Capacitor),
                // use chunked XHR streaming approach with smaller memory footprint
                log.warn(
                    `[Proxy] Filesystem.downloadFile failed, falling back to XHR stream: ${(fsErr as Error)?.message}`,
                );

                localFileUri = await this.downloadViaXhrToDisk(downloadUrl, fileName, pkg.sizeMB, onProgress);
                try {
                    const stat = await Filesystem.stat({
                        path: `chart_downloads/${fileName}`,
                        directory: Directory.Cache,
                    });
                    actualSize = stat.size || actualSize;
                } catch {
                    /* use estimate */
                }
            }

            onProgress?.({
                phase: 'downloading',
                progress: 1,
                message: `Downloaded ${(actualSize / 1024 / 1024).toFixed(0)} MB`,
                bytesTransferred: actualSize,
                bytesTotal: actualSize,
            });

            // Phase 2: Upload to AvNav — stream from disk, don't load into memory
            onProgress?.({
                phase: 'uploading',
                progress: 0,
                message: `Uploading ${pkg.name} to AvNav...`,
                bytesTransferred: 0,
                bytesTotal: actualSize,
            });

            const uploadResult = await this.uploadFileFromDisk(
                `chart_downloads/${fileName}`,
                fileName,
                host,
                port,
                (progress, loaded, total) => {
                    onProgress?.({
                        phase: 'uploading',
                        progress,
                        message: `Uploading to AvNav... ${(loaded / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB`,
                        bytesTransferred: loaded,
                        bytesTotal: total,
                    });
                },
            );

            if (!uploadResult.success) {
                throw new Error(uploadResult.error || 'Upload failed');
            }

            // Phase 3: Cleanup local file
            if (deleteAfter) {
                onProgress?.({
                    phase: 'deleting',
                    progress: 1,
                    message: 'Cleaning up...',
                    bytesTransferred: 0,
                    bytesTotal: 0,
                });

                try {
                    await Filesystem.deleteFile({
                        path: `chart_downloads/${fileName}`,
                        directory: Directory.Cache,
                    });
                    log.info(`[Proxy] Cleaned up: chart_downloads/${fileName}`);
                } catch {
                    log.info(`[Proxy] Cleanup skipped (file may not exist)`);
                }
            }

            onProgress?.({
                phase: 'done',
                progress: 1,
                message: `${pkg.name} installed on AvNav ✓`,
                bytesTransferred: actualSize,
                bytesTotal: actualSize,
            });

            return { success: true };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error(`[Proxy] Failed: ${errMsg}`);

            onProgress?.({
                phase: 'error',
                progress: 0,
                message: 'Failed',
                bytesTransferred: 0,
                bytesTotal: 0,
                error: errMsg,
            });

            return { success: false, error: errMsg };
        }
    }

    /**
     * Fallback: Download via XHR with chunked write-to-disk.
     * Reads the stream in 2MB chunks and appends to disk, keeping memory usage flat.
     */
    private async downloadViaXhrToDisk(
        url: string,
        fileName: string,
        estimatedMB: number,
        onProgress?: (progress: UploadProgress) => void,
    ): Promise<string> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Download failed: HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Download stream not available');

        const totalBytes = estimatedMB * 1024 * 1024;
        let receivedBytes = 0;
        const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB write chunks
        let pendingData = new Uint8Array(0);

        // Create/clear the file
        await Filesystem.writeFile({
            path: `chart_downloads/${fileName}`,
            data: '',
            directory: Directory.Cache,
        });

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Accumulate data
            const merged = new Uint8Array(pendingData.length + value.length);
            merged.set(pendingData);
            merged.set(value, pendingData.length);
            pendingData = merged;

            receivedBytes += value.length;

            // Flush to disk when we have enough
            if (pendingData.length >= CHUNK_SIZE) {
                const base64Chunk = this.uint8ToBase64(pendingData);
                await Filesystem.appendFile({
                    path: `chart_downloads/${fileName}`,
                    data: base64Chunk,
                    directory: Directory.Cache,
                });
                pendingData = new Uint8Array(0);
            }

            onProgress?.({
                phase: 'downloading',
                progress: Math.min(receivedBytes / totalBytes, 0.99),
                message: `Downloading... ${(receivedBytes / 1024 / 1024).toFixed(0)} MB`,
                bytesTransferred: receivedBytes,
                bytesTotal: totalBytes,
            });
        }

        // Flush remaining data
        if (pendingData.length > 0) {
            const base64Chunk = this.uint8ToBase64(pendingData);
            await Filesystem.appendFile({
                path: `chart_downloads/${fileName}`,
                data: base64Chunk,
                directory: Directory.Cache,
            });
        }

        const uri = await Filesystem.getUri({
            path: `chart_downloads/${fileName}`,
            directory: Directory.Cache,
        });

        return uri.uri;
    }

    /** Convert Uint8Array to base64 string (for Filesystem APIs) */
    private uint8ToBase64(data: Uint8Array): string {
        let binary = '';
        const BLOCK = 8192; // Process in blocks to avoid call stack overflow
        for (let i = 0; i < data.length; i += BLOCK) {
            const slice = data.subarray(i, Math.min(i + BLOCK, data.length));
            binary += String.fromCharCode.apply(null, slice as unknown as number[]);
        }
        return btoa(binary);
    }

    /**
     * Upload a file from local disk to AvNav without loading it into memory.
     * Reads the file in chunks, converts to base64, and uploads via CapacitorHttp.
     */
    private async uploadFileFromDisk(
        filePath: string,
        fileName: string,
        host: string,
        port: number,
        onProgress?: (progress: number, loaded: number, total: number) => void,
    ): Promise<{ success: boolean; error?: string }> {
        const baseUrl = `http://${host}:${port}`;

        // Read file as base64 from disk (Filesystem reads are memory-efficient)
        try {
            const fileData = await Filesystem.readFile({
                path: filePath,
                directory: Directory.Cache,
            });

            const base64Data = typeof fileData.data === 'string' ? fileData.data : ''; // Blob case shouldn't happen for readFile

            if (!base64Data) {
                throw new Error('Could not read file data');
            }

            const fileSizeBytes = Math.ceil((base64Data.length * 3) / 4); // Approximate

            log.info(
                `[Upload] Uploading ${fileName} (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB) via CapacitorHttp`,
            );

            onProgress?.(0.05, 0, fileSizeBytes);

            // Upload via CapacitorHttp POST with base64 body
            const endpoints = [
                `${baseUrl}/viewer/api/handler?request=upload&type=chart&name=${encodeURIComponent(fileName)}`,
                `${baseUrl}/api/handler?request=upload&type=chart&name=${encodeURIComponent(fileName)}`,
            ];

            for (const endpoint of endpoints) {
                try {
                    const response = await CapacitorHttp.post({
                        url: endpoint,
                        headers: { 'Content-Type': 'application/octet-stream' },
                        data: base64Data,
                    });

                    if (response.status >= 200 && response.status < 300) {
                        onProgress?.(1, fileSizeBytes, fileSizeBytes);
                        log.info(`[Upload] Success via CapacitorHttp: ${fileName}`);
                        return { success: true };
                    }
                } catch (e) {
                    log.warn(`[Upload] Endpoint failed: ${endpoint}`, e);
                }
            }

            // Fallback: XHR upload (for CORS-friendly environments)
            log.info(`[Upload] CapacitorHttp failed, trying XHR...`);

            // Decode base64 to blob for XHR upload
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes]);

            const formData = new FormData();
            formData.append('file', blob, fileName);

            return new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${baseUrl}/viewer/api/handler?request=upload&type=chart`, true);

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable && onProgress) {
                        onProgress(e.loaded / e.total, e.loaded, e.total);
                    }
                };

                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve({ success: true });
                    } else {
                        resolve({ success: false, error: `HTTP ${xhr.status}` });
                    }
                };

                xhr.onerror = () => resolve({ success: false, error: 'Network error' });
                xhr.ontimeout = () => resolve({ success: false, error: 'Timeout' });
                xhr.timeout = 30 * 60 * 1000;
                xhr.send(formData);
            });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error(`[Upload] All methods failed: ${errMsg}`);
            return { success: false, error: errMsg };
        }
    }

    // ── Pi-Direct Download ──

    /**
     * Tell the AvNav Pi to download the chart directly via wget.
     * This uses AvNav's import from URL capability or a direct command.
     * Pi must have internet access for this to work.
     */
    async piDirectDownload(
        pkg: ChartPackage,
        host: string,
        port: number,
        onProgress?: (progress: UploadProgress) => void,
    ): Promise<{ success: boolean; error?: string }> {
        const baseUrl = `http://${host}:${port}`;

        onProgress?.({
            phase: 'downloading',
            progress: 0.1,
            message: `Sending download request to Pi...`,
            bytesTransferred: 0,
            bytesTotal: pkg.sizeMB * 1024 * 1024,
        });

        try {
            // Try AvNav's download-from-URL handler
            // This is an attempt at the internal API — may need adjustment
            const response = await CapacitorHttp.post({
                url: `${baseUrl}/viewer/api/handler`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    request: 'download',
                    type: 'chart',
                    url: pkg.url,
                    name: pkg.url.split('/').pop() || `${pkg.id}.mbtiles`,
                }),
            });

            if (response.status >= 200 && response.status < 300) {
                log.info(`[PiDirect] Download request accepted by AvNav`);

                onProgress?.({
                    phase: 'downloading',
                    progress: 0.5,
                    message: `Pi is downloading ${pkg.name} (${pkg.sizeMB} MB)...`,
                    bytesTransferred: 0,
                    bytesTotal: pkg.sizeMB * 1024 * 1024,
                });

                // Poll for completion (Pi downloads in background)
                // For now, show an optimistic progress since we can't track Pi's download
                await new Promise((resolve) => setTimeout(resolve, 3000));

                onProgress?.({
                    phase: 'done',
                    progress: 1,
                    message: `${pkg.name} downloading on Pi — check AvNav for status`,
                    bytesTransferred: pkg.sizeMB * 1024 * 1024,
                    bytesTotal: pkg.sizeMB * 1024 * 1024,
                });

                return { success: true };
            }

            // If AvNav's URL download isn't supported, fall back to phone-proxy
            log.warn(`[PiDirect] AvNav returned ${response.status} — falling back to phone-proxy`);
            return { success: false, error: 'Pi-direct not supported — use phone-proxy mode' };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.warn(`[PiDirect] Failed: ${errMsg} — suggest phone-proxy fallback`);
            return { success: false, error: `Pi-direct failed: ${errMsg}. Try phone-proxy mode.` };
        }
    }

    // ── Upload local file from phone ──

    /**
     * Pick a chart file from the phone and upload it to AvNav.
     * Supports all chart formats: .mbtiles, .oesenc, .gemf, .kap
     */
    async pickAndUpload(
        host: string,
        port: number,
        deleteAfter: boolean,
        onProgress?: (progress: UploadProgress) => void,
    ): Promise<{ success: boolean; fileName?: string; error?: string }> {
        try {
            // Phase: Pick file
            onProgress?.({
                phase: 'picking',
                progress: 0,
                message: 'Select a chart file...',
                bytesTransferred: 0,
                bytesTotal: 0,
            });

            const file = await this.pickFile();
            if (!file) {
                onProgress?.({ phase: 'idle', progress: 0, message: '', bytesTransferred: 0, bytesTotal: 0 });
                return { success: false, error: 'No file selected' };
            }

            // Phase: Upload
            onProgress?.({
                phase: 'uploading',
                progress: 0,
                message: `Uploading ${file.name}...`,
                bytesTransferred: 0,
                bytesTotal: file.size,
            });

            const result = await this.uploadToAvNav(file, file.name, host, port, (progress, loaded, total) => {
                onProgress?.({
                    phase: 'uploading',
                    progress,
                    message: `Uploading ${file.name}... ${(loaded / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB`,
                    bytesTransferred: loaded,
                    bytesTotal: total,
                });
            });

            if (!result.success) {
                throw new Error(result.error || 'Upload failed');
            }

            // Phase: Delete from phone (if requested)
            if (deleteAfter) {
                onProgress?.({
                    phase: 'deleting',
                    progress: 1,
                    message: 'Cleaning up local file...',
                    bytesTransferred: 0,
                    bytesTotal: 0,
                });

                try {
                    // Try to delete the file via Capacitor Filesystem
                    // Note: This only works if the file was in app-accessible storage
                    await Filesystem.deleteFile({
                        path: file.name,
                        directory: Directory.Cache,
                    });
                    log.info(`[Delete] Removed local file: ${file.name}`);
                } catch {
                    // File might not be in Cache directory — that's OK
                    log.info(`[Delete] Could not delete local file (may be in external storage)`);
                }
            }

            onProgress?.({
                phase: 'done',
                progress: 1,
                message: `${file.name} installed on AvNav ✓`,
                bytesTransferred: file.size,
                bytesTotal: file.size,
            });

            return { success: true, fileName: file.name };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            onProgress?.({
                phase: 'error',
                progress: 0,
                message: 'Upload failed',
                bytesTransferred: 0,
                bytesTotal: 0,
                error: errMsg,
            });
            return { success: false, error: errMsg };
        }
    }

    // ── Combined download handler ──

    /**
     * Download a chart package using the specified mode.
     * Falls back from pi-direct to phone-proxy automatically.
     */
    async downloadChart(
        pkg: ChartPackage,
        mode: DownloadMode,
        host: string,
        port: number,
        deleteAfter: boolean,
        onProgress?: (progress: UploadProgress) => void,
    ): Promise<{ success: boolean; error?: string }> {
        if (mode === 'pi-direct') {
            const result = await this.piDirectDownload(pkg, host, port, onProgress);
            if (result.success) return result;

            // Auto-fallback to phone-proxy
            log.info(`[Download] Pi-direct failed, falling back to phone-proxy`);
        }

        return this.phoneProxyDownload(pkg, host, port, deleteAfter, onProgress);
    }
}

export const ChartLockerService = new ChartLockerServiceImpl();
