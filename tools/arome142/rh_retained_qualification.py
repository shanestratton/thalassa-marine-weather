"""New retained-only RH display-view qualification; no acquisition/publication.

The failed capture clock stays historical. This explicitly separate phase is
bounded by its own absolute1200s deadline AND the original18UTC model expiry.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys
import time

from corrected_original_native import KERNEL_HELPER_SHA, exact_module, readonly_file, require, stable_stat

RAW_SOURCE = 'cf21a611c6b22db62449bc1658e7ae8b931476be'
SCIENCE = 'bbd57495546fa93bba7316f414b7d8975cf4dbec'
SCIENCE_FILES = {
    'native.py': 'bbb2668aa1e2c6d8d3694f37ae2dff1644fd980ed8d6cdd9c3b7f7c14aef2458',
    'static_tiles.py': '076c62f9d8a1af01f4d07a9972255c8519d23cfbe2e5cb3ba501142c55be33ce',
    'catalogue.py': 'd6f0aad3ab1a5dce00a6be38e51071753c49c9f9564966ed527c74a62839743d',
    'native-requirements.lock': 'cfd6e6ae3863ee58bd40f780df1fbf86443790989f050e2063163f2f96df2f64',
}
RECEIPT_SHA = 'c77ca87407da4834c6174c9b52030fd3631aef3f443bb53ea02f97cd473eb73f'
CAPTURE_SHA = '28390b228771164490cedb81e147c72a20bebe8d734cd4d912a2f6e03e154a90'
SURVEY_SHA = '11214b61b2b22f5c6e530146dc48843d9149f54964b860b6ed5327e9dbc9c0a7'
RUN = '2026-10-17T00:00:00Z'
EXPIRES = '2026-10-17T18:00:00Z'
PHASE = 'retained-only-upper-rh-display-v1'
POLICY = 'upper-rh-display-unavailable-v1'
PHASE_SECONDS = 1200


def compact(value, cap=256 * 1024):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    require(len(raw) <= cap, 'bounded qualification metadata')
    return raw


def utc(): return datetime.now(timezone.utc)


def make_phase(now, monotonic):
    require(now.tzinfo == timezone.utc and type(monotonic) in (int, float)
            and math.isfinite(monotonic) and monotonic >= 0, 'phase clock')
    seconds = min(float(PHASE_SECONDS), (datetime.fromisoformat(EXPIRES.replace('Z', '+00:00')) - now).total_seconds())
    require(seconds > 0, 'original18UTC forecast expired')
    return {'schema': 1, 'phase': PHASE, 'scientificSource': SCIENCE, 'rawScientificSource': RAW_SOURCE,
            'startedAt': now.isoformat(), 'startedMonotonic': monotonic,
            'deadlineMonotonic': monotonic + seconds, 'maximumSeconds': seconds,
            'originalRunUtc': RUN, 'originalExpiresAt': EXPIRES,
            'originalCaptureQualificationSucceeded': False, 'originalForecastExpiryRenewed': False}


def check_phase(phase, now, monotonic):
    require(type(phase) is dict and set(phase) == set(make_phase(now, monotonic)), 'exact separate-phase schema')
    require(phase['schema'] == 1 and phase['phase'] == PHASE and phase['scientificSource'] == SCIENCE
            and phase['rawScientificSource'] == RAW_SOURCE and phase['originalRunUtc'] == RUN
            and phase['originalExpiresAt'] == EXPIRES and phase['originalCaptureQualificationSucceeded'] is False
            and phase['originalForecastExpiryRenewed'] is False, 'phase/source/original clock changed')
    start, deadline, seconds = (phase[k] for k in ('startedMonotonic', 'deadlineMonotonic', 'maximumSeconds'))
    require(all(type(x) in (int, float) and math.isfinite(x) for x in (start, deadline, seconds, monotonic))
            and 0 <= start <= monotonic < deadline and 0 < seconds <= PHASE_SECONDS
            and abs(deadline - start - seconds) < 1e-7, 'absolute retained-only phase deadline')
    started = datetime.fromisoformat(phase['startedAt'])
    expiry = datetime.fromisoformat(EXPIRES.replace('Z', '+00:00'))
    require(started.tzinfo == timezone.utc and started <= now < expiry
            and seconds == min(float(PHASE_SECONDS), (expiry - started).total_seconds()),
            'phase UTC rollback/expiry/deadline changed')
    return deadline - monotonic


def bounded_json(path, cap, expected_sha=None):
    readonly_file(path)
    require(0 < path.stat().st_size <= cap, 'readonly metadata byte bound')
    raw = path.read_bytes()
    require(expected_sha is None or hashlib.sha256(raw).hexdigest() == expected_sha, 'exact retained metadata digest')
    return json.loads(raw)


def verify_manifest(manifest, source):
    require(manifest == {'source': SCIENCE, 'rawScientificSource': RAW_SOURCE, 'files': SCIENCE_FILES},
            'exact reviewed new scientific identity')
    rows = []
    for name, sha in SCIENCE_FILES.items():
        path = source / 'tools/arome142' / name
        rows.append(readonly_file(path))
        require(0 < path.stat().st_size <= 128 * 1024 and hashlib.sha256(path.read_bytes()).hexdigest() == sha,
                'new scientific source hash changed')
    return rows


def admit_capture(capture):
    require(capture.get('source') == RAW_SOURCE and capture.get('outcome') == 'all48-captured-native-unadmitted'
            and capture.get('completedNewOriginals') == 48 and capture.get('newCapturedBytes') == 136003911
            and capture.get('originalRunUtc') == RUN and capture.get('originalExpiresAt') == EXPIRES
            and capture.get('h000Refetched') is False and capture.get('maskRefetched') is False
            and capture.get('full49HourCohortAdmitted') is False and capture.get('published') is False,
            'failed original capture cannot be relabelled')


def reconcile_packet(offset, fields, qa, survey, np):
    prior = survey['outcomes'][offset]
    require(prior['offsetHours'] == offset and qa['policy'] == POLICY and qa['sourceCells'] == 255811,
            'original packet/QA identity')
    known = prior.get('fields', prior.get('admittedPriorFieldExtrema'))
    for name in ('u10', 'v10', 'msl', 't2m'):
        values = fields[name]; finite = np.isfinite(values); count = int(np.count_nonzero(finite))
        got = {'finiteCells': count, 'unknownCells': int(values.size - count),
               'minimum': float(np.min(values[finite])) if count else None,
               'maximum': float(np.max(values[finite])) if count else None}
        require(got == known[name], 'independent other-field survey agreement')
    if prior['outcome'] == 'unchanged-native-refusal':
        require(prior['field'] == 'rh2m' and prior['originalError'] == 'original field physical range',
                'original survey refusal changed')
        row = prior['rangeEvidence']
        expected = (row['aboveMaximumCells'], row['missingNaNCells'], row['finiteMinimum'], row['finiteMaximum'])
    else:
        row = prior['fields']['rh2m']
        expected = (0, row['unknownCells'], row['minimum'], row['maximum'])
    require((qa['upperDisplayUnavailableCells'], qa['sourceMissingCells'],
             qa['sourceFiniteMinimum'], qa['sourceFiniteMaximum']) == expected,
            'new RH QA does not match retained raw survey')


def raw_rh_readback(raw, native, codes, np, offset, sea):
    """Independent scalar-admitted original RH; no old decoder/range relaxation."""
    for message in native.exact_messages(raw):
        handle = codes.codes_new_from_message(message)
        try:
            identity = tuple(codes.codes_get_long(handle, k) for k in
                ('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'))
            if identity != native.PARAMETERS['rh2m']: continue
            metadata = native.read_metadata(handle, codes)
            reverse_i, reverse_j = native.admit_metadata(metadata, 'NCALED', 'rh2m', RUN, offset)
            precision = codes.codes_get_double(handle, 'packingError')
            require(math.isfinite(precision) and precision >= 0, 'actual RH packing precision')
            values = np.asarray(codes.codes_get_values(handle), dtype='<f8')
            require(values.ndim == 1 and values.size == 255811, 'RH readback cardinality')
            if metadata['bitmapPresent'] == 1:
                bitmap = np.asarray(codes.codes_get_array(handle, 'bitmap'))
                require(bitmap.shape == values.shape and np.all((bitmap == 0) | (bitmap == 1)), 'RH readback bitmap')
                values[bitmap == 0] = np.nan
            require(np.all(np.isfinite(values[~np.isnan(values)]))
                    and np.all(values[~np.isnan(values)] >= 0), 'original RH negative/nonfinite-present refusal')
            values = values.reshape(491, 521)
            if reverse_j: values = values[::-1, :]
            if reverse_i: values = values[:, ::-1]
            upper = values > 100; missing = np.isnan(values)
            compatible = upper & (values - precision < 100) & (100 <= values + precision)
            return values, {'upperCells': int(np.count_nonzero(upper)),
                'upperSeaCells': int(np.count_nonzero(upper & sea)),
                'originalMissingSeaCells': int(np.count_nonzero(missing & sea)),
                'packingBoundaryCompatibleCells': int(np.count_nonzero(compatible)),
                'beyondPackingIntervalCells': int(np.count_nonzero(upper & ~compatible))}
        finally: codes.codes_release(handle)
    raise ValueError('original RH readback missing')


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--create-phase':
        with Path(sys.argv[2]).open('xb') as stream: stream.write(compact(make_phase(utc(), time.monotonic())))
        return
    import resource
    import signal
    parser = argparse.ArgumentParser()
    for name in ('source', 'originals', 'receipt', 'capture', 'catalogue', 'manifest', 'h000-proof',
                 'mask-proof', 'survey', 'phase', 'out', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    helper = Path(__file__).resolve().with_name('original_pilot_native.py')
    require(hashlib.sha256(helper.read_bytes()).hexdigest() == KERNEL_HELPER_SHA, 'unchanged native kernel gate')
    from original_pilot_native import kernel_before_native
    cgroup, kernel = kernel_before_native()
    require(not {'catalogue', 'native', 'static_tiles', 'eccodes', 'numpy'}.intersection(sys.modules),
            'scientific/native module imported before kernel admission')
    with args.output.with_name('kernel-before-rh-qualification.json').open('xb') as stream:
        stream.write(compact({'nativeImported': False, **kernel}))
    phase = bounded_json(args.phase, 4096)
    def current(): return check_phase(phase, utc(), time.monotonic())
    def expired(*_): raise TimeoutError('new absolute retained-only1200s phase expired')
    current(); signal.signal(signal.SIGALRM, expired); signal.setitimer(signal.ITIMER_REAL, current())
    readonly = verify_manifest(bounded_json(args.manifest, 32768), args.source)
    readonly.extend(readonly_file(p) for p in (Path(__file__).resolve(), helper, Path(sys.executable).resolve()))
    receipt = bounded_json(args.receipt, 65536, RECEIPT_SHA)
    capture = bounded_json(args.capture, 131072, CAPTURE_SHA); admit_capture(capture)
    survey = bounded_json(args.survey, 256 * 1024, SURVEY_SHA)
    require(survey['scientificSource'] == RAW_SOURCE and survey['surveyedPackets'] == 49
            and survey['originalRunUtc'] == RUN and survey['originalExpiresAt'] == EXPIRES
            and survey['full49HourCohortAdmitted'] is False and survey['diagnosticOnly'] is True,
            'actual raw survey identity')
    sys.path.insert(0, str(args.source / 'tools/arome142'))
    import catalogue
    import native
    import static_tiles
    for module, name in ((catalogue, 'catalogue.py'), (native, 'native.py'), (static_tiles, 'static_tiles.py')):
        exact_module(module, args.source / 'tools/arome142' / name)
    from complete49 import (H000_SHA, MASK_SHA, MASK_BYTES, MASK_RESOURCE, admit_priors, plan_from)
    for path, cap in ((args.h000_proof, 31834), (args.mask_proof, 6798), (args.catalogue, 4 * 1024**2)):
        bounded_json(path, cap); readonly.append(readonly_file(path))
    admit_priors(args.h000_proof.read_bytes(), args.mask_proof.read_bytes(), utc())
    plan = plan_from(args.catalogue.read_bytes(), utc())
    require(set(receipt) == {'schema', 'packets', 'mask'} and receipt['schema'] == 1
            and len(receipt['packets']) == 49, 'exact retained source schema')
    expected_names = {f'hour-{i:03}.grib2' for i in range(49)} | {'mask.grib2'}
    require(not args.originals.is_symlink() and {p.name for p in args.originals.iterdir()} == expected_names,
            'exact50 original names')
    sources = []; before = {}
    for offset, row in enumerate(receipt['packets']):
        current(); path = args.originals / f'hour-{offset:03}.grib2'
        readonly.append(readonly_file(path)); before[str(path)] = stable_stat(path)
        require(set(row) == {'path', 'offsetHours', 'url', 'bytes', 'sha256'} and row['offsetHours'] == offset
                and row['url'] == plan['packets'][offset]['url'] and row['bytes'] == plan['packets'][offset]['bytes']
                and path.stat().st_size == row['bytes']
                and hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256'], 'retained original declaration/hash')
        sources.append({**row, 'path': str(path.resolve())})
    mask_path = args.originals / 'mask.grib2'; readonly.append(readonly_file(mask_path))
    before[str(mask_path)] = stable_stat(mask_path)
    require(sources[0]['sha256'] == H000_SHA and receipt['mask']['resource'] == MASK_RESOURCE
            and receipt['mask']['bytes'] == mask_path.stat().st_size == MASK_BYTES
            and receipt['mask']['sha256'] == hashlib.sha256(mask_path.read_bytes()).hexdigest() == MASK_SHA
            and sum(s['bytes'] for s in sources) + MASK_BYTES == 137421911, 'exact50 raw identities')
    mask_source = {**receipt['mask'], 'path': str(mask_path.resolve())}
    # All50 digests are now checked. Only now may any original array be decoded.
    import eccodes
    import numpy as np
    from retained_range_survey import packet_packing
    original_decode = native.decode_packet
    sea = None; audits = []; selected_tile = None
    def audited_decode(raw, domain, run_utc=None, offset=None, mask_only=False):
        nonlocal sea, selected_tile
        current()
        if not mask_only: packet_packing(raw, native, eccodes, offset, RUN)
        fields, facts = original_decode(raw, domain, run_utc, offset, mask_only)
        if mask_only:
            sea = fields['mask'] == 0
            require(int(np.count_nonzero(sea)) == 251592, 'genuine mask sea cohort changed')
            return fields, facts
        require(sea is not None and offset == len(audits), 'ordered independent packet audits')
        qa = facts['rh2m']['displayQualification']; reconcile_packet(offset, fields, qa, survey, np)
        original, counts = raw_rh_readback(raw, native, eccodes, np, offset, sea)
        expected_unknown = np.isnan(original) | (original > 100)
        require(np.array_equal(np.isnan(fields['rh2m']), expected_unknown)
                and np.array_equal(fields['rh2m'][~expected_unknown], original[~expected_unknown]),
                'RH view must preserve valid original values and exact unknown positions')
        require(counts['upperCells'] == qa['upperDisplayUnavailableCells'], 'RH raw/view QA mismatch')
        if selected_tile is None:
            touched = np.flatnonzero((original > 100) & sea)
            if touched.size:
                j, i = divmod(int(touched[0]), 521); selected_tile = f'{i // 32}-{j // 32}'
        audits.append({'offsetHours': offset, 'originalSha256': sources[offset]['sha256'], 'qa': qa, **counts})
        current(); return fields, facts
    static_tiles.decode_packet = audited_decode
    try:
        result = static_tiles.build_static(plan, sources, mask_source, args.out)
    finally: static_tiles.decode_packet = original_decode
    current()
    require(len(audits) == 49 and sum(r['upperCells'] for r in audits) == 258
            and sum(r['packingBoundaryCompatibleCells'] for r in audits) == 217
            and sum(r['beyondPackingIntervalCells'] for r in audits) == 41,
            'actual258/217/41 raw QA agreement')
    native_proof_raw = (args.out / 'native-proof.json').read_bytes()
    native_proof = json.loads(native_proof_raw)
    static_raw = (args.out / 'manifest.json').read_bytes(); static = json.loads(static_raw)
    require(len(native_proof_raw) <= 1024**2 and len(static_raw) <= 262144 and result['tileCount'] == 272
            and native_proof['scientificFilesSha256'] == SCIENCE_FILES
            and native_proof['allOriginalGridLocationsPreserved'] is True
            and native_proof['originalSourceGribBytesModified'] is False
            and 'allOriginalCellsPreserved' not in native_proof
            and native_proof['optionalDisplayQualification']['displayAvailability'] == 'partial'
            and native_proof['optionalDisplayQualification']['upperDisplayUnavailableCells'] == 258,
            'truthful bound static source/view proof')
    require(len(native_proof['packets']) == len(static['packets']) == 49 and len(static['tiles']) == 272
            and static['nativeProofSha256'] == hashlib.sha256(native_proof_raw).hexdigest()
            and static['maskSha256'] == MASK_SHA and static['width'] == 521 and static['height'] == 491
            and static['bounds'] == [-26, -13.75, 158.5, 171.5], 'static identity/digest chain')
    for offset, source in enumerate(sources):
        require({k: native_proof['packets'][offset][k] for k in ('offsetHours', 'url', 'bytes', 'sha256')}
                == {k: source[k] for k in ('offsetHours', 'url', 'bytes', 'sha256')}
                and static['packets'][offset] == {k: source[k] for k in ('offsetHours', 'bytes', 'sha256')}
                and native_proof['packets'][offset]['fields']['rh2m']['displayQualification'] == audits[offset]['qa'],
                'original49 digest/order/QA proof chain')
    tile_rows = []; total = 0
    chosen = {'0-0', '16-15'} | ({selected_tile} if selected_tile else set())
    for tile in static['tiles']:
        current(); path = args.out / 'tiles' / (tile['sha256'] + '.bin.gz')
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == tile['bytes'] <= 3 * 1024**2,
                'bounded immutable tile')
        raw = path.read_bytes(); require(hashlib.sha256(raw).hexdigest() == tile['sha256'], 'tile readback hash')
        total += len(raw)
        if tile['id'] in chosen:
            target = args.output.parent / f"sample-{tile['id']}-{tile['sha256']}.bin.gz"
            static_tiles.write_fresh(target, raw)
            tile_rows.append({'path': target.name, **tile})
    require(total == result['tileBytes'] <= 1024**3 and len(tile_rows) == len(chosen) <= 3
            and sum(t['bytes'] for t in tile_rows) <= 9 * 1024**2
            and not (args.out / '.native').exists(), 'full static/storage/scratch readback')
    for name in ('native-proof.json', 'manifest.json', 'prepared-slot.json'):
        current(); raw = (args.out / name).read_bytes()
        require(len(raw) <= (1024**2 if name == 'native-proof.json' else 262144 if name == 'manifest.json' else 4096),
                'bounded copied proof')
        static_tiles.write_fresh(args.output.with_name(name), raw)
    for name, before_stat in before.items(): require(stable_stat(Path(name)) == before_stat, 'raw original mutated')
    current()
    proof = {'schema': 1, 'phase': phase, 'rawScientificSource': RAW_SOURCE, 'scientificSource': SCIENCE,
        'scientificFilesSha256': SCIENCE_FILES, 'originalCaptureQualificationSucceeded': False,
        'originalCaptureDeadlineMonotonicUnchanged': capture['deadlineMonotonic'],
        'newRetainedOnlyQualification': True, 'retainedTransportAndGridComplete': True,
        'independentlyCheckedOtherFields': 196, 'hours': 49, 'cellsPerField': 255811,
        'all50DigestsValidatedBeforeArrays': True, 'rawOriginalsUnchanged': True,
        'originalRunUtc': RUN, 'originalExpiresAt': EXPIRES, 'originalForecastExpiryRenewed': False,
        'relativeHumidityDisplayAvailability': 'partial', 'upperRhUnavailableCells': 258,
        'packingBoundaryCompatibleCells': 217, 'beyondPackingIntervalCells': 41,
        'upperRhUnavailableSeaSampleHours': sum(r['upperSeaCells'] for r in audits),
        'originalMissingSeaSampleHours': sum(r['originalMissingSeaCells'] for r in audits),
        'audits': audits, 'static': result, 'selectedTiles': tile_rows,
        'nativeProofSha256': hashlib.sha256(native_proof_raw).hexdigest(),
        'manifestSha256': hashlib.sha256(static_raw).hexdigest(),
        'kernelBeforeNative': kernel, 'rootReadonlyFiles': readonly,
        'actualEcCodesAPI': eccodes.codes_get_api_version(), 'actualNumpy': np.__version__,
        'ownMemoryPeakBytes': int((cgroup / 'memory.peak').read_text()),
        'ownMemoryEvents': (cgroup / 'memory.events').read_text(),
        'processMaxRSSKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        'elapsedNewPhaseSeconds': time.monotonic() - phase['startedMonotonic'],
        'providerRequests': 0, 'published': False, 'installed': False}
    current()
    static_tiles.write_fresh(args.output, compact(proof))
    current(); signal.setitimer(signal.ITIMER_REAL, 0)
    print(json.dumps({'outcome': 'retained49-qualified-view-rh-partial', 'upperRhUnknown': 258,
                      'published': False, 'originalExpiryRenewed': False}))


if __name__ == '__main__': main()
