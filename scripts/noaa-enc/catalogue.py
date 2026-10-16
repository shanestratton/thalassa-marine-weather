"""Normalize the official ISO19115 catalogue. No network or credentials.

No-extent records are withdrawn, not installable coverage. NOAA retains such
records and cancellation updates (effective DSID EDTN=0) in its current ZIPs.
"""
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

CATALOGUE_URL = 'https://charts.noaa.gov/ENCs/ENCProdCat_19115.xml'
AGREEMENT_URL = 'https://charts.noaa.gov/ENCs/ENC_Agreement.shtml'
AGREEMENT_SHA = '175f625ba0ae7b8656bf41010d6e5226b70f66a5a5c00ceff450c2eba2411c24'
NS = {'g':'http://www.isotc211.org/2005/gmd','c':'http://www.isotc211.org/2005/gco','m':'http://www.opengis.net/gml/3.2'}
CELL = re.compile(r'US[1-6][A-Z0-9]{5}')
MAX_XML = 64 * 1024**2
MAX_CELLS = 10000

def iso_date(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value): raise ValueError('Invalid chart date')
    dt.date.fromisoformat(value)
    return value

def segments(bbox):
    w,s,e,n=bbox
    return [[w,s,e,n]] if w<e else [[w,s,180,n],[-180,s,e,n]]

def extent(record):
    points=[]
    for node in record.findall('./g:identificationInfo//g:geographicElement//m:pos',NS):
        pair=(node.text or '').split()
        if len(pair)!=2: raise ValueError('Unexpected NOAA extent coordinate')
        lat,lon=map(float,pair)
        # NOAA's Pacific polygons deliberately unwrap longitude past180
        # (e.g. -220.25). Normalize one adjacent revolution before sharding.
        if not math.isfinite(lat+lon) or not -90<=lat<=90 or not -540<=lon<=540: raise ValueError('Invalid NOAA extent')
        lon=(lon+180)%360-180
        points.append((lon,lat))
    if not points: return None
    if len(points)>4096: raise ValueError('NOAA extent complexity exceeds cap')
    lons=sorted(set(p[0] for p in points)); lats=[p[1] for p in points]
    # Smallest circular longitude interval: Alaska/Pacific cells may cross180.
    gaps=[((lons[(i+1)%len(lons)]-lon)%360,i) for i,lon in enumerate(lons)]
    _,gap=max(gaps)
    west,east=lons[(gap+1)%len(lons)],lons[gap]
    south,north=min(lats),max(lats)
    if west==east or south>=north: raise ValueError('Degenerate NOAA extent')
    return [west,south,east,north]

