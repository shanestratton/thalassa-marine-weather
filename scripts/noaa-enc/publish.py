#!/usr/bin/env python3
"""Review-first R2 publication. Immutable objects first, root index CAS last.

No credentials are downloaded/exported. Existing server-side R2 environment
names are consumed by boto3 only. No deletes, bucket policy/CORS, DNS or timer
changes. Keep the previous generation for a separately reviewed rollback.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import catalogue
from stage import locked

PREFIX='noaa-enc/v1/'
MAX_REMOTE=32*1024**3
MAX_OBJECTS=40000
def owned(key):
    return isinstance(key,str) and bool(re.fullmatch(r'noaa-enc/v1/(?:index\.json|objects/[a-f0-9]{64}\.(?:json|zip)|generations/[a-f0-9]{24}/(?:index\.json|revisions\.json|shards/x\d{2}y\d{2}\.json)|agreements/[a-f0-9]{64}\.txt)',key))
def hash_file(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()

class R2:
    def __init__(self):
        import boto3
        from botocore.config import Config
        account=os.environ['CATALOGUE_R2_ACCOUNT_ID']; self.bucket=os.environ['CATALOGUE_R2_BUCKET']
        if not re.fullmatch(r'[a-f0-9]{32}',account) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]',self.bucket): raise ValueError('Invalid R2 destination')
        self.client=boto3.client('s3',endpoint_url=f'https://{account}.r2.cloudflarestorage.com',region_name='auto',
            aws_access_key_id=os.environ['CATALOGUE_R2_ACCESS_KEY_ID'],aws_secret_access_key=os.environ['CATALOGUE_R2_SECRET_ACCESS_KEY'],
            config=Config(connect_timeout=10,read_timeout=30,retries={'max_attempts':2}))
    def listing(self):
        rows=[]; token=None; seen=set()
        for _ in range(41):
            args={'Bucket':self.bucket,'Prefix':PREFIX,'MaxKeys':1000}
            if token: args['ContinuationToken']=token
            response=self.client.list_objects_v2(**args)
            for row in response.get('Contents',[]):
                if not owned(row['Key']): raise ValueError('Unexpected object in NOAA prefix')
                rows.append({'key':row['Key'],'bytes':row['Size']})
            if len(rows)>MAX_OBJECTS: raise ValueError('NOAA remote object cap')
            if not response.get('IsTruncated'): return rows
            token=response.get('NextContinuationToken')
            if not token or token in seen: raise ValueError('Invalid R2 pagination')
            seen.add(token)
        raise ValueError('R2 listing cap')
    def get(self,key,cap):
        if not owned(key): raise ValueError('Outside NOAA prefix')
        try: response=self.client.get_object(Bucket=self.bucket,Key=key)
        except self.client.exceptions.NoSuchKey: return None
        stream=response['Body']
        try:
            if response['ContentLength']>cap: raise ValueError('Remote object cap')
            body=stream.read(cap+1)
            if len(body)>cap: raise ValueError('Remote object cap')
            return body,response['ETag']
        finally: stream.close()
    def put(self,key,body,previous=None,immutable=True):
        if not owned(key): raise ValueError('Outside NOAA prefix')
        args={'Bucket':self.bucket,'Key':key,'Body':body,'Metadata':{'sha256':hashlib.sha256(body).hexdigest()},
            'ContentType':'application/zip' if key.endswith('.zip') else 'text/plain; charset=utf-8' if key.endswith('.txt') else 'application/json',
            'CacheControl':'public,max-age=31536000,immutable' if immutable else 'public,max-age=3600'}
        args['IfMatch' if previous is not None else 'IfNoneMatch']=previous if previous is not None else '*'
        self.client.put_object(**args)

def prepare(store,root,generation,agreement,rollback=False):
    root=Path(root).resolve(); generation=Path(generation).resolve(); agreement=Path(agreement).resolve()
    if generation.parent!=root/'generations' or not re.fullmatch(r'[a-f0-9]{24}',generation.name): raise ValueError('Outside NOAA generation root')
    raw=(generation/'index.json').read_bytes()
    if len(raw)>256*1024: raise ValueError('Root index cap')
    index=json.loads(raw)
    if index.get('schema')!=1 or index.get('generation')!=generation.name or index.get('agreementSha256')!=catalogue.AGREEMENT_SHA: raise ValueError('Invalid generation')
    terms=agreement.read_bytes().replace(b'\r\n',b'\n').replace(b'\r',b'\n')
    if hashlib.sha256(terms).hexdigest()!=catalogue.AGREEMENT_SHA: raise ValueError('Canonical government agreement changed')
    required={f'generations/{generation.name}/index.json':generation/'index.json'}
    revisions=index.get('revisions'); revision_body=None; revision_rows={}
    if revisions is not None:
        path=generation/'revisions.json'
        if not isinstance(revisions,dict) or set(revisions)!=set(('key','bytes','sha256')) or revisions.get('key')!=f'generations/{generation.name}/revisions.json' or type(revisions.get('bytes')) is not int or not 0<revisions['bytes']<=1024**2 or not isinstance(revisions.get('sha256'),str) or not re.fullmatch(r'[a-f0-9]{64}',revisions['sha256']) or path.stat().st_size!=revisions['bytes'] or hash_file(path)!=revisions['sha256']: raise ValueError('Revision index changed')
        revision_body=json.loads(path.read_bytes())
        if not isinstance(revision_body,dict) or set(revision_body)!=set(('schema','generation','cells')) or revision_body.get('schema')!=1 or revision_body.get('generation')!=generation.name or not isinstance(revision_body.get('cells'),list) or len(revision_body['cells'])!=index['activeCells'] or len(revision_body['cells'])>10000: raise ValueError('Invalid revision coverage')
        required[revisions['key']]=path
    for region in index['shards']:
        name=region['id']
        if not re.fullmatch(r'x(?:0\d|[12]\d|3[0-5])y(?:0\d|1[0-7])',name) or region['key']!=f'generations/{generation.name}/shards/{name}.json': raise ValueError('Invalid regional path')
        path=generation/'shards'/(name+'.json')
        if path.stat().st_size!=region['bytes'] or hash_file(path)!=region['sha256']: raise ValueError('Region changed')
        body=json.loads(path.read_bytes())
        if body.get('schema')!=1 or body.get('generation')!=generation.name or len(body.get('cells',[]))>4096: raise ValueError('Invalid regional catalogue')
        required[region['key']]=path
        for cell in body['cells']:
            revision={key:cell[key] for key in ('id','edition','update','issued','baseIssued')}
            if cell['id'] in revision_rows and revision_rows[cell['id']]!=revision: raise ValueError('Conflicting regional revisions')
            revision_rows[cell['id']]=revision
            if cell['chart'] is None: continue
            for kind,extension in [('chart','json'),('zip','zip')]:
                obj=cell[kind]
                if not re.fullmatch(r'[a-f0-9]{64}',obj['sha256']) or obj['key']!=f"objects/{obj['sha256']}.{extension}": raise ValueError('Invalid object path')
                path=root/obj['key']
                if path.stat().st_size!=obj['bytes'] or hash_file(path)!=obj['sha256']: raise ValueError('Immutable conversion/source changed')
                required[obj['key']]=path
    if revision_body is not None and revision_body['cells']!=[revision_rows[key] for key in sorted(revision_rows)]: raise ValueError('Revision index differs from regional catalogue')
    agreement_key=f'agreements/{catalogue.AGREEMENT_SHA}.txt'
    agreement_file=root/'agreements'/(catalogue.AGREEMENT_SHA+'.txt')
    agreement_file.parent.mkdir(exist_ok=True)
    if not agreement_file.exists(): agreement_file.write_bytes(terms)
    if agreement_file.read_bytes()!=terms: raise ValueError('Agreement source conflict')
    required[agreement_key]=agreement_file
    inventory=store.listing(); existing={r['key']:r['bytes'] for r in inventory}
    uploads=[{'key':PREFIX+key,'file':str(path),'bytes':path.stat().st_size,'sha256':hash_file(path)} for key,path in sorted(required.items())]
    new_bytes=sum(row['bytes'] for row in uploads if row['key'] not in existing)
    total=sum(existing.values())+new_bytes+len(raw)
    if total>MAX_REMOTE or len(existing)+len([r for r in uploads if r['key'] not in existing])+1>MAX_OBJECTS: raise ValueError('NOAA remote32GiB/40000object cap; review retention before growth')
    current=store.get(PREFIX+'index.json',256*1024)
    previous=json.loads(current[0]) if current else None
    source_time=catalogue.timestamp_value(index['sourceAt'])
    if previous and catalogue.timestamp_value(previous.get('sourceAt'))>source_time and not rollback: raise ValueError('Older source catalogue cannot replace current')
    return {'schema':1,'rollback':rollback,'generation':generation.name,'previousGeneration':previous.get('generation') if previous else None,
        'expectedETag':current[1] if current else None,'uploads':uploads,'manifestLast':{'key':PREFIX+'index.json','file':str(generation/'index.json'),
        'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)},'newBytes':new_bytes,'totalRemoteBytesAfter':total,'retentionDeletes':[]}

def apply(store,plan,root,generation,agreement):
    if prepare(store,root,generation,agreement,rollback=plan.get('rollback') is True)!=plan: raise ValueError('Reviewed publication plan changed')
    for row in plan['uploads']:
        data=Path(row['file']).read_bytes()
        if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']: raise ValueError('Staged source changed')
        current=store.get(row['key'],row['bytes'])
        if current:
            if current[0]!=data: raise ValueError('Immutable R2 conflict')
        else: store.put(row['key'],data)
        verified=store.get(row['key'],row['bytes'])
        if not verified or verified[0]!=data: raise ValueError('R2 verification failed; old root index retained')
    row=plan['manifestLast']; data=Path(row['file']).read_bytes()
    if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']: raise ValueError('Root source changed')
    store.put(row['key'],data,previous=plan['expectedETag'],immutable=False)
    live=store.get(row['key'],256*1024)
    if not live or live[0]!=data: raise ValueError('Root readback failed; no deletion or timer change')
    return {'publishedGeneration':plan['generation'],'previousGeneration':plan['previousGeneration'],'objectsVerified':len(plan['uploads']),'deletedObjects':0}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--root',required=True); p.add_argument('--generation',required=True)
    p.add_argument('--agreement',required=True); p.add_argument('--review-plan',required=True); p.add_argument('--apply',action='store_true'); p.add_argument('--plan-sha256')
    p.add_argument('--rollback',action='store_true',help='Explicit reviewed older-generation plan only; never used by weekly runner')
    a=p.parse_args()
    with locked(Path(a.root)):
        store=R2()
        if a.apply:
            raw=Path(a.review_plan).read_bytes()
            if len(raw)>16*1024**2 or hashlib.sha256(raw).hexdigest()!=a.plan_sha256: raise ValueError('Exact reviewed plan SHA required')
            print(json.dumps(apply(store,json.loads(raw),a.root,a.generation,a.agreement),indent=2))
        else:
            plan=prepare(store,a.root,a.generation,a.agreement,a.rollback); raw=catalogue.json_bytes(plan); Path(a.review_plan).write_bytes(raw)
            print(json.dumps({'apply':False,'generation':plan['generation'],'newBytes':plan['newBytes'],'totalRemoteBytesAfter':plan['totalRemoteBytesAfter'],
                'objects':len(plan['uploads']),'reviewPlanSha256':hashlib.sha256(raw).hexdigest(),'activation':False},indent=2))
