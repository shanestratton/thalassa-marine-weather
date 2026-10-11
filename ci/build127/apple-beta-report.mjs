import {createPrivateKey} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP, assertDestination, makeGetter} from './apple-status.mjs';

// Separate GET-only observation. This is NOT a duplicate/upload preflight and
// cannot authorize a retry. It never modifies existing apple-status semantics.
const GROUP_NAME = 'Skipper';
const GROUP_LIMIT = 50;
const opaqueId = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,200}$/.test(value);
const nullableString = value => value == null ? null : typeof value === 'string' ? value : undefined;
function booleanOrNull(value) {
    if (value == null) return null;
    if (typeof value !== 'boolean') throw new Error('Unexpected Apple boolean metadata');
    return value;
}
function stringOrNull(value) {
    const result = nullableString(value);
    if (result === undefined) throw new Error('Unexpected Apple string metadata');
    return result;
}
function assertResource(resource, type) {
    if (!resource || resource.type !== type || !opaqueId(resource.id)) throw new Error('Unexpected Apple resource identity');
}
function assertUnpaginated(container) {
    if (container?.links?.next != null) throw new Error('Included Apple relationships are incomplete; availability remains unverified');
}
function includedMap(response, allowedTypes) {
    if (!Array.isArray(response.included)) throw new Error('Missing included Apple relationship resources');
    const map = new Map();
    for (const resource of response.included) {
        if (!allowedTypes.includes(resource?.type)) throw new Error('Unexpected included Apple resource type');
        assertResource(resource, resource.type);
        const key = `${resource.type}/${resource.id}`;
        if (map.has(key)) throw new Error('Duplicate included Apple resource identity');
        map.set(key, resource);
    }
    return map;
}
function listLinks(relationship, type) {
    if (!relationship || !Array.isArray(relationship.data)) throw new Error('Missing Apple relationship linkage');
    assertUnpaginated(relationship);
    if (relationship.data.length >= GROUP_LIMIT) throw new Error('Apple group relationship may be truncated at its limit');
    if (relationship.meta?.paging?.total != null && relationship.meta.paging.total !== relationship.data.length) {
        throw new Error('Apple group relationship total does not match its linkage');
    }
    const ids = new Set();
    for (const link of relationship.data) {
        assertResource(link, type);
        if (ids.has(link.id)) throw new Error('Duplicate Apple relationship linkage');
        ids.add(link.id);
    }
    return ids;
}
function groupFacts(resource) {
    assertResource(resource, 'betaGroups');
    const attrs = resource.attributes;
    if (!attrs || typeof attrs.name !== 'string' || !attrs.name || attrs.name.length > 200 ||
        typeof attrs.isInternalGroup !== 'boolean') throw new Error('Incomplete Apple beta group facts');
    return {id:resource.id, name:attrs.name, isInternalGroup:attrs.isInternalGroup,
        hasAccessToAllBuilds:booleanOrNull(attrs.hasAccessToAllBuilds)};
}
export function appGroupsUrl() {
    const url = new URL('/v1/apps', APP.origin);
    url.search = new URLSearchParams({
        'filter[bundleId]':APP.bundle, 'fields[apps]':'bundleId,betaGroups',
        include:'betaGroups', 'fields[betaGroups]':'name,isInternalGroup,hasAccessToAllBuilds',
        'limit[betaGroups]':String(GROUP_LIMIT), limit:'2',
    }).toString();
    assertDestination(url);
    return url;
}
export function canonicalBuildBetaUrl() {
    const url = new URL('/v1/builds', APP.origin);
    url.search = new URLSearchParams({
        'filter[app]':APP.id, 'filter[preReleaseVersion.version]':APP.version,
        'filter[preReleaseVersion.platform]':'IOS', 'filter[version]':APP.build,
        'fields[builds]':'version,uploadedDate,processingState,expired,betaGroups,buildBetaDetail',
        include:'betaGroups,buildBetaDetail',
        'fields[betaGroups]':'name,isInternalGroup,hasAccessToAllBuilds',
        'fields[buildBetaDetails]':'internalBuildState,externalBuildState', limit:'2',
    }).toString();
    assertDestination(url, APP.id);
    return url;
}
export function evaluateAvailability({processingState, expired, assigned, hasAllBuildsAccess, group, betaDetail}) {
    if (!group) return 'SKIPPER_GROUP_UNVERIFIED';
    if (processingState !== 'VALID' || expired !== false) return 'BUILD_NOT_CONFIRMED_READY_AND_UNEXPIRED';
    if (assigned !== true) return hasAllBuildsAccess === true
        ? 'ALL_BUILDS_ACCESS_FLAG_PRESENT_EXPLICIT_ASSIGNMENT_UNVERIFIED' : 'NOT_ASSIGNED_TO_SKIPPER';
    const state = group.isInternalGroup ? betaDetail?.internalBuildState : betaDetail?.externalBuildState;
    if (state === 'IN_BETA_TESTING') return 'AVAILABLE_TO_CONFIGURED_SKIPPER_GROUP';
    if (state === 'READY_FOR_BETA_TESTING') return 'READY_NOT_CONFIRMED_DISTRIBUTED';
    return 'BETA_DISTRIBUTION_NOT_CONFIRMED';
}
export async function inspectBeta(get) {
    const apps = await get(appGroupsUrl());
    if (!Array.isArray(apps.data) || apps.data.length !== 1) throw new Error('Apple app identity is not unique');
    assertUnpaginated(apps);
    const app = apps.data[0];
    assertResource(app, 'apps');
    if (app.id !== APP.id || app.attributes?.bundleId !== APP.bundle) throw new Error('Unexpected Apple app or bundle');
    const appIds = listLinks(app.relationships?.betaGroups, 'betaGroups');
    const appIncluded = includedMap(apps, ['betaGroups']);
    if (appIncluded.size !== appIds.size) throw new Error('App group includes do not match linked app groups');
    const appGroups = new Map();
    for (const id of appIds) {
        const resource = appIncluded.get(`betaGroups/${id}`);
        if (!resource) throw new Error('A linked app beta group was not included');
        appGroups.set(id, groupFacts(resource));
    }
    const skippers = [...appGroups.values()].filter(group => group.name === GROUP_NAME);
    const skipper = skippers.length === 1 ? skippers[0] : null;
    const result = await get(canonicalBuildBetaUrl(), APP.id);
    if (!Array.isArray(result.data)) throw new Error('Unexpected canonical build response');
    assertUnpaginated(result);
    if (result.data.length > 1) throw new Error('Canonical build 127 is ambiguous');
    const common = {
        appId:APP.id, bundleId:APP.bundle, version:APP.version, requestedBuild:APP.build, platform:'IOS',
        inspectedAppGroupCount:appGroups.size, matchingSkipperGroupCount:skippers.length,
        skipperGroup:skipper,
        operation:'GET only; no signing, upload, app writes, tester writes or tester emails requested',
        testerDownload:'Not observed; configured-group availability is not a confirmed device download',
        uploadDecision:'This beta report is not a duplicate preflight or permission to upload/re-upload',
    };
    if (result.data.length === 0) return {...common, canonicalBuildObserved:false, availability:'CANONICAL_127_NOT_LISTED'};
    const build = result.data[0];
    assertResource(build, 'builds');
    if (build.attributes?.version !== APP.build) throw new Error('Apple returned a non-canonical build number');
    const groupIds = listLinks(build.relationships?.betaGroups, 'betaGroups');
    const resources = includedMap(result, ['betaGroups','buildBetaDetails']);
    for (const id of groupIds) {
        const actual = resources.get(`betaGroups/${id}`);
        const owner = appGroups.get(id);
        if (!actual || !owner) throw new Error('A build beta group is missing or not owned by the verified app');
        const facts = groupFacts(actual);
        if (facts.name !== owner.name || facts.isInternalGroup !== owner.isInternalGroup ||
            facts.hasAccessToAllBuilds !== owner.hasAccessToAllBuilds) throw new Error('App and build beta group facts disagree');
    }
    const detailRelationship = build.relationships?.buildBetaDetail;
    if (!detailRelationship || !Object.hasOwn(detailRelationship, 'data')) throw new Error('Missing build beta detail relationship');
    assertUnpaginated(detailRelationship);
    let betaDetail = null;
    if (detailRelationship.data != null) {
        assertResource(detailRelationship.data, 'buildBetaDetails');
        const detail = resources.get(`buildBetaDetails/${detailRelationship.data.id}`);
        if (!detail) throw new Error('Linked build beta detail was not included');
        betaDetail = {id:detail.id,
            internalBuildState:stringOrNull(detail.attributes?.internalBuildState),
            externalBuildState:stringOrNull(detail.attributes?.externalBuildState)};
    }
    const expectedIncluded = groupIds.size + (betaDetail ? 1 : 0);
    if (resources.size !== expectedIncluded) throw new Error('Build includes do not match linked beta resources');
    const processingState = stringOrNull(build.attributes.processingState);
    const expired = booleanOrNull(build.attributes.expired);
    const assigned = skipper ? groupIds.has(skipper.id) : null;
    const hasAllBuildsAccess = skipper?.hasAccessToAllBuilds ?? null;
    return {...common, canonicalBuildObserved:true,
        build:{id:build.id, build:APP.build, uploadedDate:stringOrNull(build.attributes.uploadedDate), processingState, expired},
        linkedBuildGroupCount:groupIds.size, skipperExplicitlyAssigned:assigned,
        skipperHasAllBuildsAccess:hasAllBuildsAccess, betaDetail,
        availability:evaluateAvailability({processingState, expired, assigned, hasAllBuildsAccess, group:skipper, betaDetail})};
}
async function main() {
    const keyId=process.env.ASC_KEY_ID, issuerId=process.env.ASC_ISSUER_ID, pem=process.env.ASC_KEY_P8;
    delete process.env.ASC_KEY_ID; delete process.env.ASC_ISSUER_ID; delete process.env.ASC_KEY_P8;
    if (!keyId || !issuerId || !pem) throw new Error('Existing Apple API credentials are missing');
    let key;
    try { key=createPrivateKey(pem); } catch { throw new Error('Unable to parse the existing Apple API key'); }
    const observation=await inspectBeta(makeGetter(fetch,key,keyId,issuerId));
    const summary={observedAt:new Date().toISOString(), workflowCommit:process.env.GITHUB_SHA ?? null, ...observation};
    const text=JSON.stringify(summary,null,2);
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        '\n# Canonical build 127 beta distribution — GET only\n\n```json\n'+text+'\n```\n');
}
if (process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1]))
    main().catch(error=>{console.error(error.message);process.exitCode=1;});
