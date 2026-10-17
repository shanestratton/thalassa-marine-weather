"""Fixed offline9f decoder boundary. Kernel admission precedes native imports."""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import resource
import socket
import sys

CAP = 2147483648
EXPECTED_FILES = {
    'native.py': '8a17f8650a4bc95ce9ec3562dbf961e8a7bedd82e4c915f75a77c726ead76c69',
    'catalogue.py': 'bb1ef354dc669dc6a4ebc2e1800852b1e6e5d96dd95ff8487213881a631257dd',
    'native-requirements.lock': 'cfd6e6ae3863ee58bd40f780df1fbf86443790989f050e2063163f2f96df2f64',
}


def require(ok, why):
    if not ok:
        raise ValueError(why)


def kernel_before_native():
    require(sys.platform == 'linux', 'Linux kernel proof required')
    require(not {'eccodes', 'numpy', 'xarray', 'netCDF4', 'h5py'}.intersection(sys.modules), 'native imported before kernel admission')
    status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    require(all(int(x) > 0 for x in status['Uid'].split()), 'nonroot required')
    require(status['NoNewPrivs'].strip() == '1', 'NoNewPrivileges required')
    for key in ('CapEff', 'CapPrm', 'CapInh', 'CapBnd', 'CapAmb'):
        require(int(status[key].strip(), 16) == 0, 'capability set not empty')
    require(resource.getrlimit(resource.RLIMIT_AS) == (CAP, CAP), 'address-space hard limit')
    rows = [line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::')]
    require(len(rows) == 1 and rows[0].startswith('/') and '..' not in rows[0].split('/'), 'own cgroup2 required')
    cgroup = Path('/sys/fs/cgroup', rows[0].lstrip('/'))
    require(cgroup.resolve().is_relative_to(Path('/sys/fs/cgroup')), 'cgroup path escaped')
    facts = {name: (cgroup / name).read_text().strip() for name in
             ('memory.max', 'memory.swap.max', 'pids.max', 'cpu.max')}
    require(facts['memory.max'] == str(CAP) and facts['memory.swap.max'] == '0'
            and facts['pids.max'] == '16', 'actual own memory/swap/task ceilings changed')
    cpu = facts['cpu.max'].split()
    require(len(cpu) == 2 and cpu[0] != 'max' and int(cpu[0]) == int(cpu[1]) and int(cpu[1]) > 0,
            'actual own CPU quota is not1CPU')
    fds = []
    for fd in Path('/proc/self/fd').iterdir():
        try:
            value = os.readlink(fd)
        except FileNotFoundError:
            continue
        require(int(fd.name) in (0, 1, 2), 'inherited extra file descriptor')
        fds.append({'fd': int(fd.name), 'target': value})
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            probe = socket.socket(family, socket.SOCK_STREAM)
        except OSError as error:
            require(error.errno in (errno.EPERM, errno.EAFNOSUPPORT, errno.EACCES), 'unexpected address-family refusal')
        else:
            probe.close()
            raise ValueError('kernel did not deny internet address family before native import')
    return cgroup, {'ownCgroup': rows[0], 'limits': facts, 'rlimitAS': [CAP, CAP], 'uid': os.getuid(),
                    'noNewPrivileges': True, 'capabilities': 'all-zero', 'inheritedFDs': fds,
                    'internetAddressFamiliesDeniedBeforeImport': True}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--kernel-only':
        _, facts = kernel_before_native()
        with Path(sys.argv[2]).open('x') as stream:
            stream.write(json.dumps({'kernelOnly': True, 'nativeImported': False, **facts}, sort_keys=True, indent=2) + '\n')
        return
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--capture', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    cgroup, kernel = kernel_before_native()
    require(args.manifest.is_file() and args.manifest.stat().st_size < 32768, 'source manifest cap')
    manifest = json.loads(args.manifest.read_bytes())
    require(manifest['source'] == '9f2364baa85ed1ef4b796379789b8140616fa721', 'unreviewed decoder source')
    require(manifest['files'] == EXPECTED_FILES, 'unreviewed decoder digest manifest')
    for name in ('native.py', 'catalogue.py', 'native-requirements.lock'):
        file = args.source / 'tools/arome142' / name
        require(file.is_file() and not file.is_symlink() and file.stat().st_size <= 128 * 1024, 'decoder path bound')
        require(hashlib.sha256(file.read_bytes()).hexdigest() == manifest['files'][name], 'frozen decoder source changed')
    require(args.input.is_file() and not args.input.is_symlink() and args.input.stat().st_size == 1373100,
            'original input length/path changed')
    before = args.input.stat()
    raw = args.input.read_bytes()
    capture = json.loads(args.capture.read_bytes())
    raw_sha = hashlib.sha256(raw).hexdigest()
    require(capture['outcome'] == 'download-complete-native-unadmitted' and capture['originalSha256'] == raw_sha,
            'exact original capture identity unavailable')
    sys.path.insert(0, str(args.source / 'tools/arome142'))
    from catalogue import original_run
    from datetime import datetime, timezone
    original_run('2026-10-17T00:00:00Z', 'NCALED', datetime.now(timezone.utc))
    import eccodes
    import numpy as np
    from native import FIELDS, PARAMETERS, exact_messages, decode_packet
    packing = {}
    for message in exact_messages(raw):
        handle = eccodes.codes_new_from_message(message)
        try:
            identity = tuple(eccodes.codes_get_long(handle, k) for k in
                             ('discipline', 'parameterCategory', 'parameterNumber', 'typeOfFirstFixedSurface', 'level'))
            for field in FIELDS:
                if identity == PARAMETERS[field]:
                    require(field not in packing, 'duplicate selected original header')
                    packing[field] = {'packingType': eccodes.codes_get_string(handle, 'packingType'),
                                      'bitsPerValue': eccodes.codes_get_long(handle, 'bitsPerValue'),
                                      'bitmapPresent': eccodes.codes_get_long(handle, 'bitmapPresent')}
        finally:
            eccodes.codes_release(handle)
    # EXACT9f function; scalar admission precedes every selected native array.
    fields, metadata = decode_packet(raw, 'NCALED', '2026-10-17T00:00:00Z', 0)
    summaries = {}
    for field in FIELDS:
        values = fields[field]
        require(values.shape == (801, 721) and values.size == 577521, 'full original-cell cardinality')
        finite = np.isfinite(values)
        count = int(np.count_nonzero(finite))
        summaries[field] = {'shape': list(values.shape), 'cells': int(values.size), 'finiteCells': count,
                            'unknownCells': int(values.size - count), 'minimum': float(np.min(values[finite])) if count else None,
                            'maximum': float(np.max(values[finite])) if count else None,
                            'decodedF64LEsha256': hashlib.sha256(values.tobytes(order='C')).hexdigest(),
                            'originalMetadata': metadata[field], 'packing': packing[field]}
    after = args.input.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'original changed during native decode')
    original_run('2026-10-17T00:00:00Z', 'NCALED', datetime.now(timezone.utc))
    libraries = []
    for name in sorted({row.split()[-1] for row in Path('/proc/self/maps').read_text().splitlines() if '.so' in row and '/' in row}):
        file = Path(name)
        if file.is_file():
            require(file.stat().st_size <= 128 * 1024**2 and len(libraries) < 256, 'loaded native closure bound')
            libraries.append({'path': str(file.resolve()), 'bytes': file.stat().st_size,
                              'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
    require(not {'xarray', 'netCDF4', 'h5py', 'rasterio'}.intersection(sys.modules), 'unreviewed decoder imported')
    result = {'schema': 1, 'source': manifest['source'], 'inputBytes': len(raw), 'inputSha256': raw_sha,
              'kernelBeforeNative': kernel, 'fields': summaries, 'actualEcCodesAPI': eccodes.codes_get_api_version(),
              'actualNumpy': np.__version__, 'loadedLibraries': libraries,
              'processMaxRSSKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              'ownMemoryPeakBytes': int((cgroup / 'memory.peak').read_text()),
              'ownMemoryEvents': (cgroup / 'memory.events').read_text(), 'originalLandSeaMaskAdmitted': False,
              'full49HourCohortAdmitted': False, 'published': False, 'nativeOriginalPilotOnly': True}
    encoded = (json.dumps(result, sort_keys=True, indent=2) + '\n').encode()
    require(len(encoded) <= 512 * 1024, 'native evidence text bound')
    with args.output.open('xb') as stream:
        stream.write(encoded)
    print(json.dumps({'outcome': 'original-five-field-native-pilot-passed', 'bytes': len(encoded), 'originalSha256': raw_sha}))


if __name__ == '__main__':
    main()
