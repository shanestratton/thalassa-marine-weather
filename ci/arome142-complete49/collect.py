"""Exact originals plus bounded text/three tiles; no runtime or scratch archive."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

temp = Path(os.environ['RUNNER_TEMP'])
root = temp / 'arome142-complete49-evidence'
stage = temp / 'arome142-complete49-readonly'
target = temp / 'arome142-complete49-artifact'
target.mkdir(mode=0o700)
run_id = os.environ['GITHUB_RUN_ID']; assert re.fullmatch('[0-9]+', run_id)
rows = []
counts = {'originals': 0, 'text': 0, 'tiles': 0}
caps = {'originals': 137421912, 'text': 4 * 1024**2 - 65536, 'tiles': 9 * 1024**2}
whole_cap = 160 * 1024**2
DECLARED = [1373100,2606363,2610194,2601964,2617852,2639441,2708040,2717879,2751247,2784070,2787945,2816413,2841076,2873827,2902197,2931166,2956299,2944637,2953340,2926834,3011120,2961665,2911107,2824719,2775675,2764171,2786846,2781441,2777263,2749269,2751599,2761224,2839364,2823156,2805254,2815086,2867470,2892967,2912660,2962358,2968738,2972670,2968762,2956411,2907010,2918811,2895718,2842591,2828002]


def save(name, raw, kind='text', original_bytes=None):
    if kind == 'text': raw.decode('utf-8')
    counts[kind] += len(raw)
    assert counts[kind] <= caps[kind] and sum(counts.values()) <= whole_cap - 65536
    path = target / name; path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream: stream.write(raw)
    rows.append({'path': name, 'kind': kind, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                 'sourceBytes': original_bytes if original_bytes is not None else len(raw)})


# Exact prior originals live outside the mutable proof namespace.
for source, name, size, digest in (
    (stage / 'retained/h000.grib2', 'originals/hour-000.grib2', 1373100, '4e2e34400535158f696f1684c74bebb6d08126e37f9f713f29f94a30498bd733'),
    (stage / 'retained/mask.grib2', 'originals/mask.grib2', 44900, 'b7d5864f26d11f9c82997d8ca8cd16a499c95fd8d9d0adcaf24f1c33b85a4ae2'),
):
    if source.exists():
        assert source.is_file() and not source.is_symlink() and source.stat().st_size == size
        raw = source.read_bytes(); assert hashlib.sha256(raw).hexdigest() == digest
        save(name, raw, 'originals')

top = {'h000-artifact-download.txt', 'mask-artifact-download.txt', 'source.txt', 'controller-source.txt', 'control.txt',
    'python.txt', 'node.txt', 'verified-retained.json', 'reviewed-fixed48-ticket.json', 'native-source-manifest.json',
    'posix-link-fixtures10.txt', 'complete26.txt', 'constant48.txt', 'controller15.txt', 'source18.txt',
    'install.txt', 'pip-check.txt', 'packages.txt', 'read-only-runtime-manifest.json', 'read-only-runtime-after.json',
    'compiled-fixtures4.txt', 'generated-fixture-proof.json', 'resource-before-provider-get.json',
    'kernel-preflight.txt', 'fixed48-parent.txt', 'capture-process-exit.txt', 'root-readonly-original-copy.json',
    'read-only-original-manifest.json', 'read-only-original-after.json', 'native-runtime-remaining-seconds.txt',
    'full49-native.txt', 'native-process-exit.txt'}
top.update(f'cleanup-arome142-complete49-{phase}-{run_id}.service.txt' for phase in ('fixture', 'kernel', 'capture', 'native'))
native = {'kernel-before-generated-fixtures.json', 'kernel-before-fixed48-get.json',
          'kernel-before-complete49-native.json', 'full49-qualification.json'}
if root.is_dir() and not root.is_symlink():
    for current, directories, files in os.walk(root, followlinks=False):
        current = Path(current)
        for directory in directories: assert not (current / directory).is_symlink()
        if current == root: directories[:] = [name for name in directories if name not in ('static', 'state')]
        for name in sorted(files):
            file = current / name; assert file.is_file() and not file.is_symlink()
            relative = file.relative_to(root).as_posix()
            if re.fullmatch('attempt/hour-0(?:0[1-9]|[1-3][0-9]|4[0-8])/original.grib2', relative):
                offset = int(file.parent.name.split('-')[1])
                assert 0 <= file.stat().st_size <= DECLARED[offset] + 1 <= 16 * 1024**2
                raw = file.read_bytes()
                transport = file.with_name('transport.json')
                if transport.is_file():
                    assert not transport.is_symlink() and transport.stat().st_size <= 131072
                    facts = json.loads(transport.read_bytes())
                    if facts.get('outcome') == 'complete-exact-original':
                        assert len(raw) == facts['bodyBytes'] == DECLARED[offset] and facts['offsetHours'] == offset
                sources = root / 'attempt/sources.json'
                if sources.is_file():
                    assert not sources.is_symlink() and sources.stat().st_size <= 65536
                    producer = json.loads(sources.read_bytes())['packets'][offset]
                    assert producer['offsetHours'] == offset and producer['bytes'] == len(raw) == DECLARED[offset]
                    assert producer['sha256'] == hashlib.sha256(raw).hexdigest()
                save(f'originals/hour-{offset:03}.grib2', raw, 'originals')
                continue
            allowed = (current == root and name in top) or (current == root / 'native' and name in native)
            allowed = allowed or relative in ('attempt/reservation.json', 'attempt/result.json', 'attempt/sources.json')
            allowed = allowed or bool(re.fullmatch('attempt/hour-0(?:0[1-9]|[1-3][0-9]|4[0-8])/(?:transport.json|transport-stdout.txt|transport-stderr.txt)', relative))
            assert allowed and file.suffix in ('.json', '.txt'), 'unreviewed proof member'
            assert file.stat().st_size <= 4 * 1024**2
            raw = file.read_bytes()
            if file.suffix == '.txt': raw = raw[-131072:]
            save(relative, raw, original_bytes=file.stat().st_size)

    ledger = root / 'state/day.sqlite'
    state = []
    if ledger.parent.is_dir():
        for path in sorted(ledger.parent.iterdir()):
            assert path.name in ('day.sqlite', 'day.sqlite-journal', 'day.sqlite-wal', 'day.sqlite-shm')
            assert path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024**2
            raw = path.read_bytes(); state.append({'path': path.name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    if ledger.is_file() and ledger.stat().st_size:
        try:
            db = sqlite3.connect(ledger.as_uri() + '?mode=ro', uri=True, timeout=2)
            try:
                raw = ('\n'.join(db.iterdump()) + '\n').encode(); assert len(raw) <= 131072
                save('durable-ledger.sql', raw)
            finally: db.close()
        except sqlite3.Error as error:
            save('durable-ledger-refusal.json', (json.dumps({'type': type(error).__name__, 'message': str(error)[:512], 'neverReset': True}) + '\n').encode())
    save('durable-state-inventory.json', (json.dumps({'files': state, 'noBinaryUpload': True}, indent=2) + '\n').encode())

    static = root / 'static'
    for name, cap in (('manifest.json', 262144), ('native-proof.json', 1024**2), ('prepared-slot.json', 4096)):
        file = static / name
        if file.exists():
            assert file.is_file() and not file.is_symlink() and file.stat().st_size <= cap
            save('static/' + name, file.read_bytes())
    manifest = static / 'manifest.json'
    if manifest.is_file():
        data = json.loads(manifest.read_bytes()); assert len(data['tiles']) == 272
        for identity in ('0-0', '9-7', '16-15'):
            matches = [tile for tile in data['tiles'] if tile['id'] == identity]; assert len(matches) == 1
            tile = matches[0]; assert re.fullmatch('[a-f0-9]{64}', tile['sha256'])
            file = static / 'tiles' / (tile['sha256'] + '.bin.gz')
            assert file.is_file() and not file.is_symlink() and file.stat().st_size == tile['bytes'] <= 3 * 1024**2
            raw = file.read_bytes(); assert hashlib.sha256(raw).hexdigest() == tile['sha256']
            save('samples/' + identity + '-' + tile['sha256'] + '.bin.gz', raw, 'tiles')
inventory = {'schema': 1, 'files': rows, 'counts': counts, 'maximumEvidenceBytes': whole_cap,
    'providerObjectCohortAndDailyLimitsUnchanged': True, 'runtimeScratchFullStaticArchiveIncluded': False,
    'full49Admission': 'requires exact successful native qualification and successful run; collection alone is no authority',
    'published': False, 'installed': False}
raw = (json.dumps(inventory, indent=2) + '\n').encode(); assert len(raw) <= 65536
with (target / 'artifact-inventory.json').open('xb') as stream: stream.write(raw)
