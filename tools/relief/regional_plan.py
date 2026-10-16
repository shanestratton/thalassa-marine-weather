#!/usr/bin/env python3
"""Arithmetic-only regional relief review plan. Never fetches, builds or uploads."""
import argparse
import json
import math

MERCATOR_LIMIT = 85.05112878
OUTPUT_LIMIT = 30_000_000_000
OBJECT_LIMIT = 1_500_000
INPUT_LIMIT = 80_000_000_000
EXPANDED_LIMIT = 100_000_000_000
PROFILES = {
    'au250': {
        'provider': 'Geoscience Australia', 'edition': 'AusBathyTopo Australia 2026 250m, eCat151280',
        'bounds': [92, -60, 172, -8], 'minzoom': 8, 'maxzoom': 10,
        'nominalGridMetres': 250, 'verticalDatum': 'Approximately MSL',
        'metadata': 'https://pid.geoscience.gov.au/dataset/ga/151280',
        'licence': 'CC-BY-4.0; retain Commonwealth/GA attribution and no-navigation notice',
        'inputBytes': 2_380_292_468, 'exactProofComplete': True,
    },
    'eu': {
        'provider': 'EMODnet Bathymetry Consortium', 'edition': 'DTM 2024',
        'bounds': [-36, 15, 43, MERCATOR_LIMIT], 'minzoom': 8, 'maxzoom': 11,
        'nominalGridMetres': 115, 'verticalDatum': 'LAT; MSL variant exists separately',
        'metadata': 'https://doi.org/10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1',
        'licence': 'EU-derived product CC-BY-4.0 by default; selected tile metadata still required',
        'inputBytes': None, 'exactProofComplete': False,
        'hold': 'Pin selected source tiles and metadata; retain non-GEBCO/source-quality coverage mask',
    },
    'us': {
        'provider': 'CIRES / NOAA NCEI', 'edition': 'CUDEM, selected official source editions',
        'bounds': None, 'minzoom': 8, 'maxzoom': 13,
        'nominalGridMetres': None, 'verticalDatum': 'Per raster; never relabel NAVD88 as MSL',
        'metadata': 'https://www.ncei.noaa.gov/products/coastal-elevation-models',
        'licence': 'US government work; exact source citation and no-navigation restrictions',
        'inputBytes': None, 'exactProofComplete': False,
        'hold': 'Inventory real coastal raster footprints first; no rectangular whole-US acquisition',
    },
    'pr': {
        'provider': 'CIRES / NOAA NCEI', 'edition': 'CUDEM Puerto Rico, tile2022v2; proof footprint only',
        'bounds': [-66.00018518518665, 17.749814814813326, -65.74981481481333, 18.000185185186673],
        'minzoom': 8, 'maxzoom': 13, 'nominalGridMetres': 3.4, 'verticalDatum': 'PRVD02',
        'metadata': 'https://chs.coast.noaa.gov/htdata/raster5/elevation/NCEI_ninth_Topobathy_PuertoRico_9525/cudem_ninth_pr_m9525_met_forHumans.html',
        'licence': 'US government work; CIRES / NOAA DOI10.25921/ds9v-ky35; not for navigation',
        'inputBytes': 141_980_462, 'exactProofComplete': True,
        'hold': 'This is one raster footprint; it cannot activate a whole Caribbean layer',
    },
    'nz': {
        'provider': 'LINZ', 'edition': 'No reviewed bathymetric raster acquired',
        'bounds': None, 'minzoom': None, 'maxzoom': None,
        'nominalGridMetres': None, 'verticalDatum': 'Unknown until actual raster metadata',
        'metadata': 'https://www.linz.govt.nz/products-services/data/types-linz-data/hydrographic-data',
        'licence': 'Dataset-specific licence and actual data required; an LDS index is not a depth grid',
        'inputBytes': None, 'exactProofComplete': False,
        'hold': 'Identify a downloadable open 3DCM raster with its footprint, or obtain requested LINZ data',
    },
}


