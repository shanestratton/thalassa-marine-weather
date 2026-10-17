"""Strict local original-GRIB decoder. No network, source alias or publication.

The scalar metadata gate runs before ecCodes allocates any native value array.
Actual provider qualification is separate from generated GRIB round-trip tests.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from catalogue import AdmissionError, DOMAINS, HOURS, MAX_PACKET_BYTES, require

# WMO GRIB2 discipline/category/number/surface/level, not guessed short names.
PARAMETERS = {
    'u10': (0, 2, 2, 103, 10),
    'v10': (0, 2, 3, 103, 10),
    'msl': (0, 3, 1, 101, 0),
    't2m': (0, 0, 0, 103, 2),
    'rh2m': (0, 1, 1, 103, 2),
    'mask': (2, 0, 0, 1, 0),
}
FIELDS = ('u10', 'v10', 'msl', 't2m', 'rh2m')
UNITS = ('m/s', 'm/s', 'Pa', 'K', '%')
RANGES = {'u10': (-102, 102), 'v10': (-102, 102), 'msl': (80000, 110000),
          't2m': (193.15, 338.15), 'rh2m': (0, 100), 'mask': (0, 1)}
UNIT_SPELLINGS = {'u10': ('m s**-1', 'm s-1', 'm/s'), 'v10': ('m s**-1', 'm s-1', 'm/s'),
                  'msl': ('Pa',), 't2m': ('K',), 'rh2m': ('%',),
                  'mask': ('(0 - 1)', '(0-1)', 'Proportion', 'proportion', '1')}
INTEGER_KEYS = ('edition', 'centre', 'Ni', 'Nj', 'numberOfPoints', 'iScansNegatively',
                'jScansPositively', 'jPointsAreConsecutive', 'alternativeRowScanning',
                'dataDate', 'dataTime', 'validityDate', 'validityTime', 'startStep', 'endStep',
                'stepUnits', 'discipline', 'parameterCategory', 'parameterNumber',
                'typeOfFirstFixedSurface', 'level', 'bitmapPresent', 'uvRelativeToGrid')
DOUBLE_KEYS = ('iDirectionIncrementInDegrees', 'jDirectionIncrementInDegrees',
               'latitudeOfFirstGridPointInDegrees', 'latitudeOfLastGridPointInDegrees',
               'longitudeOfFirstGridPointInDegrees', 'longitudeOfLastGridPointInDegrees')


def longitude(value):
    require(type(value) in (float, int) and math.isfinite(value), 'original longitude missing')
    return (value + 180) % 360 - 180


def admit_metadata(metadata, domain, field, run_utc=None, offset=None):
    require(domain in DOMAINS and field in PARAMETERS, 'unadmitted original field/domain')
    spec = DOMAINS[domain]
    south, north, west, east = spec['bounds']
    require(metadata.get('iScansNegatively') in (0, 1) and metadata.get('jScansPositively') in (0, 1),
            'original scan direction missing')
    reverse_i = metadata['iScansNegatively'] == 1
    reverse_j = metadata['jScansPositively'] == 0
    expected = {'edition': 2, 'centre': 85, 'gridType': 'regular_ll', 'Ni': spec['width'],
                'Nj': spec['height'], 'numberOfPoints': spec['width'] * spec['height'],
                'jPointsAreConsecutive': 0, 'alternativeRowScanning': 0, 'bitmapPresent': metadata.get('bitmapPresent')}
    require(expected['bitmapPresent'] in (0, 1), 'original bitmap missing')
    keys = ('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level')
    expected.update(zip(keys, PARAMETERS[field]))
    if field != 'mask':
        require(type(offset) is int and 0 <= offset < HOURS, 'original lead bound')
        require(isinstance(run_utc, str), 'original forecast run missing')
        try:
            run = datetime.fromisoformat(run_utc.replace('Z', '+00:00'))
        except ValueError as error:
            raise AdmissionError('invalid original forecast date') from error
        require(run.tzinfo == timezone.utc and run.strftime('%Y-%m-%dT%H:00:00Z') == run_utc
                and run.minute == run.second == run.microsecond == 0
                and run.hour in spec['cycles'], 'unadmitted original forecast clock')
        valid = run + timedelta(hours=offset)
        expected.update(dataDate=int(run.strftime('%Y%m%d')), dataTime=run.hour * 100,
                        validityDate=int(valid.strftime('%Y%m%d')), validityTime=valid.hour * 100,
                        stepType='instant', startStep=offset, endStep=offset, stepUnits=1)
    require(all(metadata.get(key) == value for key, value in expected.items()),
            'original centre/parameter/level/grid/clock/step mismatch')
    require(metadata.get('units') in UNIT_SPELLINGS[field], 'original field units mismatch')
    if field in ('u10', 'v10'):
        require(metadata.get('uvRelativeToGrid') == 0, 'grid-relative wind is not earth-relative U/V')
    corners = {
        'latitudeOfFirstGridPointInDegrees': north if reverse_j else south,
        'latitudeOfLastGridPointInDegrees': south if reverse_j else north,
        'longitudeOfFirstGridPointInDegrees': east if reverse_i else west,
        'longitudeOfLastGridPointInDegrees': west if reverse_i else east,
        'iDirectionIncrementInDegrees': .025, 'jDirectionIncrementInDegrees': .025,
    }
    for key, value in corners.items():
        actual = metadata.get(key)
        if key.startswith('longitude'): actual = longitude(actual)
        require(type(actual) in (float, int) and math.isfinite(actual) and abs(actual - value) <= 1e-7,
                'original full-grid endpoints/increments mismatch')
    return reverse_i, reverse_j


def read_metadata(handle, codes):
    out = {key: codes.codes_get_long(handle, key) for key in INTEGER_KEYS}
    out.update({key: codes.codes_get_double(handle, key) for key in DOUBLE_KEYS})
    out.update({key: codes.codes_get_string(handle, key) for key in ('gridType', 'stepType', 'units')})
    return out


def exact_messages(raw):
    """No scanner skipping a corrupt prefix, trailer, gap or hidden member."""
    require(type(raw) is bytes and 20 <= len(raw) <= MAX_PACKET_BYTES, 'original GRIB packet byte bound')
    position = 0
    count = 0
    while position < len(raw):
        require(count < 128 and len(raw) - position >= 20 and raw[position:position + 4] == b'GRIB'
                and raw[position + 7] == 2, 'original GRIB2 framing/member bound')
        size = int.from_bytes(raw[position + 8:position + 16], 'big')
        require(20 <= size <= MAX_PACKET_BYTES and position + size <= len(raw)
                and raw[position + size - 4:position + size] == b'7777', 'original GRIB2 length/trailer')
        yield raw[position:position + size]
        position += size
        count += 1


def decode_packet(raw, domain, run_utc=None, offset=None, mask_only=False):
    import eccodes
    import numpy as np
    wanted = ('mask',) if mask_only else FIELDS
    result = {}
    facts = {}
    for message in exact_messages(raw):
        handle = eccodes.codes_new_from_message(message)
        try:
            identity = tuple(eccodes.codes_get_long(handle, key) for key in
                             ('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'))
            matching = [field for field in wanted if PARAMETERS[field] == identity]
            if not matching:
                continue
            field = matching[0]
            require(field not in result, 'duplicate original field')
            metadata = read_metadata(handle, eccodes)
            reverse_i, reverse_j = admit_metadata(metadata, domain, field, run_utc, offset)
            spec = DOMAINS[domain]
            values = np.asarray(eccodes.codes_get_values(handle), dtype='<f8')
            require(values.ndim == 1 and values.size == spec['width'] * spec['height'], 'original field cardinality')
            if metadata['bitmapPresent'] == 1:
                bitmap = np.asarray(eccodes.codes_get_array(handle, 'bitmap'))
                require(bitmap.ndim == 1 and bitmap.size == values.size
                        and np.all((bitmap == 0) | (bitmap == 1)), 'original bitmap cardinality/values')
                values[bitmap == 0] = np.nan
            low, high = RANGES[field]
            present = ~np.isnan(values)
            require(np.all(np.isfinite(values[present])) and np.all(values[present] >= low)
                    and np.all(values[present] <= high), 'original field physical range')
            values = values.reshape((spec['height'], spec['width']))
            if reverse_j: values = values[::-1, :]
            if reverse_i: values = values[:, ::-1]
            result[field] = np.array(values, dtype='<f8', order='C', copy=True)
            facts[field] = metadata
        finally:
            eccodes.codes_release(handle)
    require(set(result) == set(wanted), 'original required fields incomplete')
    if mask_only:
        require(bool(np.any(result['mask'] == 0)), 'original mask has no qualified sea cells')
    else:
        require(bool(np.any(np.isfinite(result['u10']) & np.isfinite(result['v10']))), 'original run wind entirely unknown')
    return result, facts
