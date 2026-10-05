/**
 * Darwin Core for a sighting: the mapping a phase 3 export to the Atlas of
 * Living Australia (or GBIF / OBIS) will use. The table already stores the
 * Darwin Core fields under snake_case names; this names them, fills the
 * group placeholder for group-only rows, and puts the boat's context in
 * dynamicProperties.
 *
 * Remarks are exported only with the observer's consent, and a public export
 * says how the position was generalised (informationWithheld,
 * dataGeneralizations).
 */
import { GROUP_PLACEHOLDERS, PUBLIC_GRID } from './catalogue';
import type { SightingRow } from './types';

export interface DarwinCoreTaxon {
    vernacularName: string | null;
    taxonRank: string | null;
    family: string | null;
    class: string | null;
}

export interface DarwinCoreOptions {
    /** Names from sighting_taxa / the catalogue, for the row's scientific name. */
    taxon?: DarwinCoreTaxon | null;
    /** Export occurrenceRemarks (the observer said yes). */
    includeRemarks?: boolean;
    /** A public export: the position is a grid-cell centre of this size. */
    generalisedDegrees?: number | null;
}

export type DarwinCoreRecord = Record<string, string | number | null>;

export function toDarwinCore(row: SightingRow, options: DarwinCoreOptions = {}): DarwinCoreRecord {
    const placeholder = GROUP_PLACEHOLDERS[row.taxon_group];
    const named = !!row.scientific_name;
    const accuracy = row.position_accuracy_m ?? row.coordinate_uncertainty_in_meters ?? null;
    const distance = row.observed_distance_m ?? 1000;
    let uncertainty = accuracy === null ? null : accuracy + distance;
    const grid = options.generalisedDegrees ?? null;
    if (grid) {
        const gridM =
            grid >= PUBLIC_GRID.coarse.degrees ? PUBLIC_GRID.coarse.uncertaintyM : PUBLIC_GRID.fine.uncertaintyM;
        uncertainty = Math.max(uncertainty ?? 0, gridM);
    }

    const dynamic: Record<string, number | string | boolean> = {};
    const put = (key: string, value: number | string | boolean | null) => {
        if (value !== null && value !== undefined) dynamic[key] = value;
    };
    put('calfPresent', row.has_calf);
    put('countIsEstimate', row.count_is_estimate);
    put('seaSurfaceTemperatureC', row.sea_temp_c);
    put('sstSource', row.sea_temp_source);
    put('waterDepthM', row.water_depth_m);
    put('depthReference', row.depth_reference);
    put('windSpeedKn', row.wind_speed_kts);
    put('windDirectionDeg', row.wind_dir_deg);
    put('windSource', row.wind_source);
    put('waveHeightM', row.wave_height_m);
    put('wxModel', row.wx_model);
    put('sogKn', row.sog_kts);
    put('cogDeg', row.cog_deg);
    put('headingDeg', row.heading_deg);

    const source = row.position_source ?? 'unknown';
    return {
        occurrenceID: `urn:uuid:${row.id}`,
        basisOfRecord: 'HumanObservation',
        occurrenceStatus: 'present',
        eventDate: row.event_date,
        parentEventID: row.voyage_id,
        scientificName: named ? row.scientific_name : placeholder.scientific,
        taxonRank: named ? (options.taxon?.taxonRank ?? null) : placeholder.rank,
        vernacularName: named ? (options.taxon?.vernacularName ?? null) : null,
        family: named ? (options.taxon?.family ?? null) : null,
        class: named ? (options.taxon?.class ?? null) : null,
        individualCount: row.individual_count,
        organismQuantity: row.individual_count,
        organismQuantityType: 'individuals',
        behavior: row.behavior,
        decimalLatitude: row.decimal_latitude,
        decimalLongitude: row.decimal_longitude,
        geodeticDatum: 'WGS84',
        coordinateUncertaintyInMeters: uncertainty,
        georeferenceRemarks:
            row.sampling_protocol === 'opportunistic shore-based observation'
                ? `Position of the observer ashore, source: ${source}`
                : `Position of the observing vessel, source: ${source}`,
        samplingProtocol: row.sampling_protocol,
        occurrenceRemarks: options.includeRemarks ? row.occurrence_remarks : null,
        dynamicProperties: Object.keys(dynamic).length ? JSON.stringify(dynamic) : null,
        informationWithheld: grid ? 'Exact position and time withheld; photos and remarks withheld' : null,
        dataGeneralizations: grid ? `Coordinates generalised to the centre of a ${grid} degree grid cell` : null,
    };
}
