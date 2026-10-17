"""Offline scalar headers of one immutable failed original; never decode values."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys

from catalogue import require

SOURCE = '9f2364baa85ed1ef4b796379789b8140616fa721'
ORIGINAL_BYTES = 1373100
ORIGINAL_SHA = '4e2e34400535158f696f1684c74bebb6d08126e37f9f713f29f94a30498bd733'
MAX_MESSAGES = 128
MAX_METADATA_BYTES = 256 * 1024
LONG_KEYS = (
    'edition', 'centre', 'subCentre', 'tablesVersion', 'localTablesVersion',
    'significanceOfReferenceTime', 'productionStatusOfProcessedData', 'typeOfProcessedData',
    'discipline', 'parameterCategory', 'parameterNumber', 'paramId',
    'typeOfFirstFixedSurface', 'scaleFactorOfFirstFixedSurface', 'scaledValueOfFirstFixedSurface',
    'typeOfSecondFixedSurface', 'scaleFactorOfSecondFixedSurface', 'scaledValueOfSecondFixedSurface',
    'level', 'productDefinitionTemplateNumber', 'typeOfGeneratingProcess', 'generatingProcessIdentifier',
    'gridDefinitionTemplateNumber', 'Ni', 'Nj', 'numberOfPoints', 'numberOfDataPoints',
    'iScansNegatively', 'jScansPositively', 'jPointsAreConsecutive', 'alternativeRowScanning',
    'scanningMode', 'resolutionAndComponentFlags', 'uvRelativeToGrid', 'shapeOfTheEarth',
    'dataDate', 'dataTime', 'year', 'month', 'day', 'hour', 'minute', 'second',
    'validityDate', 'validityTime', 'startStep', 'endStep', 'stepUnits',
    'forecastTime', 'indicatorOfUnitOfTimeRange', 'bitmapPresent', 'bitMapIndicator',
    'dataRepresentationTemplateNumber', 'bitsPerValue', 'binaryScaleFactor', 'decimalScaleFactor',
    'numberOfValues',
)
DOUBLE_KEYS = (
    'iDirectionIncrementInDegrees', 'jDirectionIncrementInDegrees',
    'latitudeOfFirstGridPointInDegrees', 'latitudeOfLastGridPointInDegrees',
    'longitudeOfFirstGridPointInDegrees', 'longitudeOfLastGridPointInDegrees', 'referenceValue',
)
STRING_KEYS = ('gridType', 'stepType', 'stepRange', 'stepUnits', 'units', 'shortName', 'name',
               'cfName', 'cfVarName', 'typeOfLevel', 'packingType')


def encoded(value):
    raw = (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()
    require(len(raw) <= MAX_METADATA_BYTES, 'scalar metadata exceeds256KiB')
    return raw


def scalar(codes, handle, key, kind):
    try:
        value = getattr(codes, 'codes_get_' + kind)(handle, key)
        if kind == 'long':
            require(type(value) is int, 'noninteger scalar')
        elif kind == 'double':
            require(type(value) in (float, int) and math.isfinite(value), 'nonfinite scalar')
        else:
            require(isinstance(value, str) and len(value.encode()) <= 256, 'scalar string bound')
        return {'available': True, 'value': value}
    except Exception as error:
        # Native exception strings can be unbounded; preserve only their class.
        return {'available': False, 'errorType': type(error).__name__[:80]}


def expected9f(field, metadata, native):
    expected = {'edition': 2, 'centre': 85, 'gridType': 'regular_ll', 'Ni': 721, 'Nj': 801,
                'numberOfPoints': 577521, 'jPointsAreConsecutive': 0, 'alternativeRowScanning': 0,
                'dataDate': 20261017, 'dataTime': 0, 'validityDate': 20261017, 'validityTime': 0,
                'startStep': 0, 'endStep': 0, 'stepUnits': 1, 'stepType': 'instant',
                'iDirectionIncrementInDegrees': .025, 'jDirectionIncrementInDegrees': .025}
    expected.update(zip(('discipline', 'parameterCategory', 'parameterNumber',
                         'typeOfFirstFixedSurface', 'level'), native.PARAMETERS[field]))
    if metadata.get('iScansNegatively') in (0, 1):
        reverse = metadata['iScansNegatively'] == 1
        expected.update(longitudeOfFirstGridPointInDegrees=174 if reverse else 156,
                        longitudeOfLastGridPointInDegrees=156 if reverse else 174)
    if metadata.get('jScansPositively') in (0, 1):
        reverse = metadata['jScansPositively'] == 0
        expected.update(latitudeOfFirstGridPointInDegrees=-10 if reverse else -30,
                        latitudeOfLastGridPointInDegrees=-30 if reverse else -10)
    if field in ('u10', 'v10'):
        expected['uvRelativeToGrid'] = 0
    differences = []
    for key, want in expected.items():
        actual = metadata.get(key)
        compare = native.longitude(actual) if key.startswith('longitude') and type(actual) in (float, int) else actual
        equal = (type(compare) in (float, int) and abs(compare - want) <= 1e-7
                 if key in native.DOUBLE_KEYS else compare == want)
        if not equal:
            differences.append({'key': key, 'expected': want, 'actual': actual})
    allowed = {'units': list(native.UNIT_SPELLINGS[field]), 'bitmapPresent': [0, 1],
               'iScansNegatively': [0, 1], 'jScansPositively': [0, 1]}
    for key, choices in allowed.items():
        if metadata.get(key) not in choices:
            differences.append({'key': key, 'expectedOneOf': choices, 'actual': metadata.get(key)})
    try:
        native.admit_metadata(metadata, 'NCALED', field, '2026-10-17T00:00:00Z', 0)
        scalar_gate = {'accepted': True, 'error': None}
    except ValueError as error:
        scalar_gate = {'accepted': False, 'error': str(error)[:256]}
    return {'expectedExact': expected, 'expectedOneOf': allowed, 'differences': differences,
            'unchanged9fScalarGate': scalar_gate}


def inspect_headers(raw, codes, native):
    rows = []
    selected = []
    for index, message in enumerate(native.exact_messages(raw)):
        require(index < MAX_MESSAGES, 'message count exceeds128')
        handle = codes.codes_new_from_message(message)
        try:
            headers = {key: scalar(codes, handle, key, 'long') for key in LONG_KEYS}
            headers.update({key: scalar(codes, handle, key, 'double') for key in DOUBLE_KEYS})
            # stepUnits has both its original numeric code and readable spelling.
            strings = {key: scalar(codes, handle, key, 'string') for key in STRING_KEYS}
            metadata = {key: cell['value'] for key, cell in headers.items() if cell['available']}
            metadata.update({key: cell['value'] for key, cell in strings.items()
                             if cell['available'] and key != 'stepUnits'})
            identity = tuple(metadata.get(key) for key in
                             ('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'))
            fields = [field for field in native.FIELDS if identity == native.PARAMETERS[field]]
            selected.extend(fields)
            rows.append({'ordinal': index, 'messageBytes': len(message),
                         'messageSha256': hashlib.sha256(message).hexdigest(),
                         'identity': list(identity), 'selected9fFields': fields,
                         'scalarHeaders': headers, 'stringHeaders': strings,
                         'comparison9f': {field: expected9f(field, metadata, native) for field in fields}})
            encoded(rows)  # Aggregate bound is enforced during traversal, not only at the end.
        finally:
            codes.codes_release(handle)
    require(rows, 'no original messages')
    return {'messages': rows, 'messageCount': len(rows),
            'missing9fFields': [field for field in native.FIELDS if field not in selected],
            'duplicate9fFields': [field for field in native.FIELDS if selected.count(field) > 1]}


def verify_source(source):
    from original_pilot_native import EXPECTED_FILES
    for name, digest in EXPECTED_FILES.items():
        path = source / 'tools/arome142' / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 128 * 1024,
                'frozen source path/size')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'frozen9f source changed')


def readonly_file(path):
    facts = path.stat()
    require(path.is_file() and not path.is_symlink() and facts.st_uid == 0
            and facts.st_mode & 0o222 == 0, 'staged file is not root-owned readonly')
    return {'path': str(path), 'uid': facts.st_uid, 'mode': oct(facts.st_mode & 0o777), 'bytes': facts.st_size}


def main():
    import resource
    from original_pilot_native import kernel_before_native
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    cgroup, kernel = kernel_before_native()
    verify_source(args.source)
    readonly = [readonly_file(path) for path in (
        Path(__file__).resolve(), Path(__file__).resolve().with_name('original_pilot_native.py'),
        Path(__file__).resolve().with_name('catalogue.py'), Path(sys.executable).resolve(),
        *(args.source / 'tools/arome142' / name for name in ('native.py', 'catalogue.py', 'native-requirements.lock')),
        args.input,
    )]
    require(args.input.is_file() and not args.input.is_symlink()
            and args.input.stat().st_size == ORIGINAL_BYTES, 'fixed original path/size')
    before = args.input.stat()
    raw = args.input.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == ORIGINAL_SHA, 'fixed captured original SHA mismatch')
    # Persist the actual pre-import admission even if a later native header fails.
    kernel_path = args.output.with_name('kernel-before-scalar-import.json')
    with kernel_path.open('xb') as stream:
        stream.write(encoded({'nativeImported': False, **kernel}))
    sys.path.insert(0, str(args.source / 'tools/arome142'))
    import native
    import eccodes
    result = inspect_headers(raw, eccodes, native)
    after = args.input.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
            'original changed while reading scalar headers')
    result.update(schema=1, inspectionAt=datetime.now(timezone.utc).isoformat(), source=SOURCE,
                  rootReadonlyStagedFiles=readonly,
                  originalBytes=len(raw), originalSha256=ORIGINAL_SHA, kernelBeforeNative=kernel,
                  originalRunUtc='2026-10-17T00:00:00Z', originalLeadHours=0,
                  actualEcCodesAPI=eccodes.codes_get_api_version(),
                  processMaxRSSKiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                  ownMemoryPeakBytes=int((cgroup / 'memory.peak').read_text()),
                  ownMemoryEvents=(cgroup / 'memory.events').read_text(),
                  valueArraysRequested=False, bitmapArraysRequested=False, originalFieldsAdmitted=False,
                  originalFreshnessRenewed=False, published=False, diagnosticOnly=True)
    with args.output.open('xb') as stream:
        stream.write(encoded(result))
    print(json.dumps({'outcome': 'scalar-only-inspection', 'messages': result['messageCount'],
                      'originalFieldsAdmitted': False, 'published': False}))


if __name__ == '__main__':
    main()
