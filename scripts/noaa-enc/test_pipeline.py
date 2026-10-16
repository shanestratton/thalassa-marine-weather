import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import catalogue as c
import stage
import publish

def record(cell='US5CA1LK',revision='1.10',coordinates='33 -119',url=None):
    area='' if coordinates is None else '<g:extent><g:EX_Extent><g:geographicElement><g:EX_BoundingPolygon><g:polygon><m:Polygon><m:exterior><m:LinearRing>'+''.join('<m:pos>'+p+'</m:pos>' for p in [coordinates,'33 -118','34 -118',coordinates])+'</m:LinearRing></m:exterior></m:Polygon></g:polygon></g:EX_BoundingPolygon></g:geographicElement></g:EX_Extent></g:extent>'
    return f'''<g:MD_Metadata><g:dateStamp><c:DateTime>2026-10-16T04:59:07Z</c:DateTime></g:dateStamp><g:identificationInfo><g:MD_DataIdentification><g:citation><g:CI_Citation><g:title><c:CharacterString>{cell}</c:CharacterString></g:title><g:alternateTitle><c:CharacterString>Public test cell</c:CharacterString></g:alternateTitle><g:edition><c:CharacterString>{revision}</c:CharacterString></g:edition>
    <g:date><g:CI_Date><g:date><c:Date>2026-02-13</c:Date></g:date><g:dateType><g:CI_DateTypeCode codeListValue="revision"/></g:dateType></g:CI_Date></g:date><g:date><g:CI_Date><g:date><c:Date>2026-04-22</c:Date></g:date><g:dateType><g:CI_DateTypeCode codeListValue="publication"/></g:dateType></g:CI_Date></g:date></g:CI_Citation></g:citation><g:spatialResolution><g:MD_Resolution><g:equivalentScale><g:MD_RepresentativeFraction><g:denominator><c:Integer>12000</c:Integer></g:denominator></g:MD_RepresentativeFraction></g:equivalentScale></g:MD_Resolution></g:spatialResolution>{area}</g:MD_DataIdentification></g:identificationInfo><g:distributionInfo><g:MD_Distribution><g:transferOptions><g:MD_DigitalTransferOptions><g:transferSize><c:Real>0.01</c:Real></g:transferSize><g:onLine><g:CI_OnlineResource><g:linkage><g:URL>{url or 'https://www.charts.noaa.gov/ENCs/'+cell+'.zip'}</g:URL></g:linkage></g:CI_OnlineResource></g:onLine></g:MD_DigitalTransferOptions></g:transferOptions></g:MD_Distribution></g:distributionInfo></g:MD_Metadata>'''

def xml(*records): return ('<g:DS_Series xmlns:g="'+c.NS['g']+'" xmlns:c="'+c.NS['c']+'" xmlns:m="'+c.NS['m']+'">'+''.join(records)+'</g:DS_Series>').encode()
class Store:
    def __init__(self): self.data={}; self.puts=[]; self.fail_key=None
    def listing(self): return [{'key':k,'bytes':len(v)} for k,v in self.data.items()]
    def get(self,key,cap):
        if key not in self.data: return None
        raw=self.data[key]
        if len(raw)>cap: raise ValueError('read cap')
        return raw,hashlib.sha256(raw).hexdigest()
    def put(self,key,body,previous=None,immutable=True):
        if key==self.fail_key: raise ValueError('simulated upload failure')
        old=self.get(key,32*1024**2)
        if previous is None and old or previous is not None and (not old or old[1]!=previous): raise ValueError('CAS conflict')
        self.puts.append(key); self.data[key]=body

