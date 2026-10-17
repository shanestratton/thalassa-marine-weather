"""Retained-only diagnostic. The unchanged decoder's refusal is re-raised.

No scientific acceptance, clamping, array serialization or acquisition exists
here. A fresh diagnostic process never renews the earlier qualification clock.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys

from corrected_original_native import (EXPECTED_FILES, KERNEL_HELPER_SHA, SOURCE,
    encoded, exact_module, readonly_file, require, stable_stat, verify_source)

STATIC_SHA = 'd6664f3e5a2d31277010593c17f18eb933710ad409ca33a50244c135a1d84b3c'
MAX_SAMPLES = 16
MAX_CELLS = 255811


def range_summary(values, low, high):
    require(type(low) in (int, float) and type(high) in (int, float)
            and math.isfinite(low) and math.isfinite(high) and low <= high, 'unchanged finite range required')
    require(len(values) == MAX_CELLS, 'exact original scalar-admitted array cardinality')
    missing = nonfinite = below = above = finite = 0
    minimum = maximum = None
    samples = []
    for index, item in enumerate(values):
        value = float(item)
        if math.isnan(value):
            missing += 1
            continue
        if not math.isfinite(value):
            nonfinite += 1
            outside = 'nonfinite'
        else:
            finite += 1
            minimum = value if minimum is None else min(minimum, value)
            maximum = value if maximum is None else max(maximum, value)
            if value < low: below += 1; outside = 'below'
            elif value > high: above += 1; outside = 'above'
            else: continue
        if len(samples) < MAX_SAMPLES:
            samples.append({'originalScanIndex': index, 'value': value if math.isfinite(value) else None,
                            'kind': outside})
    return {'cells': len(values), 'finiteCells': finite, 'missingNaNCells': missing,
            'nonfinitePresentCells': nonfinite, 'belowMinimumCells': below, 'aboveMaximumCells': above,
            'finiteMinimum': minimum, 'finiteMaximum': maximum, 'unchangedPhysicalRange': [low, high],
            'maximumSamples': MAX_SAMPLES, 'samples': samples,
            'samplesAreOriginalScanOrderBeforeCanonicalTranspose': True,
            'valuesClampedOrChanged': False}


def refusal_frame(error, native_path):
    require(str(error) == 'original field physical range', 'diagnostic only handles the original physical refusal')
    trace = error.__traceback__
    matches = []
    while trace is not None:
        frame = trace.tb_frame
        if frame.f_code.co_name == 'decode_packet' and Path(frame.f_code.co_filename).resolve() == native_path.resolve():
            matches.append((frame, trace.tb_lineno))
        trace = trace.tb_next
    require(len(matches) == 1, 'exact unchanged decoder traceback frame required')
    frame, line = matches[0]
    local = frame.f_locals
    require(all(key in local for key in ('field', 'domain', 'offset', 'metadata', 'values', 'low', 'high', 'reverse_i', 'reverse_j')),
            'refusal must follow scalar metadata/array cardinality/bitmap admission')
    return local, line


def main():
    import resource
    parser = argparse.ArgumentParser()
    for name in ('source', 'originals', 'receipt', 'capture', 'catalogue', 'manifest', 'h000-proof', 'mask-proof', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    helper = Path(__file__).resolve().with_name('original_pilot_native.py')
    require(hashlib.sha256(helper.read_bytes()).hexdigest() == KERNEL_HELPER_SHA, 'unchanged original kernel helper')
    from original_pilot_native import kernel_before_native
    cgroup, kernel = kernel_before_native()
    require(not {'catalogue', 'native', 'static_tiles', 'numpy', 'eccodes'}.intersection(sys.modules),
            'native/scientific module loaded before kernel admission')
    with args.output.with_name('kernel-before-range-diagnostic.json').open('xb') as stream:
        stream.write(encoded({'nativeImported': False, **kernel}))
    manifest = json.loads(args.manifest.read_bytes())
    require(manifest == {'source': SOURCE, 'files': {**EXPECTED_FILES, 'static_tiles.py': STATIC_SHA}},
            'exact unchanged four-file science identity')
    readonly = verify_source(args.source, {'source': SOURCE, 'files': EXPECTED_FILES})
    static_path = args.source / 'tools/arome142/static_tiles.py'
    require(hashlib.sha256(static_path.read_bytes()).hexdigest() == STATIC_SHA, 'static code changed')
    readonly.append(readonly_file(static_path))
    readonly.extend(readonly_file(path) for path in (Path(__file__).resolve(), helper,
        Path(__file__).resolve().with_name('corrected_original_native.py'),
        Path(__file__).resolve().with_name('complete49.py'), Path(__file__).resolve().with_name('constant_original.py'),
        Path(sys.executable).resolve(), args.receipt, args.capture, args.catalogue, args.manifest,
        args.h000_proof, args.mask_proof))
    for path, cap in ((args.receipt, 65536), (args.capture, 131072), (args.catalogue, 4 * 1024**2),
                      (args.h000_proof, 31834), (args.mask_proof, 6798)):
        require(0 < path.stat().st_size <= cap, 'retained metadata byte bound')
    sys.path.insert(0, str(args.source / 'tools/arome142'))
    import catalogue
    import native
    exact_module(catalogue, args.source / 'tools/arome142/catalogue.py')
    exact_module(native, args.source / 'tools/arome142/native.py')
    from complete49 import (H000_SHA, MASK_BYTES, MASK_SHA, RUN, EXPIRES, plan_from, admit_priors)
    now = lambda: datetime.now(timezone.utc)
    admit_priors(args.h000_proof.read_bytes(), args.mask_proof.read_bytes(), now())
    plan = plan_from(args.catalogue.read_bytes(), now())
    capture = json.loads(args.capture.read_bytes())
    require(capture.get('source') == SOURCE and capture.get('outcome') == 'all48-captured-native-unadmitted'
            and capture.get('completedNewOriginals') == 48 and capture.get('newCapturedBytes') == 136003911
            and capture.get('originalRunUtc') == RUN and capture.get('originalExpiresAt') == EXPIRES
            and capture.get('h000Refetched') is False and capture.get('maskRefetched') is False
            and capture.get('full49HourCohortAdmitted') is False and capture.get('published') is False,
            'exact retained failed-attempt provenance')
    receipt = json.loads(args.receipt.read_bytes())
    require(set(receipt) == {'schema', 'packets', 'mask'} and receipt['schema'] == 1
            and type(receipt['packets']) is list and len(receipt['packets']) == 49, 'exact retained49 receipt')
    expected_names = {f'hour-{offset:03}.grib2' for offset in range(49)} | {'mask.grib2'}
    require({path.name for path in args.originals.iterdir()} == expected_names, 'only exact50 original files')
    before = {}
    for offset, row in enumerate(receipt['packets']):
        path = args.originals / f'hour-{offset:03}.grib2'
        readonly.append(readonly_file(path)); before[str(path)] = stable_stat(path)
        require(row['offsetHours'] == offset and row['bytes'] == plan['packets'][offset]['bytes']
                and row['url'] == plan['packets'][offset]['url'] and path.stat().st_size == row['bytes']
                and hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256'], 'retained original declaration/hash')
        if offset == 0: require(row['sha256'] == H000_SHA, 'retained h000 changed')
    mask = args.originals / 'mask.grib2'
    readonly.append(readonly_file(mask)); before[str(mask)] = stable_stat(mask)
    require(mask.stat().st_size == MASK_BYTES and hashlib.sha256(mask.read_bytes()).hexdigest() == MASK_SHA
            and receipt['mask']['bytes'] == MASK_BYTES and receipt['mask']['sha256'] == MASK_SHA,
            'retained mask changed')
    require(sum(row['bytes'] for row in receipt['packets']) + MASK_BYTES == 137421911,
            'exact50 original aggregate')
    # Genuine unchanged metadata/cardinality/bitmap/physical gates run in normal order.
    values, _ = native.decode_packet(mask.read_bytes(), 'NCALED', mask_only=True)
    del values
    passed = []
    for offset, row in enumerate(receipt['packets']):
        catalogue.original_run(RUN, 'NCALED', now())
        raw = (args.originals / f'hour-{offset:03}.grib2').read_bytes()
        try:
            values, _ = native.decode_packet(raw, 'NCALED', RUN, offset)
            del values
            passed.append(offset)
        except catalogue.AdmissionError as error:
            local, line = refusal_frame(error, args.source / 'tools/arome142/native.py')
            require(local['domain'] == 'NCALED' and local['offset'] == offset
                    and local['field'] in native.FIELDS and (local['low'], local['high']) == native.RANGES[local['field']],
                    'unchanged original field/range context')
            native.admit_metadata(local['metadata'], 'NCALED', local['field'], RUN, offset)
            facts = range_summary(local['values'], local['low'], local['high'])
            for name, original in before.items(): require(stable_stat(Path(name)) == original, 'original mutated')
            catalogue.original_run(RUN, 'NCALED', now())
            result = {'schema': 1, 'diagnosticOnly': True, 'scientificSource': SOURCE,
                'originalRunUtc': RUN, 'originalExpiresAt': EXPIRES, 'inspectedAt': now().isoformat(),
                'originalCaptureDeadlineMonotonicUnchanged': capture['deadlineMonotonic'],
                'originalQualificationClockRenewed': False, 'newQualificationAttempt': False,
                'all50OriginalDigestsValidatedBeforeArrays': True, 'originalBytes': 137421911,
                'completedLeadPacketsBeforeRefusal': passed, 'refusedLeadHours': offset,
                'refusedOriginalSha256': row['sha256'], 'field': local['field'],
                'originalErrorType': type(error).__name__, 'originalError': str(error),
                'unchangedNativeSourceLine': line, 'scalarAdmittedMetadata': local['metadata'],
                'rangeEvidence': facts, 'kernelBeforeNative': kernel, 'rootReadonlyStagedFiles': readonly,
                'ownMemoryPeakBytes': int((cgroup / 'memory.peak').read_text()),
                'ownMemoryEvents': (cgroup / 'memory.events').read_text(),
                'processMaxRSSKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                'providerRequests': 0, 'full49HourCohortAdmitted': False, 'published': False, 'installed': False}
            with args.output.open('xb') as stream: stream.write(encoded(result))
            raise  # Preserve the original AdmissionError and nonzero native exit.
    raise RuntimeError('Expected original physical refusal was not reproduced; no admission is issued')


if __name__ == '__main__': main()
