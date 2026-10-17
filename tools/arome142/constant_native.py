"""Draft fixed constant-original qualification; no transport or publication.

Pending review and a genuine conditional original acquisition. Uses the exact
corrected decoder without cropping, remapping or treating fractional mask as sea.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

from corrected_original_native import (SOURCE, EXPECTED_FILES, KERNEL_HELPER_SHA,
    encoded, exact_module, field_summary, readonly_file, require, stable_stat, verify_source)

MASK_BYTES = 44900
ETAG = '"9ce9149bbab869fdf81088046daa695c"'
URL = 'https://static.data.gouv.fr/resources/champs-constant-1/20250217-090714/constant-ncaled0025.grib2'
ATTEMPT = 'ncaled-20261017-00-constant-conditional-v1'
RUN = '2026-10-17T00:00:00Z'


def admit_capture(capture, transport, digest):
    require(capture.get('source') == SOURCE and capture.get('attempt') == ATTEMPT
            and capture.get('outcome') == 'download-complete-native-unadmitted'
            and capture.get('writtenOriginalBytes') == MASK_BYTES
            and capture.get('originalSha256') == digest
            and capture.get('nativeAdmitted') is False and capture.get('published') is False,
            'fixed conditional mask capture provenance')
    require(transport.get('outcome') == 'complete-exact-original'
            and transport.get('method') == 'GET' and transport.get('url') == URL
            and transport.get('status') == 200 and transport.get('ifMatch') == ETAG
            and transport.get('bodyBytes') == MASK_BYTES
            and transport.get('redirects') == 0 and transport.get('retries') == 0
            and transport.get('range') is False and transport.get('credentials') is False,
            'fixed conditional mask transport provenance')
    headers = transport.get('headers')
    require(type(headers) is dict and headers.get('content-length') == str(MASK_BYTES)
            and headers.get('etag') == ETAG
            and headers.get('content-encoding', 'identity').lower() in ('', 'identity'),
            'fixed conditional mask response identity')


def main():
    import resource
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--capture', type=Path, required=True)
    parser.add_argument('--transport', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    helper = Path(__file__).resolve().with_name('original_pilot_native.py')
    require(hashlib.sha256(helper.read_bytes()).hexdigest() == KERNEL_HELPER_SHA,
            'unchanged original kernel helper')
    from original_pilot_native import kernel_before_native
    cgroup, kernel = kernel_before_native()
    require(not {'catalogue', 'native', 'eccodes', 'numpy'}.intersection(sys.modules), 'preloaded scientific module')
    readonly = verify_source(args.source, json.loads(args.manifest.read_bytes()))
    readonly.extend(readonly_file(path) for path in (Path(__file__).resolve(), helper,
        Path(__file__).resolve().with_name('corrected_original_native.py'), Path(sys.executable).resolve(),
        args.input, args.capture, args.transport, args.manifest))
    before = stable_stat(args.input)
    require(args.input.stat().st_size == MASK_BYTES, 'fixed constant original size')
    raw = args.input.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    transport = json.loads(args.transport.read_bytes())
    admit_capture(json.loads(args.capture.read_bytes()), transport, digest)
    with args.output.with_name('kernel-before-constant-native.json').open('xb') as stream:
        stream.write(encoded({'nativeImported': False, **kernel}))
    sys.path.insert(0, str(args.source / 'tools/arome142'))
    import catalogue
    import native
    exact_module(catalogue, args.source / 'tools/arome142/catalogue.py')
    exact_module(native, args.source / 'tools/arome142/native.py')
    catalogue.original_run(RUN, 'NCALED', datetime.now(timezone.utc))
    import eccodes
    import numpy as np
    inventory = []
    selected = 0
    for index, message in enumerate(native.exact_messages(raw)):
        require(index < 128, 'constant original message bound')
        handle = eccodes.codes_new_from_message(message)
        try:
            identity = tuple(eccodes.codes_get_long(handle, key) for key in
                ('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'))
            record = {'ordinal': index, 'bytes': len(message), 'sha256': hashlib.sha256(message).hexdigest(),
                      'identity': list(identity), 'selectedMask': identity == native.PARAMETERS['mask']}
            if record['selectedMask']:
                selected += 1
                require(selected == 1, 'duplicate original mask')
                metadata = native.read_metadata(handle, eccodes)
                native.admit_metadata(metadata, 'NCALED', 'mask')
                record['metadata'] = metadata
                record['packing'] = {'packingType': eccodes.codes_get_string(handle, 'packingType'),
                                     'bitsPerValue': eccodes.codes_get_long(handle, 'bitsPerValue'),
                                     'bitmapPresent': metadata['bitmapPresent']}
            inventory.append(record)
            encoded(inventory)
        finally:
            eccodes.codes_release(handle)
    require(selected == 1, 'original mask missing')
    fields, metadata = native.decode_packet(raw, 'NCALED', mask_only=True)
    values = fields['mask']
    packing = next(row['packing'] for row in inventory if row['selectedMask'])
    summary = field_summary(values, metadata['mask'], packing, np)
    summary.update(exactZeroSeaCells=int(np.count_nonzero(values == 0)),
                   exactOneLandCells=int(np.count_nonzero(values == 1)),
                   finiteFractionalNotSeaCells=int(np.count_nonzero(np.isfinite(values) & (values > 0) & (values < 1))))
    require(summary['exactZeroSeaCells'] > 0, 'no qualified original sea cells')
    require(stable_stat(args.input) == before, 'constant original changed during native decode')
    catalogue.original_run(RUN, 'NCALED', datetime.now(timezone.utc))
    result = {'schema': 1, 'scientificSource': SOURCE, 'inputBytes': len(raw), 'inputSha256': digest,
              'conditionalETag': ETAG, 'constantResourceVersion': '2025-02-17T09:07:14Z',
              'reviewedHeadLastModified': 'Thu, 02 Jul 2026 15:21:39 GMT',
              'capturedStaticLastModified': transport['headers'].get('last-modified'),
              'originalForecastRunUtc': RUN, 'originalForecastExpiresUtc': '2026-10-17T18:00:00Z',
              'inspectedAt': datetime.now(timezone.utc).isoformat(), 'kernelBeforeNative': kernel,
              'rootReadonlyStagedFiles': readonly, 'originalMessages': inventory, 'mask': summary,
              'actualEcCodesAPI': eccodes.codes_get_api_version(), 'actualNumpy': np.__version__,
              'processMaxRSSKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              'ownMemoryPeakBytes': int((cgroup / 'memory.peak').read_text()),
              'ownMemoryEvents': (cgroup / 'memory.events').read_text(),
              'originalLandSeaMaskAdmitted': True, 'full49HourCohortAdmitted': False,
              'fractionalOrMissingNeverSea': True, 'noCroppingOrInterpolation': True,
              'nativeProcessProviderRequests': 0, 'published': False, 'freshnessRenewed': False}
    with args.output.open('xb') as stream:
        stream.write(encoded(result))
    print(json.dumps({'outcome': 'exact-constant-original-native-passed', 'inputSha256': digest,
                      'full49HourCohortAdmitted': False, 'published': False}))


if __name__ == '__main__': main()
