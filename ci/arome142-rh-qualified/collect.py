"""Strict ≤4MiB text and ≤3tiles/9MiB. Never originals/scratch/runtime."""
import hashlib
import json
import os
from pathlib import Path
import re

temp=Path(os.environ['RUNNER_TEMP']);root=temp/'arome142-rh-qualified-evidence';target=temp/'arome142-rh-qualified-artifact'
target.mkdir(mode=0o700)
run=os.environ['GITHUB_RUN_ID'];assert re.fullmatch('[0-9]+',run)
allowed={'retained-artifact-download.txt','source.txt','controller-source.txt','control.txt','python.txt','node.txt',
    'verified-retained.json','native-source-manifest.json','js-source-manifest.json','posix-link-fixtures10.txt','cleanup-fixtures5.txt',
    'complete26.txt','range13.txt','rh26.txt','constant48.txt','controller15.txt','source18.txt',
    'install.txt','pip-check.txt','packages.txt','read-only-runtime-manifest.json','read-only-runtime-after.json',
    'read-only-js-manifest.json','read-only-js-after.json','read-only-phase-manifest.json','read-only-phase-after.json',
    'compiled-fixtures-base.txt','compiled-fixtures-rh.txt','generated-base-proof.json','generated-rh-proof.json',
    'native/kernel-before-generated-base.json','native/kernel-before-generated-rh.json','native/kernel-before-js.json',
    'generated-js-interop.txt','rh-interop-proof.json','js-boundary-proof.json','new-phase.json',
    'native-remaining-seconds.txt','final-phase-remaining-seconds.txt','qualification-disk.txt','retained-qualified-native.txt',
    'native/kernel-before-rh-qualification.json','native/retained-qualified-rh-partial.json',
    'native/native-proof.json','native/manifest.json','native/prepared-slot.json'}
allowed.update(f'cleanup-arome142-rh-qualified-{kind}-{run}.service.txt' for kind in ('base','rh','js','native'))
rows=[];text_total=tile_total=tile_count=0
if root.is_dir() and not root.is_symlink():
    for directory,children,files in os.walk(root,followlinks=False):
        directory=Path(directory)
        for child in children:assert not (directory/child).is_symlink()
        for name in sorted(files):
            source=directory/name;relative=source.relative_to(root).as_posix()
            assert source.is_file() and not source.is_symlink()
            tile=re.fullmatch(r'native/sample-(?:[0-9]|1[0-6])-(?:[0-9]|1[0-5])-[a-f0-9]{64}\.bin\.gz',relative)
            assert relative in allowed or tile
            assert source.stat().st_size<=(3*1024**2 if tile else 4*1024**2)
            raw=source.read_bytes()
            if tile:
                assert hashlib.sha256(raw).hexdigest()==name.rsplit('-',1)[-1][:-7]
                tile_count+=1;tile_total+=len(raw);assert tile_count<=3 and tile_total<=9*1024**2
            else:
                if source.suffix=='.txt':raw=raw[-131072:]
                raw.decode('utf-8');text_total+=len(raw);assert text_total<=4*1024**2-65536
            destination=target/relative;destination.parent.mkdir(parents=True,exist_ok=True)
            with destination.open('xb') as stream:stream.write(raw)
            rows.append({'path':relative,'bytes':len(raw),'sourceBytes':source.stat().st_size,'sha256':hashlib.sha256(raw).hexdigest()})
inventory={'schema':1,'files':rows,'textBytes':text_total,'tileBytes':tile_total,'tileCount':tile_count,
    'maximumTextBytes':4*1024**2,'maximumTileBytes':9*1024**2,'maximumTileCount':3,
    'originalsIncluded':False,'fullNativeArraysIncluded':False,'runtimeOrScratchIncluded':False,
    'representativeQualifiedTileCount':tile_count,
    'rawScientificSource':'cf21a611c6b22db62449bc1658e7ae8b931476be',
    'scientificSource':'bbd57495546fa93bba7316f414b7d8975cf4dbec',
    'originalCaptureQualificationSucceeded':False,'originalForecastExpiryRenewed':False,
    'originalExpiresAt':'2026-10-17T18:00:00Z','providerRequests':0,'published':False}
raw=(json.dumps(inventory,indent=2)+'\n').encode();assert len(raw)<=65536
with (target/'artifact-inventory.json').open('xb') as stream:stream.write(raw)
