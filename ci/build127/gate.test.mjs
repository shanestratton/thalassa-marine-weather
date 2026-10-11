import test from 'node:test';
import assert from 'node:assert/strict';
import {TARGET, requiredSteps, validateEvidence, inspect} from './gate.mjs';
function evidence() {
    return {
        run: {id:TARGET.validationRun, head_sha:TARGET.validationDefinition, path:TARGET.validationPath, event:'push', run_attempt:1, actor:{login:'shanestratton'}, head_repository:{full_name:TARGET.repo}, status:'completed', conclusion:'success'},
        listing: {total_count:10,jobs:Object.entries(requiredSteps).map(([name,steps])=>({name,status:'completed',conclusion:'success',steps:steps.map(name=>({name,status:'completed',conclusion:'success'}))}))},
        refs: {candidate:TARGET.source,b127:TARGET.originalB127,master:TARGET.master},
    };
}
const check = e => validateEvidence(e.run,e.listing,e.refs);
test('ten genuine successful jobs and required steps pass',()=>assert.equal(check(evidence()),'passed'));
for (const name of Object.keys(requiredSteps)) test(`reject failed job ${name}`,()=>{
    const e=evidence();e.listing.jobs.find(j=>j.name===name).conclusion='failure';assert.throws(()=>check(e));
});
for (const outcome of ['skipped','cancelled','neutral',null]) test(`reject ${outcome} result`,()=>{
    const e=evidence();e.listing.jobs[0].conclusion=outcome;assert.throws(()=>check(e));
});
test('reject skipped test step even if job reports success',()=>{const e=evidence();e.listing.jobs[0].steps[1].conclusion='skipped';assert.throws(()=>check(e));});
test('reject missing suite',()=>{const e=evidence();e.listing.jobs.pop();e.listing.total_count=9;assert.throws(()=>check(e));});
test('reject truncated evidence',()=>{const e=evidence();e.listing.jobs.pop();assert.throws(()=>check(e));});
test('reject duplicate jobs',()=>{const e=evidence();e.listing.jobs[9]=e.listing.jobs[0];assert.throws(()=>check(e));});
for (const ref of ['candidate','b127','master']) test(`reject moved ${ref}`,()=>{const e=evidence();e.refs[ref]='changed';assert.throws(()=>check(e));});
for (const property of ['id','head_sha','path','event','run_attempt']) test(`reject changed run ${property}`,()=>{const e=evidence();e.run[property]='changed';assert.throws(()=>check(e));});
test('reject different actor',()=>{const e=evidence();e.run.actor.login='someone-else';assert.throws(()=>check(e));});
test('reject fork',()=>{const e=evidence();e.run.head_repository.full_name='someone/fork';assert.throws(()=>check(e));});
test('pending is not success',()=>{const e=evidence();e.run.status='in_progress';e.run.conclusion=null;assert.equal(check(e),'pending');});
test('failure stops waiting immediately',()=>{const e=evidence();e.run.status='in_progress';e.listing.jobs[0].conclusion='failure';assert.throws(()=>check(e));});
test('reject GitHub API error, without leaking the token',async()=>{
    await assert.rejects(inspect(async()=>({ok:false,status:403}),'PRIVATE-TEST-TOKEN'), /HTTP 403/);
});
test('all reads use exact repository, GET and no redirects',async()=>{
    const e=evidence();let calls=0;
    const fetcher=async(url,options)=>{calls++;assert.ok(url.startsWith(`https://api.github.com/repos/${TARGET.repo}/`));assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
        return {ok:true,json:async()=>url.includes('/jobs?')?e.listing:url.includes('/actions/runs/')?e.run:{object:{sha:url.endsWith('/b127')?e.refs.b127:url.endsWith('/master')?e.refs.master:e.refs.candidate}}};};
    assert.equal(await inspect(fetcher,'TEST-TOKEN'),'passed');assert.equal(calls,5);
});
