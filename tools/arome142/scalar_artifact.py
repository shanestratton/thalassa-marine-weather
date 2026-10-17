"""Verify the exact retained GitHub artifact; no provider or network client."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile

from catalogue import require
from scalar_inspection import ORIGINAL_BYTES, ORIGINAL_SHA

ARTIFACT_ID = 12101249246
ARTIFACT_BYTES = 1431720
ARTIFACT_SHA = '8cb97e202daf2ad480d70ecfab78fe1a431609cdc5071f4a4b4774174d9aad32'
RUN_ID = 39034457993
CONTROL = '66a39275a6521abb9a3a29ec7a91e7f5d47fcac5'
CONTROLLER = 'e4408f7a961de9f8a3997cda1290b188543aa92e'
SOURCE = '9f2364baa85ed1ef4b796379789b8140616fa721'
SELECT = ('attempt/original.grib2', 'attempt/result.json', 'native/kernel-before-original-get.json',
          'native-source-manifest.json', 'native.txt', 'source.txt', 'control.txt', 'controller-source.txt',
          'cleanup-arome142-pilot-kernel-39034457993.service.txt',
          'cleanup-arome142-pilot-capture-39034457993.service.txt',
          'cleanup-arome142-pilot-native-39034457993.service.txt')


def inventory(archive):
    infos = archive.infolist()
    require(len(infos) == 31 and len({item.filename for item in infos}) == 31, 'artifact member identity/count')
    total = 0
    for item in infos:
        path = PurePosixPath(item.filename)
        require(item.orig_filename == item.filename and not path.is_absolute()
                and '\\' not in item.filename and '..' not in path.parts
                and ':' not in item.filename and not item.is_dir(), 'artifact path refused')
        require(not item.flag_bits & 1 and not stat.S_ISLNK(item.external_attr >> 16), 'artifact encrypted/link member')
        require(0 <= item.file_size <= 2 * 1024**2, 'artifact expanded member cap')
        total += item.file_size
    require(total <= 4 * 1024**2, 'artifact expanded aggregate cap')
    require(set(SELECT).issubset(item.filename for item in infos), 'artifact required receipts missing')


def verified_members(raw):
    require(len(raw) == ARTIFACT_BYTES and hashlib.sha256(raw).hexdigest() == ARTIFACT_SHA,
            'exact original artifact digest/size changed')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        inventory(archive)
        members = {name: archive.read(name) for name in SELECT}
    original = members['attempt/original.grib2']
    require(len(original) == ORIGINAL_BYTES and hashlib.sha256(original).hexdigest() == ORIGINAL_SHA,
            'exact captured original digest/size changed')
    for name, expected in (('source.txt', SOURCE), ('control.txt', CONTROL), ('controller-source.txt', CONTROLLER)):
        require(members[name] == (expected + '\n').encode(), 'original provenance source changed')
    capture = json.loads(members['attempt/result.json'])
    require(capture['outcome'] == 'download-complete-native-unadmitted'
            and capture['originalSha256'] == ORIGINAL_SHA and capture['writtenOriginalBytes'] == ORIGINAL_BYTES
            and capture['nativeAdmitted'] is False and capture['published'] is False, 'original capture identity')
    for name in SELECT:
        if name.startswith('cleanup-'):
            require(b'MainPID=0\n' in members[name] and b'ActiveState=inactive\n' in members[name]
                    and b'LoadState=not-found\n' in members[name], 'original unit cleanup unavailable')
    return members


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(args.archive.is_file() and not args.archive.is_symlink()
            and args.archive.stat().st_size == ARTIFACT_BYTES, 'artifact path/size')
    members = verified_members(args.archive.read_bytes())
    args.output.mkdir(mode=0o700)
    for name, raw in members.items():
        path = args.output / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write(raw)
    proof = {'artifactId': ARTIFACT_ID, 'runId': RUN_ID, 'control': CONTROL, 'source': SOURCE,
             'artifactBytes': ARTIFACT_BYTES, 'artifactSha256': ARTIFACT_SHA,
             'originalBytes': ORIGINAL_BYTES, 'originalSha256': ORIGINAL_SHA,
             'originalFieldsAdmitted': False, 'providerRequests': 0,
             'files': [{'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                       for name, raw in members.items()]}
    with (args.output / 'verified-retained-artifact.json').open('x') as stream:
        stream.write(json.dumps(proof, sort_keys=True, indent=2) + '\n')


if __name__ == '__main__':
    main()