def tile_range(bounds, zoom):
    if (not isinstance(zoom, int) or not 0 <= zoom <= 14 or len(bounds) != 4
            or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in bounds)):
        raise ValueError('Invalid arithmetic tile plan')
    west, south, east, north = bounds
    if not (-180 <= west < east <= 180 and -MERCATOR_LIMIT <= south < north <= MERCATOR_LIMIT):
        raise ValueError('Invalid geographic footprint')
    n = 2 ** zoom
    x = lambda lon: max(0, min(n - 1, math.floor((lon + 180) / 360 * n)))
    y = lambda lat: max(0, min(n - 1, math.floor((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)))
    return x(west), y(north), x(east), y(south)


def plan_region(profile):
    result = {**profile, 'published': False, 'generation': 'v2',
              'purpose': 'Illustrative seafloor relief only; no navigation, sampling, clearance or alarms'}
    if profile['bounds'] is None:
        return {**result, 'objectsUpperBound': None, 'eligibleForNextBuildReview': False}
    maximum = profile['maxzoom']
    if maximum >= 15 and (profile['nominalGridMetres'] is None or profile['nominalGridMetres'] > 10):
        raise ValueError('Fine zoom is not allowed for a coarse or unknown grid')
    counts = []
    for zoom in range(profile['minzoom'], maximum + 1):
        x0, y0, x1, y1 = tile_range(profile['bounds'], zoom)
        counts.append({'zoom': zoom, 'objectsUpperBound': (x1 - x0 + 1) * (y1 - y0 + 1) * 2})
    objects = sum(row['objectsUpperBound'] for row in counts)
    return {**result, 'perZoom': counts, 'objectsUpperBound': objects,
            'estimatedBytesAt16KiBPerObject': objects * 16384,
            'eligibleForNextBuildReview': bool(profile['exactProofComplete'] and not profile.get('hold'))}


def review_plan(ids):
    if not ids or len(ids) != len(set(ids)) or any(key not in PROFILES for key in ids):
        raise ValueError('Select each known region at most once')
    regions = {key: plan_region(PROFILES[key]) for key in ids}
    known_objects = sum(row['objectsUpperBound'] or 0 for row in regions.values())
    known_input = sum(row['inputBytes'] or 0 for row in regions.values())
    estimate = known_objects * 16384
    if known_objects > OBJECT_LIMIT or known_input > INPUT_LIMIT or estimate > OUTPUT_LIMIT:
        raise ValueError('Selected regions exceed the preflight budget; lower detail or narrow real footprints')
    return {'dryRunOnly': True, 'root': '/srv/weather/thalassa-relief135-build',
            'generation': 'v2', 'regions': regions,
            'knownObjectsUpperBound': known_objects, 'knownInputBytes': known_input,
            'unresolvedFootprints': [key for key, value in regions.items() if value['objectsUpperBound'] is None],
            'fullGenerationBuilt': False,
            'allInputsKnown': all(value['inputBytes'] is not None for value in regions.values()),
            'caps': {'inputBytes': INPUT_LIMIT, 'expandedBytes': EXPANDED_LIMIT,
                     'outputBytes': OUTPUT_LIMIT, 'objects': OBJECT_LIMIT,
                     'downloadLanes': 2, 'gdalWorkers': 1, 'gdalMemoryBytes': 1024 ** 3},
            'grossCostCeilingsUSD': {'monthlyStandardStorage': 0.45, 'initialClassAWrites': 9},
            'costSource': 'https://developers.cloudflare.com/r2/pricing/',
            'coverageMasks': 'Retained as local QA sidecars; not uploaded as extra R2 objects; included in output byte cap',
            'activation': 'Held: no upload or app row until full manifests, masks, hashes, seams and credits are reviewed'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region', action='append', choices=sorted(PROFILES), required=True)
    args = parser.parse_args()
    print(json.dumps(review_plan(args.region), indent=2))


if __name__ == '__main__':
    main()
