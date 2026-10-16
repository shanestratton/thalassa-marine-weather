#!/usr/bin/env python3
"""Weekly policy runner. Default prints a local-only plan.

--run stages <=256 new/changed active cells; --publish additionally applies the
reviewed bounded publication policy. Install/enable only after source, resource,
R2 destination/CORS and initial immutable generation have been reviewed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import catalogue
import stage
import publish

def run(root,image,cli_sha,agreement,execute=False,publish_live=False):
    root=Path(root).resolve()
    result={'run':False,'publication':False,'catalogueUrl':catalogue.CATALOGUE_URL,'maxCells':stage.MAX_CELLS_CYCLE,
        'maxRawBytes':stage.MAX_RAW_CYCLE,'maxConvertedBytes':stage.MAX_OUTPUT_CYCLE,'minFreeDiskBytes':16*1024**3,
        'remoteByteCap':publish.MAX_REMOTE,'originalSourcesRetained':True,'retentionDeletes':[]}
    if not execute: return result
    with stage.locked(root):
        raw=stage.fetch(catalogue.CATALOGUE_URL,catalogue.MAX_XML); parsed=catalogue.parse_catalogue(raw)
        target=root/'catalogues'/(hashlib.sha256(raw).hexdigest()+'.xml')
        stage.immutable(root,str(target.relative_to(root)),raw)
        current=json.loads((root/'objects.json').read_text()) if (root/'objects.json').exists() else {}
        changed=[row['id'] for row in parsed['cells'] if row['id'] not in current or
            (current[row['id']]['edition'],current[row['id']]['update'],current[row['id']].get('converterSha256'))!=(row['edition'],row['update'],cli_sha)]
        # A changed publication still runs when no cell revision changed: its
        # checkedAt proves the weekly official catalogue check actually occurred.
        selected=changed[:stage.MAX_CELLS_CYCLE] or [parsed['cells'][0]['id']]
        staged=stage.prepare(root,target,selected,True,False,image,cli_sha)
        result.update({'run':True,'staged':staged,'remainingUnconvertedOrChanged':max(0,len(changed)-len(selected))})
        if publish_live:
            store=publish.R2(); plan=publish.prepare(store,root,staged['directory'],agreement)
            result['published']=publish.apply(store,plan,root,staged['directory'],agreement); result['publication']=True
        return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--root',required=True); p.add_argument('--image',required=True)
    p.add_argument('--converter-sha256',required=True); p.add_argument('--agreement',required=True); p.add_argument('--run',action='store_true'); p.add_argument('--publish',action='store_true')
    a=p.parse_args()
    if a.publish and not a.run: p.error('--publish requires --run')
    print(json.dumps(run(a.root,a.image,a.converter_sha256,a.agreement,a.run,a.publish),indent=2))
