import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  APP,
  assertUnused,
  assertDestination,
  makeGetter,
  listBuilds,
} from "./apple-status.mjs";
const existing = [
  { build: "134", processingState: "VALID" },
  { build: "133", processingState: "VALID" },
  { build: "132", processingState: "VALID" },
  { build: "131", processingState: "VALID" },
];
test("132, 133 and shipped 134 history permits 142", () =>
  assert.equal(assertUnused(existing), true));
for (const b of ["142", "142.0", "142.0.0", "142", "1000"])
  test(`block existing ${b}`, () =>
    assert.throws(() => assertUnused([...existing, { build: b }])));
for (const value of [[], null, [{ build: 142 }], [{ build: "unknown" }]])
  test(`block incomplete/malformed ${JSON.stringify(value)}`, () =>
    assert.throws(() => assertUnused(value)));
function buildUrl() {
  const u = new URL("/v1/builds", APP.origin);
  u.search = new URLSearchParams({
    "filter[app]": APP.id,
    "filter[preReleaseVersion.version]": APP.version,
    "filter[preReleaseVersion.platform]": "IOS",
  });
  return u;
}
test("expected build read permitted", () =>
  assert.doesNotThrow(() => assertDestination(buildUrl(), APP.id)));
test("reject exfiltration destination", () => {
  const u = buildUrl();
  u.hostname = "example.com";
  assert.throws(() => assertDestination(u, APP.id));
});
test("reject Apple write endpoint", () =>
  assert.throws(() =>
    assertDestination(new URL("/v1/betaTesters", APP.origin), APP.id),
  ));
for (const field of [
  "filter[app]",
  "filter[preReleaseVersion.version]",
  "filter[preReleaseVersion.platform]",
])
  test(`reject altered ${field}`, () => {
    const u = buildUrl();
    u.searchParams.set(field, "different");
    assert.throws(() => assertDestination(u, APP.id));
  });
test("JWT limited to one exact GET, two minutes, no redirects", async () => {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  let calls = 0;
  const get = makeGetter(
    async (url, options) => {
      calls++;
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      const jwt = options.headers.Authorization.slice(7);
      const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
      assert.deepEqual(claims.scope, [`GET ${url.pathname}${url.search}`]);
      assert.equal(claims.exp - claims.iat, 120);
      return { ok: true, json: async () => ({ data: [] }) };
    },
    privateKey,
    "FAKE-ID",
    "FAKE-ISSUER",
  );
  await get(buildUrl(), APP.id);
  assert.equal(calls, 1);
});
const appResponse = {
  data: [{ id: APP.id, attributes: { bundleId: APP.bundle } }],
};
test("complete paginated listing", async () => {
  let calls = 0;
  const get = async (url) => {
    calls++;
    if (url.pathname === "/v1/apps") return appResponse;
    if (!url.searchParams.has("cursor"))
      return {
        data: [{ attributes: { version: "131" } }],
        links: { next: buildUrl().href + "&cursor=next" },
      };
    return {
      data: [{ attributes: { version: "130" } }],
      links: { next: null },
    };
  };
  assert.deepEqual(
    (await listBuilds(get)).map((b) => b.build),
    ["131", "130"],
  );
  assert.equal(calls, 3);
});
test("reject changed app identity", async () =>
  assert.rejects(
    listBuilds(async () => ({
      data: [{ id: "different", attributes: { bundleId: APP.bundle } }],
    })),
  ));
test("reject malformed build response", async () =>
  assert.rejects(
    listBuilds(async (url) =>
      url.pathname === "/v1/apps"
        ? appResponse
        : { data: [{ attributes: {} }] },
    ),
  ));
test("reject off-origin pagination before request", async () => {
  let calls = 0;
  await assert.rejects(
    listBuilds(async (url) => {
      calls++;
      return url.pathname === "/v1/apps"
        ? appResponse
        : { data: [], links: { next: "https://example.com/v1/builds" } };
    }),
  );
  assert.equal(calls, 2);
});
test("reject infinite pagination", async () =>
  assert.rejects(
    listBuilds(async (url) =>
      url.pathname === "/v1/apps"
        ? appResponse
        : { data: [], links: { next: url.href } },
    ),
  ));
test("142 destination rejects user-info and fragments before signing", () => {
  for (const mutate of [
    (u) => (u.username = "fixture-user"),
    (u) => (u.password = "fixture-password"),
    (u) => (u.hash = "fragment"),
  ]) {
    const url = buildUrl();
    mutate(url);
    assert.throws(() => assertDestination(url, APP.id));
  }
});
test("existing equivalent leading-zero142 and any newer build block a second upload", () => {
  assert.equal(assertUnused([...existing, { build: "136" }]), true);
  for (const build of ["0142", "142.1", "142.0.0", "142"])
    assert.throws(() => assertUnused([...existing, { build }]));
});

test('already published141 is an allowed predecessor rather than a second142 upload',()=>assert.equal(assertUnused([{build:'141'}]),true));
