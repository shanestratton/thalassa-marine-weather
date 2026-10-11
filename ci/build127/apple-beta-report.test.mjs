import test from 'node:test';
import assert from 'node:assert/strict';
import {APP, assertDestination, assertUnused} from './apple-status.mjs';
import {appGroupsUrl, canonicalBuildBetaUrl, evaluateAvailability, inspectBeta} from './apple-beta-report.mjs';

const group = (id, name, internal=true) => ({type:'betaGroups', id,
    attributes:{name,isInternalGroup:internal,hasAccessToAllBuilds:false}});
const link = resource => ({type:resource.type,id:resource.id});
function evidence() {
    const skipper=group('skipper-group','Skipper');
    const other=group('other-group','Other');
    const detail={type:'buildBetaDetails',id:'beta-detail',
        attributes:{internalBuildState:'IN_BETA_TESTING',externalBuildState:'READY_FOR_BETA_TESTING'}};
    return {
        apps:{data:[{type:'apps',id:APP.id,attributes:{bundleId:APP.bundle},relationships:{betaGroups:{data:[link(skipper),link(other)]}}}],included:[skipper,other]},
        builds:{data:[{type:'builds',id:'canonical-build',attributes:{version:'127',uploadedDate:'2026-10-12T00:00:00Z',processingState:'VALID',expired:false},
            relationships:{betaGroups:{data:[link(skipper)]},buildBetaDetail:{data:link(detail)}}}],included:[structuredClone(skipper),detail]},
    };
}
async function inspect(e) {
    let calls=0;
    const report=await inspectBeta(async(url,appId)=>{
        calls++;assertDestination(url,appId);
        return structuredClone(url.pathname==='/v1/apps'?e.apps:e.builds);
    });
    assert.equal(calls,2);
    return report;
}
test('URLs retain exact existing app, version and iOS GET destinations; request no tester names or emails',()=>{
    const app=appGroupsUrl(), build=canonicalBuildBetaUrl();
    assert.equal(app.pathname,'/v1/apps');assert.equal(app.searchParams.get('filter[bundleId]'),APP.bundle);
    assert.equal(build.pathname,'/v1/builds');assert.equal(build.searchParams.get('filter[app]'),APP.id);
    assert.equal(build.searchParams.get('filter[preReleaseVersion.version]'),APP.version);
    assert.equal(build.searchParams.get('filter[preReleaseVersion.platform]'),'IOS');
    assert.equal(build.searchParams.get('filter[version]'),'127');
    assert.equal(build.searchParams.get('include'),'betaGroups,buildBetaDetail');
    assert.ok(!app.href.includes('betaTesters'));assert.ok(!build.href.includes('individualTesters'));
    assert.ok(!app.href.includes('email'));assert.ok(!build.href.includes('email'));
});
test('current, explicitly linked internal Skipper with IN_BETA_TESTING is configured available, not download-confirmed',async()=>{
    const report=await inspect(evidence());
    assert.equal(report.availability,'AVAILABLE_TO_CONFIGURED_SKIPPER_GROUP');
    assert.equal(report.skipperExplicitlyAssigned,true);assert.equal(report.matchingSkipperGroupCount,1);
    assert.equal(report.build.id,'canonical-build');assert.equal(report.build.build,'127');
    assert.match(report.testerDownload,/Not observed/);assert.match(report.uploadDecision,/not.*preflight/);
    assert.equal(report.betaDetail.internalBuildState,'IN_BETA_TESTING');
});
test('external Skipper uses external state, never the internal state',async()=>{
    const e=evidence();e.apps.included[0].attributes.isInternalGroup=false;e.builds.included[0].attributes.isInternalGroup=false;
    assert.equal((await inspect(e)).availability,'READY_NOT_CONFIRMED_DISTRIBUTED');
    e.builds.included[1].attributes.externalBuildState='IN_BETA_TESTING';
    assert.equal((await inspect(e)).availability,'AVAILABLE_TO_CONFIGURED_SKIPPER_GROUP');
});
test('READY_FOR_BETA_TESTING is not represented as already distributed',async()=>{
    const e=evidence();e.builds.included[1].attributes.internalBuildState='READY_FOR_BETA_TESTING';
    assert.equal((await inspect(e)).availability,'READY_NOT_CONFIRMED_DISTRIBUTED');
});
for (const state of ['PROCESSING','MISSING_EXPORT_COMPLIANCE','EXPIRED','NEW_UNKNOWN_STATE',null]) test(`no confirmed distribution for beta state ${state}`,async()=>{
    const e=evidence();e.builds.included[1].attributes.internalBuildState=state;
    assert.equal((await inspect(e)).availability,'BETA_DISTRIBUTION_NOT_CONFIRMED');
});
for (const state of ['PROCESSING','FAILED','INVALID','NEW_UNKNOWN_STATE',null]) test(`processing ${state} is not ready`,async()=>{
    const e=evidence();e.builds.data[0].attributes.processingState=state;
    assert.equal((await inspect(e)).availability,'BUILD_NOT_CONFIRMED_READY_AND_UNEXPIRED');
});
for (const expired of [true,null,undefined]) test(`expiry ${expired} does not imply current availability`,async()=>{
    const e=evidence();e.builds.data[0].attributes.expired=expired;
    assert.equal((await inspect(e)).availability,'BUILD_NOT_CONFIRMED_READY_AND_UNEXPIRED');
});
test('canonical build absent is a status observation, not upload permission',async()=>{
    const e=evidence();e.builds={data:[]};const report=await inspect(e);
    assert.equal(report.canonicalBuildObserved,false);assert.equal(report.availability,'CANONICAL_127_NOT_LISTED');
    assert.match(report.uploadDecision,/not.*permission/);
});
test('no unique app-owned Skipper keeps group assignment unverified',async()=>{
    const e=evidence();e.apps.included[0].attributes.name='Different';e.builds.included[0].attributes.name='Different';
    const report=await inspect(e);assert.equal(report.matchingSkipperGroupCount,0);assert.equal(report.skipperExplicitlyAssigned,null);
    assert.equal(report.availability,'SKIPPER_GROUP_UNVERIFIED');
});
test('two same-named app groups never select an arbitrary Skipper',async()=>{
    const e=evidence();e.apps.included[1].attributes.name='Skipper';
    const report=await inspect(e);assert.equal(report.matchingSkipperGroupCount,2);
    assert.equal(report.skipperGroup,null);assert.equal(report.availability,'SKIPPER_GROUP_UNVERIFIED');
});
test('missing explicit membership is not covered by an automatic-access assumption',async()=>{
    const e=evidence();e.builds.data[0].relationships.betaGroups.data=[];e.builds.included.shift();
    assert.equal((await inspect(e)).availability,'NOT_ASSIGNED_TO_SKIPPER');
    e.apps.included[0].attributes.hasAccessToAllBuilds=true;
    const report=await inspect(e);assert.equal(report.skipperExplicitlyAssigned,false);
    assert.equal(report.availability,'ALL_BUILDS_ACCESS_FLAG_PRESENT_EXPLICIT_ASSIGNMENT_UNVERIFIED');
});
test('null beta details remain unconfirmed, never invented',async()=>{
    const e=evidence();e.builds.data[0].relationships.buildBetaDetail.data=null;e.builds.included.pop();
    const report=await inspect(e);assert.equal(report.betaDetail,null);assert.equal(report.availability,'BETA_DISTRIBUTION_NOT_CONFIRMED');
});
const refusals = {
    'wrong app':e=>{e.apps.data[0].id='different-app';},
    'wrong bundle':e=>{e.apps.data[0].attributes.bundleId='different.bundle';},
    'ambiguous app':e=>{e.apps.data.push(structuredClone(e.apps.data[0]));},
    'ambiguous canonical build':e=>{e.builds.data.push(structuredClone(e.builds.data[0]));},
    'equivalent but noncanonical number':e=>{e.builds.data[0].attributes.version='127.0';},
    'wrong build type':e=>{e.builds.data[0].type='apps';},
    'wrong linkage type':e=>{e.builds.data[0].relationships.betaGroups.data[0].type='betaTesters';},
    'foreign group not in app':e=>{const foreign=group('foreign-group','Skipper');e.builds.data[0].relationships.betaGroups.data=[link(foreign)];e.builds.included[0]=foreign;},
    'missing included app group':e=>{e.apps.included.pop();},
    'missing included build group':e=>{e.builds.included.shift();},
    'missing included beta detail':e=>{e.builds.included.pop();},
    'missing app linkage':e=>{delete e.apps.data[0].relationships.betaGroups;},
    'missing build linkage':e=>{delete e.builds.data[0].relationships.betaGroups;},
    'missing beta detail linkage':e=>{delete e.builds.data[0].relationships.buildBetaDetail;},
    'duplicate included resource':e=>{e.builds.included.push(structuredClone(e.builds.included[0]));},
    'duplicate relationship linkage':e=>{e.builds.data[0].relationships.betaGroups.data.push(structuredClone(e.builds.data[0].relationships.betaGroups.data[0]));},
    'unrequested tester resource':e=>{e.builds.included.push({type:'betaTesters',id:'tester',attributes:{email:'never-print@example.invalid'}});},
    'unlinked included detail':e=>{e.builds.included.push({type:'buildBetaDetails',id:'unlinked-detail',attributes:{internalBuildState:'IN_BETA_TESTING'}});},
    'disagreeing group name':e=>{e.builds.included[0].attributes.name='Changed';},
    'disagreeing group kind':e=>{e.builds.included[0].attributes.isInternalGroup=false;},
    'disagreeing automatic-access flag':e=>{e.builds.included[0].attributes.hasAccessToAllBuilds=true;},
    'nonboolean group kind':e=>{e.apps.included[0].attributes.isInternalGroup='true';},
    'nonboolean expiry':e=>{e.builds.data[0].attributes.expired='false';},
    'nonstring beta state':e=>{e.builds.included[1].attributes.internalBuildState=42;},
    'opaque ID contamination':e=>{e.builds.data[0].id='not/an/opaque/id';},
    'app next page':e=>{e.apps.links={next:'https://api.appstoreconnect.apple.com/v1/apps?cursor=more'};},
    'build next page':e=>{e.builds.links={next:'https://api.appstoreconnect.apple.com/v1/builds?cursor=more'};},
    'app-group relationship next page':e=>{e.apps.data[0].relationships.betaGroups.links={next:'more'};},
    'build-group relationship next page':e=>{e.builds.data[0].relationships.betaGroups.links={next:'more'};},
    'mismatched group total':e=>{e.apps.data[0].relationships.betaGroups.meta={paging:{total:3}};},
    'missing included array':e=>{delete e.builds.included;},
};
for (const [name,mutate] of Object.entries(refusals)) test(`refuse ${name} without an availability conclusion`,async()=>{
    const e=evidence();mutate(e);await assert.rejects(inspect(e));
});
test('a max-sized group include cannot hide a second Skipper',async()=>{
    const e=evidence();const groups=Array.from({length:50},(_,i)=>group(`group-${i}`,i===0?'Skipper':`Other ${i}`));
    e.apps.included=groups;e.apps.data[0].relationships.betaGroups.data=groups.map(link);
    await assert.rejects(inspect(e),/truncated/);
});
test('existing duplicate preflight remains independent and blocks every existing 127 state and variant',()=>{
    for (const build of ['127','127.0','127.0.0','0127','128']) for (const processingState of ['PROCESSING','VALID','INVALID','FAILED']) {
        assert.throws(()=>assertUnused([{build:'126'},{build,processingState,expired:true}]));
    }
    assert.equal(assertUnused([{build:'126'}]),true);
});
test('pure availability evaluation cannot infer readiness from group assignment alone',()=>{
    assert.equal(evaluateAvailability({processingState:'VALID',expired:false,assigned:true,
        group:{isInternalGroup:true},betaDetail:null}), 'BETA_DISTRIBUTION_NOT_CONFIRMED');
});