def parse_catalogue(raw):
    if not raw or len(raw)>MAX_XML or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper(): raise ValueError('Unsafe or oversized NOAA catalogue')
    root=ET.fromstring(raw)
    if root.tag != '{'+NS['g']+'}DS_Series': raise ValueError('Unexpected NOAA catalogue root')
    rows,withdrawn,seen=[],[],set()
    source_at=root.findtext('./g:seriesMetadata/g:MD_Metadata/g:dateStamp/c:DateTime',namespaces=NS)
    for record in root.findall('.//g:MD_Metadata',NS):
        title=record.findtext('./g:identificationInfo//g:title/c:CharacterString',namespaces=NS)
        if not title: continue
        if title=='ENC Product Catalog': continue  # The single series-level description, not a cell.
        if not CELL.fullmatch(title) or title in seen: raise ValueError('Invalid/duplicate NOAA identity')
        seen.add(title)
        if len(seen)>MAX_CELLS: raise ValueError('NOAA catalogue count exceeds cap')
        box=extent(record)
        if box is None:
            withdrawn.append(title)
            continue
        revision=record.findtext('./g:identificationInfo//g:edition/c:CharacterString',namespaces=NS) or ''
        match=re.fullmatch(r'([1-9]\d{0,3})\.(\d{1,4})',revision)
        if not match: raise ValueError('Invalid NOAA edition/update')
        url=record.findtext('.//g:distributionInfo//g:URL',namespaces=NS)
        if url!='https://www.charts.noaa.gov/ENCs/'+title+'.zip': raise ValueError('NOAA archive source changed')
        dates={}
        for node in record.findall('./g:identificationInfo//g:CI_Date',NS):
            code=node.find('./g:dateType/g:CI_DateTypeCode',NS)
            if code is not None: dates[code.get('codeListValue')]=node.findtext('./g:date/c:Date',namespaces=NS)
        scale=int(record.findtext('./g:identificationInfo//g:denominator/c:Integer',namespaces=NS) or '0')
        size=float(record.findtext('.//g:transferSize/c:Real',namespaces=NS) or 'nan')*1024**2
        if not math.isfinite(size) or not 1<=size<=32*1024**2 or not 1<=scale<=10000000: raise ValueError('NOAA scale/archive cap')
        name=record.findtext('./g:identificationInfo//g:alternateTitle/c:CharacterString',namespaces=NS) or title
        if len(name)>512: raise ValueError('NOAA title exceeds cap')
        rows.append({'id':title,'title':name,'bbox':box,'edition':int(match[1]),'update':int(match[2]),
            'issued':iso_date(dates.get('publication')),'baseIssued':iso_date(dates.get('revision')),
            'scale':scale,'sourceUrl':url,'expectedZipBytes':round(size)})
        stamp=record.findtext('./g:dateStamp/c:DateTime',namespaces=NS)
        if stamp and (source_at is None or stamp>source_at): source_at=stamp
    if not rows or not source_at: raise ValueError('NOAA catalogue has no active coverage/date')
    return {'schema':1,'sourceUrl':CATALOGUE_URL,'sourceAt':source_at,'sourceSha256':hashlib.sha256(raw).hexdigest(),
        'agreementSha256':AGREEMENT_SHA,'cells':sorted(rows,key=lambda x:x['id']),'withdrawn':sorted(withdrawn)}

def shard_ids(bbox):
    result=set()
    for west,south,east,north in segments(bbox):
        for x in range(max(0,int((west+180)//10)),min(35,int((east+180-1e-9)//10))+1):
            for y in range(max(0,int((south+90)//10)),min(17,int((north+90-1e-9)//10))+1):
                result.add(f'x{x:02}y{y:02}')
    return sorted(result)

def json_bytes(value): return (json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()

def generate(catalogue, objects, directory, checked_at):
    """Only validated conversion receipts become installable objects."""
    directory=Path(directory)
    directory.mkdir(parents=True,exist_ok=False)
    identity=hashlib.sha256(json_bytes({'catalogue':catalogue['sourceSha256'],'objects':objects,'checkedAt':checked_at})).hexdigest()[:24]
    shards={}
    for row in catalogue['cells']:
        cell=dict(row); cell.pop('expectedZipBytes')
        record=objects.get(row['id'])
        if record and (record['edition'],record['update'])==(row['edition'],row['update']):
            cell.update({'zip':record['zip'],'chart':record['chart']})
        else: cell.update({'zip':None,'chart':None})
        for shard in shard_ids(cell['bbox']): shards.setdefault(shard,[]).append(cell)
    entries=[]
    for shard,cells in sorted(shards.items()):
        body=json_bytes({'schema':1,'generation':identity,'cells':cells})
        if len(body)>2*1024**2 or len(cells)>4096: raise ValueError('Regional catalogue exceeds phone cap')
        target=directory/'shards'/(shard+'.json'); target.parent.mkdir(exist_ok=True); target.write_bytes(body)
        x,y=int(shard[1:3]),int(shard[4:6])
        entries.append({'id':shard,'key':f'generations/{identity}/shards/{shard}.json','bytes':len(body),
            'sha256':hashlib.sha256(body).hexdigest(),'bbox':[x*10-180,y*10-90,x*10-170,y*10-80]})
    index={key:catalogue[key] for key in ('schema','sourceAt','sourceSha256','sourceUrl','agreementSha256','withdrawn')}
    index.update({'generation':identity,'checkedAt':checked_at,'shards':entries,'activeCells':len(catalogue['cells']),
        'attribution':'Contains NOAA ENC data. Thalassa display is not a certified ECDIS or a substitute for required charts.',
        'agreementUrl':AGREEMENT_URL})
    body=json_bytes(index)
    if len(body)>256*1024: raise ValueError('Root catalogue exceeds phone cap')
    (directory/'index.json').write_bytes(body)
    return index
