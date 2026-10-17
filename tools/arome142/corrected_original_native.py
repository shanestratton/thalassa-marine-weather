"""One retained NCALED original, exact corrected grid; no network or publication.

The unchanged decoder remains authoritative. This controller cannot admit a
mask, missing lead, old clock, partial cohort or another scientific source.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

SOURCE = 'cf21a611c6b22db62449bc1658e7ae8b931476be'
ORIGINAL_BYTES = 1373100
ORIGINAL_SHA = '4e2e34400535158f696f1684c74bebb6d08126e37f9f713f29f94a30498bd733'
RUN = '2026-10-17T00:00:00Z'
EXPECTED_FILES = {
    'native.py': '8a17f8650a4bc95ce9ec3562dbf961e8a7bedd82e4c915f75a77c726ead76c69',
    'catalogue.py': 'd6f0aad3ab1a5dce00a6be38e51071753c49c9f9564966ed527c74a62839743d',
    'native-requirements.lock': 'cfd6e6ae3863ee58bd40f780df1fbf86443790989f050e2063163f2f96df2f64',
}
KERNEL_HELPER_SHA = 'e2d45ec24e0f63abfc03fe0a0a33e3d1c9b52ca47475f87148e2ba0d16a932a7'
MAX_TEXT = 256 * 1024


def require(ok, why):
    if not ok:
        raise ValueError(why)


def encoded(value):
    raw = (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()
    require(len(raw) <= MAX_TEXT, 'native evidence text bound')
    return raw


def verify_source(source, manifest):
    require(manifest == {'source': SOURCE, 'files': EXPECTED_FILES}, 'exact corrected source manifest')
    facts = []
    for name, digest in EXPECTED_FILES.items():
        path = source / 'tools/arome142' / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 128 * 1024,
                'frozen corrected source path/size')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'frozen corrected source changed')
        facts.append(readonly_file(path))
    return facts


def readonly_file(path):
    item = path.stat()
    require(path.is_file() and not path.is_symlink() and item.st_uid == 0 and item.st_mode & 0o222 == 0,
            'staged file is not root-owned readonly')
    return {'path': str(path), 'uid': item.st_uid, 'mode': oct(item.st_mode & 0o777), 'bytes': item.st_size}


def verify_input(path, capture):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size == ORIGINAL_BYTES,
            'exact retained original length/path')
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == ORIGINAL_SHA, 'exact retained original digest')
    admit_capture(capture)
    return raw


def admit_capture(capture):
    require(capture.get('outcome') == 'download-complete-native-unadmitted'
            and capture.get('originalSha256') == ORIGINAL_SHA
            and capture.get('writtenOriginalBytes') == ORIGINAL_BYTES
            and capture.get('nativeAdmitted') is False and capture.get('published') is False,
            'original capture provenance')


def stable_stat(path):
    row = path.stat()
    return row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns


def exact_module(module, path):
    require(Path(module.__file__).resolve() == path.resolve(), 'decoder module came from another source')


def field_summary(values, metadata, packing, np):
    require(values.shape == (491, 521) and values.size == 255811, 'exact corrected full-cell cardinality')
    finite = np.isfinite(values)
    count = int(np.count_nonzero(finite))
    return {'shape': list(values.shape), 'cells': int(values.size), 'finiteCells': count,
            'unknownCells': int(values.size - count),
            'minimum': float(np.min(values[finite])) if count else None,
            'maximum': float(np.max(values[finite])) if count else None,
            'decodedF64LEsha256': hashlib.sha256(values.tobytes(order='C')).hexdigest(),
            'originalMetadata': metadata, 'packing': packing}


def main():
    import resource
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--capture', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    helper = Path(__file__).resolve().with_name('original_pilot_native.py')
    require(hashlib.sha256(helper.read_bytes()).hexdigest() == KERNEL_HELPER_SHA, 'unchanged original kernel helper')
    from original_pilot_native import kernel_before_native
    cgroup, kernel = kernel_before_native()
    # No catalogue import is allowed before the exact corrected module path.
    require(not {'catalogue', 'native', 'eccodes', 'numpy'}.intersection(sys.modules), 'preloaded scientific module')
    readonly = verify_source(args.source, json.loads(args.manifest.read_bytes()))
    readonly.extend(readonly_file(path) for path in (Path(__file__).resolve(), helper,
                                                    Path(sys.executable).resolve(), args.input,
                                                    args.capture, args.manifest))
    before = stable_stat(args.input)
    raw = verify_input(args.input, json.loads(args.capture.read_bytes()))
    with args.output.with_name('kernel-before-corrected-native.json').open('xb') as stream:
        stream.write(encoded({'nativeImported': False, **kernel}))
    sys.path.insert(0, str(args.source / 'tools/arome142'))
    import catalogue
    import native
    exact_module(catalogue, args.source / 'tools/arome142/catalogue.py')
    exact_module(native, args.source / 'tools/arome142/native.py')
    catalogue.original_run(RUN, 'NCALED', datetime.now(timezone.utc))
    import eccodes
    import numpy as np
    packing = {}
    for message in native.exact_messages(raw):
        handle = eccodes.codes_new_from_message(message)
        try:
            identity = tuple(eccodes.codes_get_long(handle, key) for key in
                             ('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'))
            for field in native.FIELDS:
                if identity == native.PARAMETERS[field]:
                    require(field not in packing, 'duplicate selected original header')
                    # Authoritative scalar check still runs before any array request.
                    metadata = native.read_metadata(handle, eccodes)
                    native.admit_metadata(metadata, 'NCALED', field, RUN, 0)
                    packing[field] = {'packingType': eccodes.codes_get_string(handle, 'packingType'),
                                      'bitsPerValue': eccodes.codes_get_long(handle, 'bitsPerValue'),
                                      'bitmapPresent': metadata['bitmapPresent']}
        finally:
            eccodes.codes_release(handle)
    require(set(packing) == set(native.FIELDS), 'selected original headers incomplete')
    # Call unchanged committed native.py; no monkeypatch, range widening or cropping.
    fields, metadata = native.decode_packet(raw, 'NCALED', RUN, 0)
    summaries = {field: field_summary(fields[field], metadata[field], packing[field], np) for field in native.FIELDS}
    require(stable_stat(args.input) == before, 'retained original changed during native decode')
    catalogue.original_run(RUN, 'NCALED', datetime.now(timezone.utc))
    libraries = []
    for name in sorted({row.split()[-1] for row in Path('/proc/self/maps').read_text().splitlines() if '.so' in row and '/' in row}):
        path = Path(name)
        if path.is_file():
            require(path.stat().st_size <= 128 * 1024**2 and len(libraries) < 256, 'native closure bound')
            libraries.append({'path': str(path.resolve()), 'bytes': path.stat().st_size,
                              'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    require(not {'xarray', 'netCDF4', 'h5py', 'rasterio'}.intersection(sys.modules), 'unreviewed native module')
    result = {'schema': 1, 'source': SOURCE, 'inspectedAt': datetime.now(timezone.utc).isoformat(),
              'originalRunUtc': RUN, 'originalLeadHours': 0, 'originalExpiresUtc': '2026-10-17T18:00:00Z',
              'inputBytes': len(raw), 'inputSha256': ORIGINAL_SHA, 'rootReadonlyStagedFiles': readonly,
              'kernelBeforeNative': kernel, 'fields': summaries, 'actualEcCodesAPI': eccodes.codes_get_api_version(),
              'actualNumpy': np.__version__, 'loadedLibraries': libraries,
              'processMaxRSSKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              'ownMemoryPeakBytes': int((cgroup / 'memory.peak').read_text()),
              'ownMemoryEvents': (cgroup / 'memory.events').read_text(),
              'originalFiveFieldsAdmitted': True, 'originalLandSeaMaskAdmitted': False,
              'full49HourCohortAdmitted': False, 'freshnessRenewed': False, 'published': False,
              'providerRequests': 0, 'retainedLeadZeroOnly': True}
    with args.output.open('xb') as stream:
        stream.write(encoded(result))
    print(json.dumps({'outcome': 'corrected-original-five-field-native-pilot-passed',
                      'source': SOURCE, 'originalSha256': ORIGINAL_SHA, 'full49HourCohortAdmitted': False}))


if __name__ == '__main__':
    main()
