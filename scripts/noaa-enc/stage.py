#!/usr/bin/env python3
"""Bounded NOAA acquisition + isolated shared conversion. Never publishes.

Default is a local-only plan. --acquire explicitly fetches reviewed cell IDs;
--refresh-catalogue also refreshes the fixed official metadata URL. A failure
leaves the previous generation usable. Original ZIPs and all S57 updates stay
immutable under objects/<sha>.zip and sources/<sha>/ for downstream extraction.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile
import catalogue

PREFIX='noaa-enc/v1/'
AGREEMENT_HTML_SHA='99921c6f5e0e7ad356351c0ed82ded9fca0716618c9d651e95450c5f7f5a611a'
MAX_RAW_CYCLE=512*1024**2
MAX_OUTPUT_CYCLE=4*1024**3
MAX_CELLS_CYCLE=256
MAX_ARCHIVE=32*1024**2
MAX_EXPANDED=128*1024**2
MAX_LOCAL=32*1024**3
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**kw): raise ValueError('Official source redirected; review source before retry')

def digest(raw): return hashlib.sha256(raw).hexdigest()
def fetch(url,cap):
    with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url,headers={'User-Agent':'Thalassa-NOAA-catalogue/1'}),timeout=30) as response:
        if response.status!=200: raise ValueError('Official source unavailable')
        advertised=response.headers.get('Content-Length')
        if advertised and (not advertised.isdigit() or int(advertised)>cap): raise ValueError('Source exceeds byte cap')
        body=response.read(cap+1)
        if not body or len(body)>cap: raise ValueError('Source exceeds byte cap')
        return body

def immutable(root,key,body):
    target=root/key
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():
        if target.is_symlink() or target.read_bytes()!=body: raise ValueError('Immutable source conflict')
    else:
        with target.open('xb') as stream: stream.write(body)
    return {'key':key,'bytes':len(body),'sha256':digest(body)}

def conversion_identity(zip_sha,cli_sha,image):
    # GDAL/image changes can alter the output even when the bundled CLI is unchanged.
    return digest(catalogue.json_bytes({'sourceSha256':zip_sha,'converterSha256':cli_sha,'imageId':image}))

def conversion_current(record,row,cli_sha,image):
    return bool(record) and (record.get('edition'),record.get('update'),record.get('converterSha256'),record.get('imageId'))==(row['edition'],row['update'],cli_sha,image)

def conversion_error_excerpt(error):
    # This NOAA-only subprocess handles fixed public archives, never user charts
    # or environment values. Retain a bounded useful diagnostic, not its command.
    def text(value,cap):
        if isinstance(value,bytes): value=value[:cap].decode('utf-8',errors='replace')
        if not isinstance(value,str): return ''
        return ''.join(char if char.isprintable() or char in '\n\t' else '?' for char in value[:cap])
    return (text(error.stderr,3072)+'\n'+text(error.stdout,1024)).strip()

def retain_conversion(root,record):
    """Keep legacy acquisition receipts byte-for-byte; version conversion receipts."""
    source_key='receipts/'+record['zip']['sha256']+'.json'
    source_path=root/source_key
    source={key:record[key] for key in ('edition','update','zip','sourceDirectory','sourceUrl')}
    if source_path.exists():
        if source_path.is_symlink() or source_path.stat().st_size>65536: raise ValueError('Invalid retained acquisition receipt')
        original=json.loads(source_path.read_bytes())
        if any(original.get(key)!=value for key,value in source.items()): raise ValueError('Retained acquisition identity changed')
    else: immutable(root,source_key,catalogue.json_bytes(source))
    converted={**record,'sourceReceipt':source_key}
    identity=conversion_identity(record['zip']['sha256'],record['converterSha256'],record['imageId'])
    receipt=immutable(root,'conversions/'+record['zip']['sha256']+'/'+identity+'.json',catalogue.json_bytes(converted))
    return {**converted,'conversionReceipt':receipt}

def ensure_capacity(root,additional):
    paths=list(Path(root).rglob('*'))
    if len(paths)>200000 or any(p.is_symlink() for p in paths): raise ValueError('Unexpected NOAA staging inventory')
    used=sum(p.stat().st_size for p in paths if p.is_file())
    if used+additional>MAX_LOCAL: raise ValueError('NOAA local32GiB cap; review retention before growth')
    if shutil.disk_usage(root).free-additional<16*1024**3: raise ValueError('Keep16GiB of weather volume free')

def unpack(archive,target,cell,storage_root=None):
    target=Path(target).resolve()
    if target.exists(): raise ValueError('Immutable source directory already exists without receipt')
    target.mkdir(parents=True)
    with zipfile.ZipFile(archive) as zipped:
        rows=zipped.infolist()
        if len(rows)>512 or sum(r.file_size for r in rows)>MAX_EXPANDED: raise ValueError('Archive expansion exceeds cap')
        if storage_root is not None: ensure_capacity(storage_root,sum(r.file_size for r in rows)+32*1024**2)
        seen=set()
        for row in rows:
            dest=(target/row.filename).resolve()
            if row.filename in seen or not dest.is_relative_to(target) or (row.external_attr>>16)&0o170000==0o120000: raise ValueError('Unsafe NOAA archive member')
            seen.add(row.filename)
        zipped.extractall(target)
    cells=list(target.rglob('*.000'))
    if len(cells)!=1 or cells[0].stem!=cell: raise ValueError('Wrong NOAA source dataset')
    revisions=sorted(int(p.suffix[1:]) for p in cells[0].parent.glob(cell+'.*') if p.suffix[1:].isdigit())
    # Re-issued .000 bases may already include a nonzero update number.
    # Later file suffixes must be contiguous; effective GDAL DSID is still
    # required to match the catalogue's latest update after APPLY.
    later=revisions[1:]
    if not revisions or revisions[0]!=0 or later and later!=list(range(later[0],later[-1]+1)): raise ValueError('NOAA update sequence is incomplete')
    return cells[0],revisions

@contextmanager
def locked(root):
    import fcntl
    root.mkdir(parents=True,exist_ok=True)
    with (root/'refresh.lock').open('a') as handle:
        fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield

def prepare(root,catalogue_path,cells,acquire=False,refresh=False,image=None,cli_sha=None):
    root=Path(root).resolve(); checkout=Path(__file__).resolve().parents[2]
    if root==checkout or checkout in root.parents: raise ValueError('NOAA staging must be outside source checkout')
    raw=Path(catalogue_path).read_bytes()
    normalized=catalogue.parse_catalogue(raw)
    wanted=sorted(set(cells))
    if not wanted or len(wanted)>MAX_CELLS_CYCLE: raise ValueError('Select1–256 explicitly reviewed cells per cycle')
    by_id={row['id']:row for row in normalized['cells']}
    if any(cell not in by_id for cell in wanted): raise ValueError('Unknown or withdrawn cell selected')
    expected=sum(by_id[cell]['expectedZipBytes'] for cell in wanted)
    if expected>MAX_RAW_CYCLE: raise ValueError('NOAA raw cycle cap exceeded')
    result={'apply':False,'selectedCells':wanted,'expectedRawBytes':expected,'rawCycleCap':MAX_RAW_CYCLE,'convertedCycleCap':MAX_OUTPUT_CYCLE,
        'activeCells':len(by_id),'withdrawnCells':len(normalized['withdrawn']),'publication':False,'activation':False}
    if not acquire: return result
    if not image or not image.startswith('sha256:') or len(image)!=71 or not cli_sha or len(cli_sha)!=64: raise ValueError('Pin reviewed image ID and converter SHA')
    verify=subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--entrypoint','node',image,'-e',"const f=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(f.readFileSync('/opt/noaa/convert-cli.mjs')).digest('hex'))"],
        check=True,capture_output=True,text=True,timeout=30)
    if verify.stdout.strip()!=cli_sha: raise ValueError('Converter bundle differs from reviewed SHA')
    if shutil.disk_usage(root).free<16*1024**3: raise ValueError('Keep16GiB free before NOAA staging')
    agreement=fetch(catalogue.AGREEMENT_URL,64*1024)
    if digest(agreement)!=AGREEMENT_HTML_SHA: raise ValueError('NOAA government agreement changed; review before acquisition')
    if refresh:
        raw=fetch(catalogue.CATALOGUE_URL,catalogue.MAX_XML)
        normalized=catalogue.parse_catalogue(raw); by_id={r['id']:r for r in normalized['cells']}
        if any(c not in by_id for c in wanted): raise ValueError('Selected cell withdrawn during refresh')
    immutable(root,'catalogues/'+digest(raw)+'.xml',raw)
    immutable(root,'agreements/'+digest(agreement)+'.html',agreement)
    receipt_path=root/'objects.json'
    objects=json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    total_raw=total_output=0
    for cell in wanted:
        row=by_id[cell]; old=objects.get(cell)
        if conversion_current(old,row,cli_sha,image): continue
        ensure_capacity(root,min(MAX_ARCHIVE,row['expectedZipBytes'])+32*1024**2)
        body=fetch(row['sourceUrl'],min(MAX_ARCHIVE,MAX_RAW_CYCLE-total_raw))
        total_raw+=len(body)
        if abs(len(body)-row['expectedZipBytes'])>1: raise ValueError('Official archive differs from catalogue byte size; refresh/review')
        sha=digest(body); source_dir=root/'sources'/sha
        zip_record=immutable(root,'objects/'+sha+'.zip',body)
        if source_dir.exists():
            cells_found=list(source_dir.rglob(cell+'.000'))
            if len(cells_found)!=1: raise ValueError('Retained source is incomplete')
            base=cells_found[0]
            with zipfile.ZipFile(root/zip_record['key']) as zipped:
                for member in zipped.infolist():
                    if not member.is_dir() and (source_dir/member.filename).read_bytes()!=zipped.read(member): raise ValueError('Retained original source changed')
        else: base,_=unpack(root/zip_record['key'],source_dir,cell,root)
        conversion_id=conversion_identity(sha,cli_sha,image)
        work=root/'conversion-work'/f'{cell}-{sha[:16]}-{conversion_id[:16]}'
        work.mkdir(parents=True,exist_ok=False)
        command=['docker','run','--rm','--network','none','--read-only','--memory','768m','--cpus','1','--pids-limit','128','--cap-drop','ALL',
            '--security-opt','no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=128m','--workdir','/tmp',
            '--mount',f'type=bind,src={source_dir},dst=/input,readonly','--mount',f'type=bind,src={work},dst=/output',image,
            '/input/'+base.relative_to(source_dir).as_posix(),'/output/cell.json',str(row['edition']),str(row['update'])]
        try: done=subprocess.run(command,check=True,capture_output=True,text=True,timeout=600)
        except subprocess.CalledProcessError as error:
            raise ValueError(f'NOAA conversion failed for {cell} (exit {error.returncode}): {conversion_error_excerpt(error)}') from None
        converted=json.loads(done.stdout); data=(work/'cell.json').read_bytes(); chart=json.loads(data)
        if (chart['cellId'],chart['sourceHO'],chart['edition'],chart['updateNumber'],chart['issued'])!=(cell,'US',row['edition'],row['update'],row['issued']): raise ValueError('Effective DSID and official catalogue differ')
        if converted['sha256']!=digest(data) or len(data)>16*1024**2: raise ValueError('Converted object identity/cap failed')
        total_output+=len(data)
        if total_output>MAX_OUTPUT_CYCLE: raise ValueError('Converted cycle cap exceeded')
        record={'edition':row['edition'],'update':row['update'],'zip':zip_record,'chart':immutable(root,'objects/'+digest(data)+'.json',data),
            'sourceDirectory':str(source_dir),'sourceUrl':row['sourceUrl'],'converterSha256':cli_sha,'imageId':image}
        record=retain_conversion(root,record)
        objects[cell]=record
        temporary=root/'objects.json.next'; temporary.write_bytes(catalogue.json_bytes(objects)); temporary.replace(receipt_path)
        (work/'cell.json').unlink(); work.rmdir()  # Only this verified temporary output, never original sources.
    now=dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z')
    directory=root/'generations'/('staged-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S'))
    index=catalogue.generate(normalized,objects,directory,now)
    final=directory.parent/index['generation']; directory.rename(final)
    result.update({'apply':True,'generation':index['generation'],'directory':str(final),'downloadedBytes':total_raw,'convertedBytes':total_output})
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--root',required=True); p.add_argument('--catalogue',required=True)
    p.add_argument('--cells',required=True,help='Comma-separated reviewed NOAA IDs; never coordinates'); p.add_argument('--acquire',action='store_true')
    p.add_argument('--refresh-catalogue',action='store_true'); p.add_argument('--image'); p.add_argument('--converter-sha256')
    args=p.parse_args()
    with locked(Path(args.root)):
        print(json.dumps(prepare(args.root,args.catalogue,args.cells.split(','),args.acquire,args.refresh_catalogue,args.image,args.converter_sha256),indent=2))