class Pipeline(unittest.TestCase):
    def test_real_catalogue_shape_revisions_and_withdrawals(self):
        parsed=c.parse_catalogue(xml(record(),record('US5CA16M','46.1',None)))
        self.assertEqual(parsed['cells'][0]['update'],10)  # Not float1.1.
        self.assertEqual(parsed['withdrawn'],['US5CA16M'])
        self.assertEqual(parsed['cells'][0]['issued'],'2026-04-22')
        self.assertEqual(parsed['cells'][0]['baseIssued'],'2026-02-13')
    def test_unsafe_xml_source_identity_and_effective_zero_edition_fail(self):
        for raw in [b'<!DOCTYPE x>'+xml(record()),xml(record(url='https://outside.invalid/x')),xml(record(revision='0.1')),xml(record(),record())]:
            with self.assertRaises(ValueError): c.parse_catalogue(raw)
    def test_circular_extent_and_regional_selection(self):
        self.assertIn('x00y09',c.shard_ids([175,1,-175,9])); self.assertIn('x35y09',c.shard_ids([175,1,-175,9]))
        self.assertNotIn('x18y09',c.shard_ids([175,1,-175,9]))
        self.assertEqual(c.shard_ids([-120,30,-110,40]),['x06y12'])
        source=xml(record(coordinates='33 -220'))
        parsed=c.parse_catalogue(source)
        self.assertTrue(all(-180<=v<=180 for v in parsed['cells'][0]['bbox'][::2]))
    def test_bounded_zip_blocks_traversal_symlinks_and_missing_updates(self):
        for mode in ['traversal','symlink','gap']:
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory); archive=root/'source.zip'
                with zipfile.ZipFile(archive,'w') as z:
                    if mode=='traversal': z.writestr('../outside','x')
                    elif mode=='symlink':
                        info=zipfile.ZipInfo('link'); info.external_attr=0o120777<<16; z.writestr(info,'/etc/passwd')
                    else: z.writestr('US5CA1LK.000','base'); z.writestr('US5CA1LK.001','first'); z.writestr('US5CA1LK.003','missingupdate2')
                with self.assertRaises(ValueError): stage.unpack(archive,root/'sources','US5CA1LK')
                self.assertFalse((root.parent/'outside').exists())
    def staged(self,root):
        parsed=c.parse_catalogue(xml(record()))
        objects={'US5CA1LK':{'edition':1,'update':10,
            'zip':stage.immutable(root,'objects/'+hashlib.sha256(b'PKoriginal').hexdigest()+'.zip',b'PKoriginal'),
            'chart':stage.immutable(root,'objects/'+hashlib.sha256(b'{"chart":1}').hexdigest()+'.json',b'{"chart":1}')}}
        draft=root/'generations'/'draft'; index=c.generate(parsed,objects,draft,'2026-10-16T05:00:00Z')
        directory=draft.parent/index['generation']; draft.rename(directory)
        terms=root/'terms.txt'; terms.write_bytes(b'test government terms\n')
        return directory,terms,index
    def test_atomic_publication_verified_objects_before_index_and_keeps_original(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); terms=b'test government terms\n'
            with patch.object(c,'AGREEMENT_SHA',hashlib.sha256(terms).hexdigest()):
                generation,agreement,index=self.staged(root); store=Store()
                plan=publish.prepare(store,root,generation,agreement)
                result=publish.apply(store,plan,root,generation,agreement)
                self.assertEqual(store.puts[-1],publish.PREFIX+'index.json')
                self.assertTrue(any(key.endswith('.zip') for key in store.data))
                self.assertEqual(result['deletedObjects'],0)
                self.assertEqual(json.loads(store.data[publish.PREFIX+'index.json'])['generation'],index['generation'])
    def test_failed_upload_keeps_previous_root_and_cas_blocks_competing_writer(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with patch.object(c,'AGREEMENT_SHA',hashlib.sha256(b'test government terms\n').hexdigest()):
                generation,agreement,_=self.staged(root); store=Store(); rootkey=publish.PREFIX+'index.json'
                previous=b'{"generation":"old","sourceAt":"2026-01-01T00:00:00Z"}'; store.data[rootkey]=previous
                plan=publish.prepare(store,root,generation,agreement); store.fail_key=plan['uploads'][0]['key']
                with self.assertRaises(ValueError): publish.apply(store,plan,root,generation,agreement)
                self.assertEqual(store.data[rootkey],previous)
                store.fail_key=None; store.data[rootkey]=b'{"generation":"competing","sourceAt":"2026-01-01T00:00:00Z"}'
                with self.assertRaises(ValueError): publish.apply(store,plan,root,generation,agreement)
                self.assertNotIn(rootkey,store.puts)
    def test_unknown_prefix_changed_local_object_and_remote_budget_fail_before_publish(self):
        self.assertFalse(publish.owned('marine-catalogue/v1/noaa/index.json'))
        self.assertFalse(publish.owned('noaa-enc/v1/objects/../../secret'))
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with patch.object(c,'AGREEMENT_SHA',hashlib.sha256(b'test government terms\n').hexdigest()):
                generation,agreement,_=self.staged(root); store=Store()
                with patch.object(publish,'MAX_REMOTE',1):
                    with self.assertRaises(ValueError): publish.prepare(store,root,generation,agreement)
                plan=publish.prepare(store,root,generation,agreement)
                Path(next(row['file'] for row in plan['uploads'] if row['key'].endswith('.zip'))).write_bytes(b'changed')
                with self.assertRaises(ValueError): publish.apply(store,plan,root,generation,agreement)
                self.assertEqual(store.puts,[])

    def test_older_catalogue_needs_explicit_reviewed_rollback_and_local_growth_is_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with patch.object(c,'AGREEMENT_SHA',hashlib.sha256(b'test government terms\n').hexdigest()):
                generation,agreement,_=self.staged(root); store=Store()
                store.data[publish.PREFIX+'index.json']=b'{"generation":"newer","sourceAt":"2026-10-17T00:00:00Z"}'
                with self.assertRaises(ValueError): publish.prepare(store,root,generation,agreement)
                plan=publish.prepare(store,root,generation,agreement,rollback=True)
                self.assertTrue(plan['rollback'])
                publish.apply(store,plan,root,generation,agreement)
            with patch.object(stage,'MAX_LOCAL',1):
                with self.assertRaises(ValueError): stage.ensure_capacity(root,1)

if __name__=='__main__': unittest.main()
