"""Strict offline49-original static qualification within the capture deadline."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys

from corrected_original_native import (SOURCE, EXPECTED_FILES, KERNEL_HELPER_SHA,
    encoded, exact_module, readonly_file, require, stable_stat, verify_source)

STATIC_SHA = 'd6664f3e5a2d31277010593c17f18eb933710ad409ca33a50244c135a1d84b3c'


def admit_deadline(result, now, monotonic):
    from complete49 import ATTEMPT, EXPIRES, RUN, SOURCE, WHOLE_SECONDS, within
    require(result.get('source') == SOURCE and result.get('attempt') == ATTEMPT
            and result.get('outcome') == 'all48-captured-native-unadmitted'
            and result.get('completedNewOriginals') == 48 and result.get('maximumRequests') == 48
            and result.get('originalRunUtc') == RUN and result.get('originalExpiresAt') == EXPIRES
            and result.get('h000Refetched') is False and result.get('maskRefetched') is False
            and result.get('full49HourCohortAdmitted') is False and result.get('published') is False,
            'actual fixed48 capture unavailable')
    start, deadline = result.get('startedMonotonic'), result.get('deadlineMonotonic')
    require(type(start) in (int, float) and type(deadline) in (int, float)
            and math.isfinite(start) and math.isfinite(deadline) and deadline - start == WHOLE_SECONDS
            and monotonic() >= start, 'original whole-attempt clock changed')
    started = datetime.fromisoformat(result['startedAtUtc'])
    require(started.tzinfo is not None and started <= now, 'capture UTC clock moved backwards')
    within(deadline, now, monotonic)
    return deadline


def main():
    import resource
    import signal
    import time
    parser = argparse.ArgumentParser()
    for name in ('source', 'inputs', 'catalogue', 'receipt', 'capture', 'manifest', 'h000-proof', 'mask-proof', 'out', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    helper = Path(__file__).resolve().with_name('original_pilot_native.py')
    require(hashlib.sha256(helper.read_bytes()).hexdigest() == KERNEL_HELPER_SHA, 'unchanged original kernel helper')
    from original_pilot_native import kernel_before_native
    cgroup, kernel = kernel_before_native()
    require(not {'catalogue', 'native', 'static_tiles', 'eccodes', 'numpy'}.intersection(sys.modules), 'preloaded scientific module')
    with args.output.with_name('kernel-before-complete49-native.json').open('xb') as stream:
        stream.write(encoded({'nativeImported': False, **kernel}))
    require(args.manifest.is_file() and not args.manifest.is_symlink()
            and 0 < args.manifest.stat().st_size <= 32768, 'scientific manifest metadata bound')
    manifest = json.loads(args.manifest.read_bytes())
    require(manifest == {'source': SOURCE, 'files': {**EXPECTED_FILES, 'static_tiles.py': STATIC_SHA}}, 'exact static scientific source')
    readonly = verify_source(args.source, {'source': SOURCE, 'files': EXPECTED_FILES})
    static_path = args.source / 'tools/arome142/static_tiles.py'
    readonly.append(readonly_file(static_path))
    require(hashlib.sha256(static_path.read_bytes()).hexdigest() == STATIC_SHA, 'unchanged static transform hash')
    readonly.extend(readonly_file(path) for path in (Path(__file__).resolve(), helper,
        Path(__file__).resolve().with_name('corrected_original_native.py'), Path(__file__).resolve().with_name('complete49.py'),
        Path(__file__).resolve().with_name('constant_original.py'), Path(sys.executable).resolve(),
        args.catalogue, args.receipt, args.capture, args.manifest, args.h000_proof, args.mask_proof))
    for path, size in ((args.catalogue, 4 * 1024**2), (args.receipt, 65536), (args.capture, 131072),
                       (args.h000_proof, 31834), (args.mask_proof, 6798)):
        require(0 < path.stat().st_size <= size, 'bounded original source metadata')
    sys.path.insert(0, str(args.source / 'tools/arome142'))
    import catalogue
    import native
    import static_tiles
    for module, name in ((catalogue, 'catalogue.py'), (native, 'native.py'), (static_tiles, 'static_tiles.py')):
        exact_module(module, args.source / 'tools/arome142' / name)
    from complete49 import (H000_SHA, MASK_SHA, MASK_BYTES, H000_BYTES, MASK_RESOURCE,
        admit_priors, plan_from, within)
    now = lambda: datetime.now(timezone.utc)
    admit_priors(args.h000_proof.read_bytes(), args.mask_proof.read_bytes(), now())
    plan = plan_from(args.catalogue.read_bytes(), now())
    capture = json.loads(args.capture.read_bytes())
    deadline = admit_deadline(capture, now(), time.monotonic)
    receipt = json.loads(args.receipt.read_bytes())
    require(type(receipt) is dict and set(receipt) == {'schema', 'packets', 'mask'} and receipt['schema'] == 1,
            'fixed original receipt schema')
    require(type(receipt['packets']) is list and len(receipt['packets']) == 49, 'exact49 originals required')
    before = {}
    for offset, row in enumerate(receipt['packets']):
        expected = (args.inputs / f'hour-{offset:03}.grib2').resolve()
        require(type(row) is dict and set(row) == {'offsetHours', 'url', 'bytes', 'sha256', 'path'}
                and row['offsetHours'] == offset and row['url'] == plan['packets'][offset]['url']
                and row['bytes'] == plan['packets'][offset]['bytes'] and Path(row['path']).resolve() == expected
                and expected.is_relative_to(args.inputs.resolve()), 'original path/order/declaration changed')
        readonly.append(readonly_file(expected)); before[str(expected)] = stable_stat(expected)
        if offset == 0: require(row['sha256'] == H000_SHA and row['bytes'] == H000_BYTES, 'retained h000 receipt changed')
    mask_path = (args.inputs / 'mask.grib2').resolve()
    require(receipt['mask'] == {'resource': MASK_RESOURCE, 'bytes': MASK_BYTES, 'sha256': MASK_SHA,
                               'path': str(mask_path)}, 'retained mask receipt changed')
    readonly.append(readonly_file(mask_path)); before[str(mask_path)] = stable_stat(mask_path)
    require(capture['newCapturedBytes'] == sum(row['bytes'] for row in receipt['packets'][1:]) == 136003911,
            'exact new original byte aggregate')
    # The original1200s clock includes transport, copying and this native phase.
    def expired(*_): raise TimeoutError('absolute capture+native/static1200second deadline')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.monotonic()))
    result = static_tiles.build_static(plan, receipt['packets'], receipt['mask'], args.out)
    within(deadline, now())
    for name, facts in before.items(): require(stable_stat(Path(name)) == facts, 'original changed during full native transform')
    require(result['tileCount'] == 272 and result['published'] is False and result['installed'] is False,
            'fixed bounded static output changed')
    manifest_bytes = (args.out / 'manifest.json').read_bytes()
    require(len(manifest_bytes) <= 262144, 'static manifest bound')
    static = json.loads(manifest_bytes)
    require(static['width'] == 521 and static['height'] == 491 and static['bounds'] == [-26, -13.75, 158.5, 171.5]
            and len(static['packets']) == 49 and len(static['tiles']) == 272 and static['maskSha256'] == MASK_SHA,
            'exact full static source identity')
    actual_bytes = 0
    for tile in static['tiles']:
        within(deadline, now())
        path = args.out / 'tiles' / (tile['sha256'] + '.bin.gz')
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == tile['bytes'] <= 3 * 1024**2,
                'exact immutable tile size/path')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == tile['sha256'], 'actual static tile digest')
        actual_bytes += tile['bytes']
    require(actual_bytes == result['tileBytes'] <= 1024**3, 'actual output ceiling')
    require(not (args.out / '.native').exists(), 'owned native scratch cleanup incomplete')
    within(deadline, now())
    import eccodes
    import numpy as np
    proof = {'schema': 1, 'scientificSource': SOURCE, 'originalRunUtc': plan['runUtc'],
        'originalExpiresAt': '2026-10-17T18:00:00Z', 'qualifiedAt': now().isoformat(),
        'captureStartedAtUtc': capture['startedAtUtc'], 'startedMonotonic': capture['startedMonotonic'],
        'deadlineMonotonic': deadline, 'elapsedWholeAttemptSeconds': time.monotonic() - capture['startedMonotonic'],
        'originalPackets': 49, 'newProviderReads': 48, 'h000Refetched': False, 'maskRefetched': False,
        'inputForecastBytes': 137377011, 'inputMaskBytes': MASK_BYTES, 'maskSha256': MASK_SHA,
        'cellsPerFieldPerHour': 255811, 'fieldsPerHour': 5, 'hours': 49,
        'scratchBytesRequired': 503436048, 'rawTileSamplesBytesWithHalo': 705482736,
        'maximumScratchBytes': 1200 * 1024**2, 'maximumOutputBytes': 1024**3,
        'static': result, 'manifestBytes': len(manifest_bytes), 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'kernelBeforeNative': kernel, 'rootReadonlyStagedFiles': readonly,
        'actualEcCodesAPI': eccodes.codes_get_api_version(), 'actualNumpy': np.__version__,
        'processMaxRSSKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        'ownMemoryPeakBytes': int((cgroup / 'memory.peak').read_text()), 'ownMemoryEvents': (cgroup / 'memory.events').read_text(),
        'full49HourOriginalNativeAndStaticAdmitted': True, 'originalClockRenewed': False,
        'nativeProcessProviderRequests': 0, 'published': False, 'installed': False,
        'privatePartialOutputsNeverPublicationAuthority': True}
    within(deadline, now())
    with args.output.open('xb') as stream: stream.write(encoded(proof))
    within(deadline, now())
    signal.setitimer(signal.ITIMER_REAL, 0)
    print(json.dumps({'outcome': 'actual49-original-static-native-passed', 'tiles': 272,
                      'manifestSha256': proof['manifestSha256'], 'published': False}))


if __name__ == '__main__': main()
