import {createPrivateKey, sign} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const APP = Object.freeze({origin:'https://api.appstoreconnect.apple.com',id:'6809058745',bundle:'com.thalassa.weather',version:'1.2.0',build:'133'});
export function assertRead(url) {
    if(url.origin!==APP.origin || url.pathname!=='/v1/builds' || url.username || url.password || url.hash ||
        url.searchParams.get('filter[app]')!==APP.id ||
        url.searchParams.get('filter[preReleaseVersion.version]')!==APP.version ||
        url.searchParams.get('filter[preReleaseVersion.platform]')!=='IOS') throw new Error('Unexpected Apple read destination');
}
export function makeGetter(fetcher,key,keyId,issuer) {
    return async url=>{
        assertRead(url);
        const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
        const now=Math.floor(Date.now()/1000);
        const input=encode({alg:'ES256',kid:keyId,typ:'JWT'})+'.'+encode({iss:issuer,iat:now,exp:now+120,aud:'appstoreconnect-v1',scope:[`GET ${url.pathname}${url.search}`]});
        const token=input+'.'+sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
        const response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
        if(!response.ok) throw new Error(`Apple beta metadata read failed: HTTP ${response.status}`);
        const advertised=Number(response.headers.get('content-length'));
        if(advertised>1_000_000) {await response.body?.cancel();throw new Error('Apple response too large');}
        if(!response.body) throw new Error('Missing Apple response body');
        const reader=response.body.getReader();let size=0;const chunks=[];
        try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1_000_000){await reader.cancel();throw new Error('Apple response too large');}chunks.push(value);}}
        finally {reader.releaseLock();}
        const json=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!Array.isArray(json.data)||!Array.isArray(json.included)) throw new Error('Incomplete Apple beta metadata');
        return json;
    };
}
export function firstUrl() {
    const url=new URL('/v1/builds',APP.origin);
    url.search=new URLSearchParams({
        'filter[app]':APP.id,'filter[preReleaseVersion.version]':APP.version,'filter[preReleaseVersion.platform]':'IOS',
        include:'app,preReleaseVersion,buildBetaDetail,betaGroups',
        'fields[builds]':'version,processingState,expired,buildBetaDetail,betaGroups,preReleaseVersion,app',
        'fields[apps]':'bundleId','fields[preReleaseVersions]':'version,platform',
        'fields[buildBetaDetails]':'internalBuildState,externalBuildState',
        'fields[betaGroups]':'isInternalGroup,hasAccessToAllBuilds','limit[betaGroups]':'50',limit:'200',
    }).toString();return url;
}
export async function inspectBeta(get) {
    const builds=[],included=new Map(),seen=new Set();let url=firstUrl();
    for(let n=0;url&&n<10;n++) {
        assertRead(url);if(seen.has(url.href))throw new Error('Repeated Apple page');seen.add(url.href);
        const page=await get(url);builds.push(...page.data);
        for(const row of page.included)included.set(`${row.type}:${row.id}`,row);
        url=page.links?.next?new URL(page.links.next,APP.origin):null;
    }
    if(url)throw new Error('Incomplete Apple build pagination');
    const matches=builds.filter(b=>b.attributes?.version===APP.build);
    if(matches.length!==1)throw new Error('Build 133 was not uniquely resolved');
    const b=matches[0],rel=b.relationships;
    const linked=name=>{const id=rel?.[name]?.data;return id?included.get(`${id.type}:${id.id}`):undefined;};
    const app=linked('app'),version=linked('preReleaseVersion'),detail=linked('buildBetaDetail');
    if(app?.id!==APP.id||app.attributes?.bundleId!==APP.bundle||version?.attributes?.version!==APP.version||
        version.attributes?.platform!=='IOS'||!detail?.attributes)throw new Error('Apple app/version/beta identity incomplete');
    const relation=rel?.betaGroups;
    if(!Array.isArray(relation?.data))throw new Error('Missing tester-group relationship');
    const groups=relation.data.map(g=>included.get(`${g.type}:${g.id}`));
    if(groups.some(g=>typeof g?.attributes?.isInternalGroup!=='boolean'))throw new Error('Incomplete tester-group details');
    const groupsComplete=!relation.links?.next&&(!Number.isFinite(relation.meta?.paging?.total)||relation.meta.paging.total===groups.length);
    const internal=groups.filter(g=>g.attributes.isInternalGroup).length;
    return {observedAt:new Date().toISOString(),appId:APP.id,bundleId:APP.bundle,version:APP.version,build:APP.build,
        processingState:b.attributes.processingState,expired:b.attributes.expired,
        internalBuildState:detail.attributes.internalBuildState??'not returned',externalBuildState:detail.attributes.externalBuildState??'not returned',
        assignedInternalGroupCount:internal,assignedExternalGroupCount:groups.length-internal,groupListingComplete:groupsComplete,
        operation:'GET only; no upload, assignment, invitations or Apple changes',deviceInstallation:'Not verified by API metadata'};
}
async function main() {
    const keyId=process.env.ASC_KEY_ID,issuer=process.env.ASC_ISSUER_ID,pem=process.env.ASC_KEY_P8;
    delete process.env.ASC_KEY_ID;delete process.env.ASC_ISSUER_ID;delete process.env.ASC_KEY_P8;
    if(!keyId||!issuer||!pem)throw new Error('Apple read credentials missing');
    const snapshot=await inspectBeta(makeGetter(fetch,createPrivateKey(pem),keyId,issuer));
    const text=JSON.stringify(snapshot,null,2);console.log(text);
    if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,'\n```json\n'+text+'\n```\n');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(e=>{console.error(e.message);process.exitCode=1;});
