"""Original-reference parity and measured native resource proof; no network."""
import hashlib,json,os,subprocess,sys,shutil
from pathlib import Path
root=Path(sys.argv[1]).resolve();root.mkdir(exist_ok=False)
group=next(line.split(':',2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
cg=Path('/sys/fs/cgroup')/group.lstrip('/')
assert cg.resolve().is_relative_to(Path('/sys/fs/cgroup').resolve())
limits={n:(cg/n).read_text().strip() for n in ['memory.max','memory.swap.max','pids.max','cpu.max']}
assert limits['memory.max']=='2147483648' and limits['memory.swap.max']=='0' and limits['pids.max']=='16'
quota,period=map(int,limits['cpu.max'].split());assert quota*2==period
(root/'actual-cgroup-limits.json').write_text(json.dumps({'path':group,'limits':limits},indent=2)+'\n')
baseline=Path(sys.argv[2]).resolve();candidate=Path(sys.argv[3]).resolve()
# Osmium selects a command from argv[0] when its basename is osmium-COMMAND.
# Keep exact reviewed executable bytes, using the canonical name in two dirs.
for name,binary in [('baseline',baseline),('candidate',candidate)]:
 directory=root/name;directory.mkdir()
 shutil.copy2(binary,directory/'osmium')
baseline=root/'baseline'/'osmium';candidate=root/'candidate'/'osmium'
env={k:os.environ[k] for k in ['PATH','LANG','LC_ALL'] if k in os.environ}
env['OSMIUM_POOL_THREADS']='2'
for q in ['INPUT','OSMDATA','OUTPUT','WORK']:env['OSMIUM_MAX_'+q+'_QUEUE_SIZE']='2'
def run(args):
 p=subprocess.run([str(x) for x in args],capture_output=True,timeout=90,env=env)
 with (root/'commands.jsonl').open('a') as log:log.write(json.dumps({'argv':[str(x) for x in args],'exit':p.returncode,'stderr':p.stderr.decode(errors='replace')[-4000:]})+'\n')
 if p.returncode:print(p.stderr.decode(errors='replace')[-4000:],flush=True)
 assert p.returncode==0,p.stderr.decode(errors='replace')[-4000:]
 return p.stdout
# Sparse nodes span current real-world ID magnitudes and each side of 4 KiB
# boundaries. Reference closure includes an untagged way and nested relation.
ids=sorted(set([1,32767,32768,32769,67108863,67108864,67108865]+[500_000_000*i+1 for i in range(1,29)]))
nodes=''.join(f'<node id="{n}" version="1" lat="{-20+(i%10)*.001}" lon="{150+(i%9)*.001}"><tag k="leisure" v="marina"/></node>' for i,n in enumerate(ids))
ways='<way id="1234567890" version="1">'+''.join(f'<nd ref="{n}"/>' for n in ids[:4]+ids[:1])+'<tag k="leisure" v="marina"/></way>'
ways+='<way id="1234567891" version="1">'+''.join(f'<nd ref="{n}"/>' for n in ids[-4:]+ids[-4:-3])+'</way>'
relations='<relation id="23456789" version="1"><member type="way" ref="1234567891" role="outer"/><tag k="type" v="multipolygon"/></relation><relation id="23456790" version="1"><member type="relation" ref="23456789" role=""/><tag k="leisure" v="marina"/></relation>'
xml=root/'sparse-high-ids.osm';xml.write_text('<?xml version="1.0"?><osm version="0.6">'+nodes+ways+relations+'</osm>')
source=root/'original.osm.pbf';run([baseline,'cat',xml,'-o',source])
results={}
for name,binary in [('baseline',baseline),('candidate',candidate)]:
 output=root/(name+'.osm.pbf');rss=root/(name+'-rss-kib.txt')
 run(['/usr/bin/time','-f','%M','-o',rss,binary,'tags-filter',source,'nwr/leisure=marina','-o',output])
 opl=run([binary,'cat',output,'-f','opl']);(root/(name+'.opl')).write_bytes(opl)
 geo=root/(name+'.geojsonseq');run([binary,'export',output,'--attributes=type,id','-f','geojsonseq','-o',geo])
 data=[json.loads(line.lstrip(b'\x1e')) for line in geo.read_bytes().splitlines() if line]
 canonical=json.dumps(data,sort_keys=True,separators=(',',':')).encode()
 (root/(name+'-canonical.json')).write_bytes(canonical)
 results[name]={'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'peakRssKiB':int(rss.read_text()),'oplSha256':hashlib.sha256(opl).hexdigest(),'exportSha256':hashlib.sha256(canonical).hexdigest(),'features':len(data)}
assert results['candidate']['oplSha256']==results['baseline']['oplSha256']
assert results['candidate']['exportSha256']==results['baseline']['exportSha256']
assert results['candidate']['peakRssKiB']<128*1024
assert results['candidate']['peakRssKiB']<results['baseline']['peakRssKiB']/2
opl=(root/'candidate.opl').read_text()
assert all(('n'+str(n)+' ') in opl for n in ids)
assert 'w1234567891 ' in opl and 'r23456789 ' in opl and 'r23456790 ' in opl
peak=int((cg/'memory.peak').read_text());assert peak<=2147483648
results.update(originalNodeIds=ids,originalNodeCount=len(ids),referenceClosure=True,canonicalExportParity=True,sourceAndSemanticsUnchanged=True,network=False,actualCgroup={'path':group,'limits':limits,'peakBytes':peak})
(root/'proof.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results))
