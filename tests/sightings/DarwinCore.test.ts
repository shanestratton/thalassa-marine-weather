/**
 * Darwin Core for a sighting: what a phase 3 export to the Atlas of Living
 * Australia will send. Fictional boat and observer.
 */
import { describe, expect, it } from 'vitest';
import { toDarwinCore } from '../../services/sightings/darwinCore';
import type { SightingRow } from '../../services/sightings/types';

const ROW: SightingRow = {
    id: '0b6f3f2e-8a51-4c3e-9d0a-1f2e3d4c5b6a',
    observer_id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    vessel_owner_id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    boat_id: null,
    voyage_id: 'voyage_1790000000000_kittiwake',
    visibility: 'crew',
    taxon_group: 'whale',
    scientific_name: 'Megaptera novaeangliae',
    individual_count: 3,
    count_is_estimate: false,
    has_calf: true,
    behavior: 'breaching',
    observed_distance_m: 500,
    event_date: '2026-08-14T01:20:00.000Z',
    decimal_latitude: -20.2567,
    decimal_longitude: 148.9512,
    position_accuracy_m: 10,
    coordinate_uncertainty_in_meters: 14,
    position_source: 'bus',
    position_fix_at: '2026-08-14T01:19:58.000Z',
    sampling_protocol: 'opportunistic vessel-based observation',
    sea_temp_c: 22.4,
    sea_temp_source: 'instrument',
    water_depth_m: 31.5,
    depth_reference: 'below-transducer',
    wind_speed_kts: 14,
    wind_dir_deg: 120,
    wind_source: 'forecast',
    wave_height_m: 1.2,
    wx_model: 'ecmwf_ifs025',
    sog_kts: 5.6,
    cog_deg: 350,
    heading_deg: 352,
    occurrence_remarks: 'Mother and calf, slapping fins',
    photo_paths: [],
    observer_display: 'Wren',
    credit_public: false,
    client_version: 'thalassa/test',
};

describe('toDarwinCore', () => {
    it('maps a named sighting to Darwin Core terms', () => {
        const dwc = toDarwinCore(ROW, {
            taxon: {
                vernacularName: 'Humpback whale',
                taxonRank: 'species',
                family: 'Balaenopteridae',
                class: 'Mammalia',
            },
        });
        expect(dwc).toMatchObject({
            occurrenceID: 'urn:uuid:0b6f3f2e-8a51-4c3e-9d0a-1f2e3d4c5b6a',
            basisOfRecord: 'HumanObservation',
            occurrenceStatus: 'present',
            eventDate: '2026-08-14T01:20:00.000Z',
            parentEventID: 'voyage_1790000000000_kittiwake',
            scientificName: 'Megaptera novaeangliae',
            taxonRank: 'species',
            vernacularName: 'Humpback whale',
            family: 'Balaenopteridae',
            class: 'Mammalia',
            individualCount: 3,
            organismQuantity: 3,
            organismQuantityType: 'individuals',
            behavior: 'breaching',
            decimalLatitude: -20.2567,
            decimalLongitude: 148.9512,
            geodeticDatum: 'WGS84',
            // GPS accuracy plus how far off the animal was.
            coordinateUncertaintyInMeters: 510,
            georeferenceRemarks: 'Position of the observing vessel, source: bus',
            samplingProtocol: 'opportunistic vessel-based observation',
            informationWithheld: null,
            dataGeneralizations: null,
        });
        expect(JSON.parse(String(dwc.dynamicProperties))).toEqual({
            calfPresent: true,
            countIsEstimate: false,
            seaSurfaceTemperatureC: 22.4,
            sstSource: 'instrument',
            waterDepthM: 31.5,
            depthReference: 'below-transducer',
            windSpeedKn: 14,
            windDirectionDeg: 120,
            windSource: 'forecast',
            waveHeightM: 1.2,
            wxModel: 'ecmwf_ifs025',
            sogKn: 5.6,
            cogDeg: 350,
            headingDeg: 352,
        });
    });

    it('withholds remarks unless the observer said yes', () => {
        expect(toDarwinCore(ROW).occurrenceRemarks).toBeNull();
        expect(toDarwinCore(ROW, { includeRemarks: true }).occurrenceRemarks).toBe('Mother and calf, slapping fins');
    });

    it("carries the group's placeholder taxon for a group-only sighting", () => {
        const dwc = toDarwinCore({ ...ROW, taxon_group: 'turtle', scientific_name: null, observed_distance_m: null });
        expect(dwc.scientificName).toBe('Chelonioidea');
        expect(dwc.taxonRank).toBe('superfamily');
        expect(dwc.vernacularName).toBeNull();
        expect(dwc.coordinateUncertaintyInMeters).toBe(1010);
    });

    it('says how a public export was generalised', () => {
        const dwc = toDarwinCore(ROW, { generalisedDegrees: 0.1 });
        expect(dwc.coordinateUncertaintyInMeters).toBe(7850);
        expect(dwc.dataGeneralizations).toBe('Coordinates generalised to the centre of a 0.1 degree grid cell');
        expect(dwc.informationWithheld).toMatch(/withheld/);
    });

    it('names a shore-based position as the observer ashore', () => {
        const dwc = toDarwinCore({
            ...ROW,
            position_source: 'phone',
            sampling_protocol: 'opportunistic shore-based observation',
        });
        expect(dwc.georeferenceRemarks).toBe('Position of the observer ashore, source: phone');
    });
});
