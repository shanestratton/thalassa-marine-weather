"""FD012/kernel attestation before exec of the separate pure-TS JS consumer.

Node24's trusted built-in TS compiler may use its own WASM. No GRIB decoder,
downloaded/user WASM, npm package or credential is supplied to this process.
"""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import resource
import socket
import sys

def require(ok, why):
    if not ok: raise ValueError(why)

p = argparse.ArgumentParser()
for name in ('node', 'bootstrap', 'source', 'manifest', 'fixture', 'output'):
    p.add_argument('--'+name, type=Path, required=True)
a = p.parse_args()
require(sys.platform == 'linux' and not {'numpy', 'eccodes', 'native', 'catalogue'}.intersection(sys.modules), 'JS pre-exec boundary')
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
require(all(int(x)>0 for x in status['Uid'].split()) and status['NoNewPrivs'].strip()=='1', 'nonroot/NNP')
for key in ('CapEff','CapPrm','CapInh','CapBnd','CapAmb'): require(int(status[key],16)==0, 'zero capability set')
require(resource.getrlimit(resource.RLIMIT_AS)==(17179869184,17179869184), 'explicit JS16GiB virtual-AS limit')
row = [line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::')]
require(len(row)==1 and row[0].startswith('/') and '..' not in row[0].split('/'), 'own cgroup2')
cgroup = Path('/sys/fs/cgroup',row[0].lstrip('/'))
require(cgroup.resolve().is_relative_to('/sys/fs/cgroup'), 'own cgroup path')
limits = {k:(cgroup/k).read_text().strip() for k in ('memory.max','memory.swap.max','pids.max','cpu.max')}
require(limits['memory.max']=='2147483648' and limits['memory.swap.max']=='0' and limits['pids.max']=='16', 'JS physical caps')
cpu=limits['cpu.max'].split();require(len(cpu)==2 and cpu[0]!='max' and int(cpu[0])==int(cpu[1])>0,'1CPU')
fds=[]
for fd in Path('/proc/self/fd').iterdir():
    try: target=os.readlink(fd)
    except FileNotFoundError: continue
    require(int(fd.name) in (0,1,2),'inherited extra FD before Node exec')
    fds.append({'fd':int(fd.name),'target':target})
for family in (socket.AF_INET,socket.AF_INET6):
    try: probe=socket.socket(family,socket.SOCK_STREAM)
    except OSError as error: require(error.errno in (errno.EPERM,errno.EAFNOSUPPORT,errno.EACCES),'AF refusal')
    else: probe.close();raise ValueError('internet AF not denied')
for path in (a.node,a.bootstrap,a.manifest):
    s=path.stat();require(path.is_file() and not path.is_symlink() and s.st_uid==0 and s.st_mode&0o222==0,'rootreadonly JS input')
require(a.manifest.stat().st_size<=32768 and a.node.stat().st_size<=256*1024**2,'JS runtime/manifest caps')
manifest=json.loads(a.manifest.read_bytes())
with a.node.open('rb') as stream: node_sha=hashlib.file_digest(stream,'sha256').hexdigest()
require(node_sha==manifest['nodeSha256'],'actual Node binary identity')
proof={'schema':1,'jsOnlyNoGribDecoder':True,'trustedNodeBuiltinTsCompilerWasmAllowed':True,
       'ownCgroup':row[0],'limits':limits,'rlimitAS':[17179869184]*2,'uid':os.getuid(),
       'noNewPrivileges':True,'capabilities':'all-zero','inheritedFDsBeforeNodeExec':fds,
       'internetAddressFamiliesDeniedBeforeEntry':True,'nodeSha256':node_sha,'providerRequests':0}
with a.output.open('x') as stream: stream.write(json.dumps(proof,sort_keys=True)+'\n')
env={'PATH':'/usr/bin:/bin','HOME':'/tmp','LANG':'C.UTF-8','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1',
     'MKL_NUM_THREADS':'1','NUMEXPR_NUM_THREADS':'1','AROME_RH_NATIVE_FIXTURE_DIR':str(a.fixture)}
os.execve(a.node,[str(a.node),'--disallow-code-generation-from-strings','--max-old-space-size=128',
    str(a.bootstrap),str(a.source),str(a.manifest),str(a.fixture),str(a.output)],env)
