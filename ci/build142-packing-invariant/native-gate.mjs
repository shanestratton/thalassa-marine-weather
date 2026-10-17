import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const NATIVE=Object.freeze({
  "repo": "shanestratton/thalassa-marine-weather",
  "source": "0a8d33d166004682627e3988285eef6e928f076b",
  "run": 39053300179,
  "definition": "6d4c75336649b769efe0112a6ceddf5ad46f22fe",
  "path": ".github/workflows/unsigned-native-142-packing-invariant.yml",
  "branch": "codex/build-142-packing-invariant-unsigned-native",
  "job": 117456093733,
  "jobName": "unsigned"
});
export const requiredNativeSteps=Object.freeze([
  "Prove exact native source and toolchain",
  "Install pinned dependencies without Apple credentials",
  "Build production web and sync Capacitor",
  "Compile unsigned iOS Simulator",
  "Compile unsigned actual Watch target",
  "Preserve bounded text and public digest evidence only"
]);
export function assertNativePinned(){if(![NATIVE.source,NATIVE.definition].every(s=>/^[a-f0-9]{40}$/.test(s))||![NATIVE.run,NATIVE.job].every(n=>Number.isSafeInteger(n)&&n>0)||NATIVE.branch!=='codex/build-142-packing-invariant-unsigned-native'||NATIVE.path!=='.github/workflows/unsigned-native-142-packing-invariant.yml')throw Error('Unsigned native pins are incomplete');}
export function validateNativeEvidence(run,listing){assertNativePinned();if(run.id!==NATIVE.run||run.head_sha!==NATIVE.definition||run.path!==NATIVE.path||run.head_branch!==NATIVE.branch||run.event!=='push'||run.run_attempt!==1||run.actor?.login!=='shanestratton'||run.head_repository?.full_name!==NATIVE.repo)throw Error('Unexpected unsigned native run identity');if(!Array.isArray(listing.jobs)||listing.total_count!==listing.jobs.length||listing.jobs.length>1)throw Error('Incomplete or duplicate native job evidence');for(const job of listing.jobs){if(job.id!==NATIVE.job||job.name!==NATIVE.jobName||job.run_id!==NATIVE.run||job.head_sha!==NATIVE.definition||job.head_branch!==NATIVE.branch)throw Error('Unexpected unsigned native job identity');if(job.status==='completed'&&job.conclusion!=='success')throw Error('Unsigned native job did not pass');}if(run.status!=='completed'){if(!['queued','in_progress','pending','waiting','requested'].includes(run.status))throw Error('Unexpected unsigned native status');return 'pending';}if(run.conclusion!=='success'||listing.jobs.length!==1)throw Error('Unsigned native compile is not proven successful');const job=listing.jobs[0];if(job.status!=='completed'||job.conclusion!=='success')throw Error('Unsigned native job is not complete');for(const name of requiredNativeSteps){const steps=(job.steps??[]).filter(s=>s.name===name);if(steps.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')throw Error('Unsigned native required step did not pass: '+name);}return 'passed';}
export async function inspectNative(fetcher,token){assertNativePinned();const get=async endpoint=>{const response=await fetcher('https://api.github.com/repos/'+NATIVE.repo+'/'+endpoint,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});if(!response.ok)throw Error('Unsigned native evidence read failed: HTTP '+response.status);return response.json();};const [run,listing]=await Promise.all([get('actions/runs/'+NATIVE.run),get('actions/runs/'+NATIVE.run+'/jobs?filter=latest&per_page=100')]);return validateNativeEvidence(run,listing);}
async function main(){const token=process.env.GH_TOKEN;delete process.env.GH_TOKEN;if(!token)throw Error('GitHub read token is missing');const wait=process.argv.includes('--wait'),deadline=Date.now()+(wait?155*60000:0);for(;;){const state=await inspectNative(fetch,token);if(state==='passed'){const text='Exact unsigned native142 source/run/sole job and all required steps passed for '+NATIVE.source;console.log(text);if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,text+'\n');return;}if(!wait||Date.now()>=deadline)throw Error('Unsigned native compile is pending; signing/upload is blocked');console.log('Waiting for the exact unsigned native142 compile; no signing/upload started.');await new Promise(done=>setTimeout(done,30000));}}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(e=>{console.error(e.message);process.exitCode=1;});
