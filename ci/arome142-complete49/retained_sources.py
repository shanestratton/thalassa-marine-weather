"""Only two exact retained GitHub artifacts; no provider or native imports."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile

ALLOWED_H000 = ["artifact-inventory.json","attempt/original.grib2","attempt/reservation.json","attempt/result.json","attempt/transport-stderr.txt","attempt/transport-stdout.txt","attempt/transport.json","capture-process-exit.txt","catalogue-original.json","cleanup-arome142-pilot-capture-39034457993.service.txt","cleanup-arome142-pilot-kernel-39034457993.service.txt","cleanup-arome142-pilot-native-39034457993.service.txt","control.txt","controller-source.txt","durable-ledger.sql","install.txt","kernel-preflight.txt","kernel-process-exit.txt","native/kernel-before-original-get.json","native-source-manifest.json","native-source-sha256.txt","native.txt","node.txt","offline27.txt","one-original-parent.txt","packages.txt","pip-check.txt","python.txt","reviewed-one-pilot-ticket.json","source.txt","unchanged17.txt"]
ALLOWED_MASK = ["artifact-inventory.json","attempt/reservation.json","attempt/original.grib2","attempt/result.json","attempt/transport-stderr.txt","attempt/transport-stdout.txt","attempt/transport.json","capture-process-exit.txt","cleanup-arome142-constant-capture-39039757963.service.txt","cleanup-arome142-constant-kernel-39039757963.service.txt","cleanup-arome142-constant-native-39039757963.service.txt","constant48.txt","control.txt","controller-source.txt","controller15.txt","durable-ledger.sql","durable-state-inventory.json","install.txt","kernel-preflight.txt","kernel-process-exit.txt","native/kernel-before-constant-native.json","native/kernel-before-constant-get.json","native/original-mask.json","native-mask.txt","native-process-exit.txt","native-source-manifest.json","node.txt","one-constant-parent.txt","pip-check.txt","packages.txt","posix-link-fixtures10.txt","prior-actual-h000-native.json","python.txt","read-only-original-after.json","read-only-original-manifest.json","read-only-runtime-after.json","read-only-runtime-manifest.json","reviewed-one-constant-ticket.json","source.txt","source18.txt"]


def members(path, size, digest, allowed, selected):
    assert path.is_file() and not path.is_symlink() and path.stat().st_size == size
    raw = path.read_bytes(); assert hashlib.sha256(raw).hexdigest() == digest
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        assert len(infos) == len(allowed) and {item.filename for item in infos} == set(allowed)
        assert sum(item.file_size for item in infos) <= 4 * 1024**2
        for item in infos:
            name = PurePosixPath(item.filename)
            assert item.orig_filename == item.filename and not name.is_absolute() and '..' not in name.parts
            assert '\\' not in item.filename and ':' not in item.filename and not item.is_dir()
            assert not item.flag_bits & 1 and not stat.S_ISLNK(item.external_attr >> 16)
            assert 0 <= item.file_size <= 3 * 1024**2
        return {name: archive.read(name) for name in selected}


parser = argparse.ArgumentParser()
parser.add_argument('--h000-archive', type=Path, required=True)
parser.add_argument('--mask-archive', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
h000 = members(args.h000_archive, 1431720,
    '8cb97e202daf2ad480d70ecfab78fe1a431609cdc5071f4a4b4774174d9aad32', ALLOWED_H000,
    ('attempt/original.grib2', 'attempt/result.json', 'source.txt', 'control.txt', 'controller-source.txt'))
mask = members(args.mask_archive, 493973,
    '34304ced3a31dbcef7cb0adad3653c16224c46455e64f9adfa57459b5595f9cf', ALLOWED_MASK,
    ('attempt/original.grib2', 'attempt/result.json', 'attempt/transport.json', 'native/original-mask.json',
     'source.txt', 'control.txt', 'controller-source.txt'))
assert h000['source.txt'].strip() == b'9f2364baa85ed1ef4b796379789b8140616fa721'
assert h000['control.txt'].strip() == b'66a39275a6521abb9a3a29ec7a91e7f5d47fcac5'
assert h000['controller-source.txt'].strip() == b'e4408f7a961de9f8a3997cda1290b188543aa92e'
assert mask['source.txt'].strip() == b'cf21a611c6b22db62449bc1658e7ae8b931476be'
assert mask['control.txt'].strip() == b'3ed19f6359b7d9128858996880676d0f0a1e5e76'
assert mask['controller-source.txt'].strip() == b'66969ef49ed50e283eeb47012dadcf86fe6cc1b3'
assert len(h000['attempt/original.grib2']) == 1373100 and hashlib.sha256(h000['attempt/original.grib2']).hexdigest() == '4e2e34400535158f696f1684c74bebb6d08126e37f9f713f29f94a30498bd733'
assert len(mask['attempt/original.grib2']) == 44900 and hashlib.sha256(mask['attempt/original.grib2']).hexdigest() == 'b7d5864f26d11f9c82997d8ca8cd16a499c95fd8d9d0adcaf24f1c33b85a4ae2'
assert len(mask['native/original-mask.json']) == 6798 and hashlib.sha256(mask['native/original-mask.json']).hexdigest() == '45f91a998910c4439a8c116d6bf6b746ad363cd4ecd6ce107be4e0b772d261ec'
args.output.mkdir(mode=0o700)
files = {'h000.grib2': h000['attempt/original.grib2'], 'mask.grib2': mask['attempt/original.grib2'],
    'mask-proof.json': mask['native/original-mask.json'], 'h000-capture.json': h000['attempt/result.json'],
    'mask-capture.json': mask['attempt/result.json'], 'mask-transport.json': mask['attempt/transport.json']}
for name, raw in files.items():
    with (args.output / name).open('xb') as stream: stream.write(raw)
proof = {'h000AcquisitionSource': '9f2364baa85ed1ef4b796379789b8140616fa721',
    'correctedScientificSource': 'cf21a611c6b22db62449bc1658e7ae8b931476be',
    'h000Artifact': 12101249246, 'maskArtifact': 12103622079, 'providerRequests': 0,
    'files': [{'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} for name, raw in files.items()]}
with (args.output / 'verified-retained.json').open('x') as stream:
    stream.write(json.dumps(proof, sort_keys=True, indent=2) + '\n')
