import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {APP,assertRead,firstUrl,inspectBeta,makeGetter} from './tester-status.mjs';
function fixture() {
    return {data:[{id:'fixture-build',attributes:{version:'133',processingState:'VALID',expired:false},relationships:{
        app:{data:{type:'apps',id:APP.id}},preReleaseVersion:{data:{type:'preReleaseVersions',id:'version'}},
        buildBetaDetail:{data:{type:'buildBetaDetails',id:'detail'}},betaGroups:{data:[{type:'betaGroups',id:'group'}]},
    }}],included:[{type:'apps',id:APP.id,attributes:{bundleId:APP.bundle}},
    {type:'preReleaseVersions',id:'version',attributes:{version:APP.version,platform:'IOS'}},
    {type:'buildBetaDetails',id:'detail',attributes:{internalBuildState:'IN_BETA_TESTING',externalBuildState:'READY_FOR_BETA_SUBMISSION'}},
    {type:'betaGroups',id:'group',attributes:{isInternalGroup:true,hasAccessToAllBuilds:true}}]};
}
test('read is confined to the exact Apple app/version and GET endpoint',()=>{
    assertRead(firstUrl());for(const u of ['https://evil.example/v1/builds','https://api.appstoreconnect.apple.com/v1/apps'])assert.throws(()=>assertRead(new URL(u)));
    const wrong=firstUrl();wrong.searchParams.set('filter[app]','other');assert.throws(()=>assertRead(wrong));
});
test('reports beta states and anonymized group counts without claiming phone installation',async()=>{
    const r=await inspectBeta(async()=>fixture());assert.equal(r.internalBuildState,'IN_BETA_TESTING');assert.equal(r.assignedInternalGroupCount,1);assert.equal(r.assignedExternalGroupCount,0);assert.equal(r.groupListingComplete,true);assert.match(r.deviceInstallation,/Not verified/);
});
test('missing, ambiguous, wrong-version and wrong-app results fail closed',async()=>{
    for(const mutate of [p=>p.data=[],p=>p.data.push(p.data[0]),p=>p.included[0].attributes.bundleId='other',p=>p.included[1].attributes.version='2.0']){
        const p=fixture();mutate(p);await assert.rejects(()=>inspectBeta(async()=>p));
    }
});
test('partial group relationships are recorded as partial, never complete',async()=>{
    const p=fixture();p.data[0].relationships.betaGroups.meta={paging:{total:2}};
    assert.equal((await inspectBeta(async()=>p)).groupListingComplete,false);
});
test('pagination cannot redirect credentials outside the fixed Apple scope',async()=>{
    const p=fixture();p.links={next:'https://evil.example/'};let calls=0;
    await assert.rejects(()=>inspectBeta(async()=>{calls++;return p;}));assert.equal(calls,1);
});
test('signed request scope is GET only and a failed response stops inspection',async()=>{
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const get=makeGetter(async(url,init)=>{
        assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
        const token=init.headers.Authorization.slice(7);const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
        assert.deepEqual(claims.scope,[`GET ${url.pathname}${url.search}`]);return Response.json(fixture());
    },privateKey,'fixture-key','fixture-issuer');await get(firstUrl());
    const bad=makeGetter(async()=>new Response('',{status:403}),privateKey,'fixture-key','fixture-issuer');
    await assert.rejects(()=>bad(firstUrl()),/HTTP 403/);
});
