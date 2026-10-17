import { createPrivateKey, sign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = Object.freeze({
  origin: "https://api.appstoreconnect.apple.com",
  id: "6809058745",
  bundle: "com.thalassa.weather",
  version: "1.2.0",
  build: "139",
});
export function assertUnused(builds) {
  if (!Array.isArray(builds) || builds.length === 0)
    throw new Error("No complete existing build history; upload blocked");
  for (const build of builds) {
    if (
      typeof build.build !== "string" ||
      !/^\d+(?:\.\d+){0,2}$/.test(build.build)
    )
      throw new Error(
        "Unexpected build-number format; inspect Apple before uploading",
      );
    if (BigInt(build.build.split(".")[0]) >= BigInt(APP.build))
      throw new Error(
        "Build 139, an equivalent number, or a newer build is already on Apple; never re-upload 139",
      );
  }
  return true;
}
export function assertDestination(url, appId) {
  if (
    url.origin !== APP.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !["/v1/apps", "/v1/builds"].includes(url.pathname)
  )
    throw new Error("Unexpected Apple API destination");
  if (url.pathname === "/v1/apps") {
    if (url.searchParams.get("filter[bundleId]") !== APP.bundle)
      throw new Error("Unexpected Apple app lookup");
  } else if (
    appId !== APP.id ||
    url.searchParams.get("filter[app]") !== APP.id ||
    url.searchParams.get("filter[preReleaseVersion.version]") !== APP.version ||
    url.searchParams.get("filter[preReleaseVersion.platform]") !== "IOS"
  )
    throw new Error("Unexpected Apple build query");
}
export function makeGetter(fetcher, key, keyId, issuerId) {
  return async (url, appId) => {
    assertDestination(url, appId);
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const content =
      encode({ alg: "ES256", kid: keyId, typ: "JWT" }) +
      "." +
      encode({
        iss: issuerId,
        iat: now,
        exp: now + 120,
        aud: "appstoreconnect-v1",
        scope: [`GET ${url.pathname}${url.search}`],
      });
    const token =
      content +
      "." +
      sign("sha256", Buffer.from(content), {
        key,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`Apple read failed: HTTP ${response.status}`);
    const json = await response.json();
    if (!Array.isArray(json.data)) throw new Error("Unexpected Apple response");
    return json;
  };
}
export async function listBuilds(get) {
  const appUrl = new URL("/v1/apps", APP.origin);
  appUrl.search = new URLSearchParams({
    "filter[bundleId]": APP.bundle,
    "fields[apps]": "bundleId",
    limit: "2",
  }).toString();
  const apps = await get(appUrl);
  if (
    apps.data.length !== 1 ||
    apps.data[0].id !== APP.id ||
    apps.data[0].attributes?.bundleId !== APP.bundle
  )
    throw new Error(
      "Thalassa was not uniquely resolved to the expected Apple app",
    );
  let url = new URL("/v1/builds", APP.origin);
  url.search = new URLSearchParams({
    "filter[app]": APP.id,
    "filter[preReleaseVersion.version]": APP.version,
    "filter[preReleaseVersion.platform]": "IOS",
    "fields[builds]": "version,uploadedDate,processingState,expired",
    sort: "-uploadedDate",
    limit: "200",
  }).toString();
  const builds = [],
    seen = new Set();
  for (let page = 0; url && page < 10; page++) {
    assertDestination(url, APP.id);
    if (seen.has(url.href))
      throw new Error("Repeated build page; complete listing not proven");
    seen.add(url.href);
    const result = await get(url, APP.id);
    for (const build of result.data) {
      if (typeof build.attributes?.version !== "string")
        throw new Error("Missing Apple build version");
      const { version, uploadedDate, processingState, expired } =
        build.attributes;
      builds.push({ build: version, uploadedDate, processingState, expired });
    }
    url = result.links?.next ? new URL(result.links.next, APP.origin) : null;
  }
  if (url) throw new Error("Incomplete build pagination; upload blocked");
  return builds;
}
function record(summary) {
  const text = JSON.stringify(summary, null, 2);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "\n```json\n" + text + "\n```\n",
    );
}
async function main() {
  const mode = process.argv[2];
  if (!["preflight", "after-upload"].includes(mode))
    throw new Error("Expected explicit read-only mode");
  const keyId = process.env.ASC_KEY_ID,
    issuerId = process.env.ASC_ISSUER_ID;
  const pem =
    process.env.ASC_KEY_P8 ||
    readFileSync(resolve(process.env.RUNNER_TEMP, "asc/AuthKey.p8"), "utf8");
  delete process.env.ASC_KEY_ID;
  delete process.env.ASC_ISSUER_ID;
  delete process.env.ASC_KEY_P8;
  if (!keyId || !issuerId || !pem)
    throw new Error("Apple API credentials are missing");
  const get = makeGetter(fetch, createPrivateKey(pem), keyId, issuerId);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const builds = await listBuilds(get);
    if (mode === "preflight") {
      assertUnused(builds);
      record({
        observedAt: new Date().toISOString(),
        appId: APP.id,
        bundleId: APP.bundle,
        version: APP.version,
        requestedBuild: APP.build,
        completeBuildCount: builds.length,
        build139Unused: true,
        operation: "GET only; no upload or Apple changes",
      });
      return;
    }
    const matches = builds.filter((b) => b.build === APP.build);
    if (matches.length > 1) throw new Error("Ambiguous build-139 result");
    const build = matches[0];
    if (build && ["INVALID", "FAILED"].includes(build.processingState)) {
      record({
        observedAt: new Date().toISOString(),
        appId: APP.id,
        ...build,
        upload:
          "Xcode upload step completed; Apple rejected processing. Do not re-upload.",
      });
      throw new Error(
        "Apple rejected build 139 during processing; inspect without retrying the upload",
      );
    }
    if (build?.processingState === "VALID" || Date.now() >= deadline) {
      record({
        observedAt: new Date().toISOString(),
        appId: APP.id,
        bundleId: APP.bundle,
        version: APP.version,
        build: APP.build,
        apple: build ?? "Not yet listed",
        upload: "Xcode upload step completed once",
        processing:
          build?.processingState === "VALID"
            ? "Apple processing succeeded"
            : "Apple processing/visibility not yet confirmed",
        testerAvailability:
          "Not verified by this read-only check; do not equate processing with tester assignment",
      });
      return;
    }
    console.log(
      "Build 139 upload was acknowledged by Xcode; waiting for Apple processing (GET only).",
    );
    await new Promise((done) => setTimeout(done, 30_000));
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
