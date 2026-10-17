"""Retained49 survey. Every unchanged decoder refusal is recorded; the first is re-raised.

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
from retained_range_diagnostic import range_summary, refusal_frame


def uncertainty_summary(values, low, high, packing_error):
    require(type(packing_error) in (int, float) and math.isfinite(packing_error) and packing_error >= 0,
            'finite actual ecCodes scalar packing error required')
    compatible = beyond = 0
    for item in values:
        value = float(item)
        if math.isnan(value) or low <= value <= high: continue
        if not math.isfinite(value): beyond += 1; continue
        boundary = low if value < low else high
        # ECMWF documents an open lower / closed upper precision interval.
        if value - packing_error < boundary <= value + packing_error: compatible += 1
        else: beyond += 1
    return {'outOfRangeCompatibleWithPhysicalBoundary': compatible,
            'outOfRangeBeyondPackingInterval': beyond, 'actualEcCodesPackingError': packing_error,
            'originalPrePackingValueNotKnown': True, 'normalizationOrAcceptancePerformed': False}


def packet_packing(raw, native, codes, offset, run):
    rows = {}
    for message in native.exact_messages(raw):
        handle = codes.codes_new_from_message(message)
        try:
            identity = tuple(codes.codes_get_long(handle, key) for key in
                ('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'))
            selected = [field for field in native.FIELDS if native.PARAMETERS[field] == identity]
            if not selected: continue
            field = selected[0]
            require(field not in rows, 'duplicate selected scalar field')
            native.admit_metadata(native.read_metadata(handle, codes), 'NCALED', field, run, offset)
            # All getters here are scalar; packingError is computed from R/E/D/bits.
            row = {key: codes.codes_get_long(handle, key) for key in
                   ('dataRepresentationTemplateNumber', 'binaryScaleFactor', 'decimalScaleFactor', 'bitsPerValue')}
            row.update({key: codes.codes_get_double(handle, key) for key in ('referenceValue', 'packingError')})
            row['packingType'] = codes.codes_get_string(handle, 'packingType')
            require(all(math.isfinite(row[key]) for key in ('referenceValue', 'packingError'))
                    and row['packingError'] >= 0, 'bounded scalar packing precision')
            rows[field] = row
        finally: codes.codes_release(handle)
    require(set(rows) == set(native.FIELDS), 'all five scalar-admitted original fields required')
    return rows

def compact_evidence(value):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    require(len(raw) <= 256 * 1024, 'native evidence text bound unchanged')
    return raw


def admitted_summaries(fields, np):
    result = {}
    for field, values in fields.items():
        finite = np.isfinite(values)
        count = int(np.count_nonzero(finite))
        result[field] = {'finiteCells': count, 'unknownCells': int(values.size - count),
            'minimum': float(np.min(values[finite])) if count else None,
            'maximum': float(np.max(values[finite])) if count else None}
    return result


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
    with args.output.with_name('kernel-before-range-survey.json').open('xb') as stream:
        stream.write(encoded({'nativeImported': False, **kernel}))
    manifest = json.loads(args.manifest.read_bytes())
    require(manifest == {'source': SOURCE, 'files': {**EXPECTED_FILES, 'static_tiles.py': STATIC_SHA}},
            'exact unchanged four-file science identity')
    readonly = verify_source(args.source, {'source': SOURCE, 'files': EXPECTED_FILES})
    static_path = args.source / 'tools/arome142/static_tiles.py'
    require(hashlib.sha256(static_path.read_bytes()).hexdigest() == STATIC_SHA, 'static code changed')
    readonly.append(readonly_file(static_path))
    parent_path = Path(__file__).resolve().with_name('retained_range_diagnostic.py')
    require(hashlib.sha256(parent_path.read_bytes()).hexdigest() == '855078c22faa17c14b8a1e983bceb0eff7732d7048d6fb020b33a7e3a9bb67eb', 'frozen prior diagnostic helper')
    readonly.append(readonly_file(parent_path))
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
    import eccodes
    import numpy as np
    outcomes = []; all_packing = []; first_error = None; sample_remaining = 16
    for offset, row in enumerate(receipt['packets']):
        catalogue.original_run(RUN, 'NCALED', now())
        raw = (args.originals / f'hour-{offset:03}.grib2').read_bytes()
        packing = packet_packing(raw, native, eccodes, offset, RUN)
        all_packing.append({'offsetHours': offset, 'fields': packing})
        try:
            values, _ = native.decode_packet(raw, 'NCALED', RUN, offset)
            outcomes.append({'offsetHours': offset, 'outcome': 'unchanged-native-fields-passed',
                'fields': admitted_summaries(values, np)})
            del values
        except catalogue.AdmissionError as error:
            local, line = refusal_frame(error, args.source / 'tools/arome142/native.py')
            require(local['domain'] == 'NCALED' and local['offset'] == offset
                    and local['field'] in native.FIELDS and (local['low'], local['high']) == native.RANGES[local['field']],
                    'unchanged original field/range context')
            native.admit_metadata(local['metadata'], 'NCALED', local['field'], RUN, offset)
            facts = range_summary(local['values'], local['low'], local['high'])
            samples = facts['samples'][:sample_remaining]
            facts['samples'] = samples; facts['maximumSamples'] = sample_remaining
            facts['samplesLimitedByWholeSurveyBudget'] = True
            sample_remaining -= len(samples)
            precision = uncertainty_summary(local['values'], local['low'], local['high'], packing[local['field']]['packingError'])
            prior = sorted(local['result'])
            outcomes.append({'offsetHours': offset, 'outcome': 'unchanged-native-refusal',
                'originalSha256': row['sha256'], 'field': local['field'], 'originalErrorType': type(error).__name__,
                'originalError': str(error), 'unchangedNativeSourceLine': line, 'scalarAdmittedMetadata': local['metadata'],
                'priorSelectedFieldsPassedBeforeRefusal': prior,
                'admittedPriorFieldExtrema': admitted_summaries(local['result'], np),
                'uninspectedSelectedFieldsAfterRefusal': sorted(set(native.FIELDS) - set(prior) - {local['field']}),
                'rangeEvidence': facts, 'packingEvidence': precision})
            if first_error is None: first_error = error
            del local
    require(first_error is not None and len(outcomes) == len(all_packing) == 49, 'expected full retained survey/refusals')
    for name, original in before.items(): require(stable_stat(Path(name)) == original, 'original mutated')
    catalogue.original_run(RUN, 'NCALED', now())
    result = {'schema': 1, 'diagnosticOnly': True, 'scientificSource': SOURCE,
        'originalRunUtc': RUN, 'originalExpiresAt': EXPIRES, 'inspectedAt': now().isoformat(),
        'originalCaptureDeadlineMonotonicUnchanged': capture['deadlineMonotonic'],
        'originalQualificationClockRenewed': False, 'newQualificationAttempt': False,
        'all50OriginalDigestsValidatedBeforeArrays': True, 'originalBytes': 137421911,
        'surveyedPackets': 49, 'scalarSelectedHeaders': 245, 'outcomes': outcomes, 'originalPacking': all_packing,
        'maximumTotalSamples': 16, 'actualTotalSamples': 16 - sample_remaining,
        'firstOriginalAdmissionErrorPreserved': True, 'kernelBeforeNative': kernel, 'rootReadonlyStagedFiles': readonly,
        'ownMemoryPeakBytes': int((cgroup / 'memory.peak').read_text()),
        'ownMemoryEvents': (cgroup / 'memory.events').read_text(),
        'processMaxRSSKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        'providerRequests': 0, 'full49HourCohortAdmitted': False, 'published': False, 'installed': False}
    with args.output.open('xb') as stream: stream.write(compact_evidence(result))
    raise first_error  # No refusal is converted into scientific acceptance.


if __name__ == '__main__': main()
