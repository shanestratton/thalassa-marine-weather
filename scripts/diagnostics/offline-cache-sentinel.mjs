/** Diagnostic only. Bundles the actual frozen fixture/service; no source changes or WAN.
 * node offline-cache-sentinel.mjs --source=/checkout --engine=webkit --output=/tmp/report.json
 * Optional --mode=none|origin|retained restricts the keeper comparison.
 * A completed diagnostic reports missing entries; it does not certify the release gate.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const option = (name, fallback) =>
  process.argv
    .find((x) => x.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const source = resolve(option("source", process.cwd()));
const output = resolve(option("output", "offline-cache-sentinel-report.json"));
const require = createRequire(resolve(source, "package.json"));
const { build } = require("esbuild");
const playwright = require("playwright");
const engineName = option("engine", "webkit");
if (!["webkit", "chromium"].includes(engineName))
  throw Error("Engine must be webkit or chromium");
const worker = await readFile(resolve(source, "public/sw.js"), "utf8");
const plan = await readFile(
  resolve(source, "services/offlineReliefPlan.ts"),
  "utf8",
);
const cacheName = /RELIEF_WEB_CACHE\s*=\s*'([^']+)'/.exec(plan)?.[1];
const manifestPath =
  /RELIEF_WEB_MANIFEST_PATH\s*=\s*'([^']+)'/.exec(plan)?.[1] ?? null;
const legacy = "https://tiles.thalassatiles.com/__offline-relief-manifest-v1";
const core = /const CACHE_NAME = '([^']+)'/.exec(worker)?.[1];
if (!cacheName || !core)
  throw Error("Actual source cache constants not recognized");
const entry = resolve(source, "e2e/fixtures/offline-relief.ts");
const coldGate = `
    const diagnosticIndex=await cache.match(new URL(${JSON.stringify(manifestPath ?? legacy)},location.href).href);
    window.__sentinelPreHydrate={keys:keys.map(r=>r.url),manifestText:diagnosticIndex?await diagnosticIndex.text():null};
    if(window.__pauseReliefHydration)await new Promise(resolve=>{window.__continueReliefHydration=resolve;});
`;
const compiled = await build({
  entryPoints: [entry],
  absWorkingDir: source,
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "import.meta.env": "{}" },
  plugins: [
    {
      name: "isolated-offline-diagnostic",
      setup(b) {
        b.onLoad(
          { filter: /[\\/]e2e[\\/]fixtures[\\/]offline-relief\.ts$/ },
          async () => {
            const text = await readFile(entry, "utf8");
            if (!text.includes("await hydrateRelief();"))
              throw Error("Fixture hydration seam missing");
            return {
              contents: text.replace(
                "await hydrateRelief();",
                coldGate + "\n await hydrateRelief();",
              ),
              loader: "ts",
            };
          },
        );
        b.onLoad({ filter: /[\\/]services[\\/]networkPolicy\.ts$/ }, () => ({
          contents: "export const satelliteModeBlocks=()=>false;",
          loader: "ts",
        }));
        b.onLoad({ filter: /[\\/]stores[\\/]uiStore\.ts$/ }, () => ({
          contents:
            "export const useUIStore={getState:()=>({isOffline:false})};",
          loader: "ts",
        }));
      },
    },
  ],
});
const script = compiled.outputFiles[0].text;
const html =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#map{margin:0;width:100%;height:100%;background:#333b45}</style></head><body><div id="map"></div><script src="/assets/offline-relief-fixture-134.js"></script></body></html>';
const fault = `let offlineFault=false;const attempts=[];const networkFetch=self.fetch.bind(self);self.fetch=(...a)=>{const url=typeof a[0]==='string'?a[0]:a[0].url;if(offlineFault||new URL(url,self.location.href).origin!==self.location.origin){attempts.push(url);return Promise.reject(new TypeError('Synthetic offline/WAN-denied network'));}return networkFetch(...a);};self.addEventListener('message',e=>{if(e.data==='offline-fault')offlineFault=true;e.ports[0]?.postMessage({blocked:offlineFault,attempts});});\n`;
const report = {
  diagnosticOnly: true,
  engine: engineName,
  source,
  cacheName,
  manifestPath,
  startedAt: new Date().toISOString(),
  sourceSha: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceHashes: Object.fromEntries(
    await Promise.all(
      [
        "services/OfflineReliefService.ts",
        "services/offlineReliefPlan.ts",
        "e2e/fixtures/offline-relief.ts",
        "public/sw.js",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(source, file)))
          .digest("hex"),
      ]),
    ),
  ),
  cases: [],
};
const launch =
  engineName === "chromium" && process.env.CHROME_EXECUTABLE
    ? {
        executablePath: process.env.CHROME_EXECUTABLE,
        args: ["--use-angle=swiftshader"],
      }
    : {};
const browser = await playwright[engineName].launch(launch);
async function snapshot(page, origin) {
  return await page.evaluate(
    async ({ cacheName, manifestPath, legacy, origin }) => {
      const cache = await caches.open(cacheName),
        keys = (await cache.keys()).map((r) => r.url),
        manifestKey = manifestPath ? origin + manifestPath : legacy;
      const hit = await cache.match(manifestKey);
      const text = hit ? await hit.text() : null;
      const sentinels = [];
      for (const key of keys.filter((k) => k.includes("__sentinel_"))) {
        const response = await cache.match(key);
        sentinels.push({
          key,
          headers: response ? Object.fromEntries(response.headers) : null,
          text: response ? await response.text() : null,
        });
      }
      return {
        keys,
        manifestKey,
        manifestText: text,
        manifestHeaders: hit ? Object.fromEntries(hit.headers) : null,
        sentinels,
        operations: window.__cacheOperations ?? [],
      };
    },
    { cacheName, manifestPath, legacy, origin },
  );
}
try {
  for (const mode of option("mode", null)
    ? [option("mode", null)]
    : ["none", "origin", "retained"]) {
    if (!["none", "origin", "retained"].includes(mode))
      throw Error("Unknown keeper mode");
    const result = { mode };
    report.cases.push(result);
    let context, server;
    try {
      server = createServer((req, res) => {
        if (req.url === "/sw.js") {
          res.writeHead(200, {
            "content-type": "application/javascript",
            "service-worker-allowed": "/",
          });
          res.end(fault + worker);
        } else if (req.url === "/assets/offline-relief-fixture-134.js") {
          res.writeHead(200, { "content-type": "application/javascript" });
          res.end(script);
        } else if (req.url === "/keeper.html") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            "<!doctype html><title>Same-origin cache keeper, no app</title>",
          );
        } else {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(html);
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.2", resolve));
      const origin = `http://127.0.0.2:${server.address().port}`;
      result.origin = origin;
      context = await browser.newContext(
        engineName === "webkit"
          ? playwright.devices["iPhone 13"]
          : { viewport: { width: 390, height: 844 } },
      );
      await context.addInitScript(() => {
        const events = [];
        window.__cacheOperations = events;
        const metadata = new WeakMap(),
          handles = new WeakMap();
        let nextHandle = 0;
        const NativeResponse = window.Response;
        window.Response = new Proxy(NativeResponse, {
          construct(target, args, newTarget) {
            const response = Reflect.construct(target, args, newTarget);
            metadata.set(response, {
              inputType:
                typeof args[0] === "string"
                  ? "string"
                  : Object.prototype.toString.call(args[0]),
              bodyText: typeof args[0] === "string" ? args[0] : null,
            });
            return response;
          },
        });
        const originalOpen = CacheStorage.prototype.open,
          originalStorageDelete = CacheStorage.prototype.delete;
        const originalPut = Cache.prototype.put,
          originalDelete = Cache.prototype.delete;
        const append = (event) => {
          events.push({ ...event, at: performance.now() });
          if (events.length > 512) events.shift();
        };
        CacheStorage.prototype.open = async function (name) {
          const cache = await originalOpen.call(this, name);
          if (!handles.has(cache))
            handles.set(cache, { name, id: ++nextHandle });
          return cache;
        };
        CacheStorage.prototype.delete = async function (name) {
          const result = await originalStorageDelete.call(this, name);
          append({ operation: "storage-delete", name, answer: result });
          return result;
        };
        Cache.prototype.put = async function (key, response) {
          const url = typeof key === "string" ? key : key.url;
          const detail = url?.includes("manifest")
            ? metadata.get(response)
            : null;
          const headers = url?.includes("manifest")
            ? Object.fromEntries(response.headers)
            : null;
          try {
            const answer = await originalPut.call(this, key, response);
            let insidePut;
            if (url?.includes("manifest")) {
              const keys = (await this.keys()).map((r) => r.url);
              const hit = await this.match(key);
              insidePut = {
                keys,
                matched: Boolean(hit),
                text: hit ? await hit.text() : null,
              };
            }
            append({
              operation: "put",
              url,
              ok: true,
              handle: handles.get(this),
              detail,
              headers,
              insidePut,
            });
            return answer;
          } catch (error) {
            append({ operation: "put", url, ok: false, error: String(error) });
            throw error;
          }
        };
        Cache.prototype.delete = async function (key, options) {
          const url = typeof key === "string" ? key : key.url;
          const answer = await originalDelete.call(this, key, options);
          append({ operation: "delete", url, answer });
          return answer;
        };
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      const warm = await context.newPage();
      await warm.goto(origin + "/e2e/fixtures/offline-relief.html");
      const images = await warm.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        const c = canvas.getContext("2d");
        c.fillStyle = "rgb(150,0,0)";
        c.fillRect(0, 0, 256, 256);
        const png = canvas.toDataURL("image/png");
        c.fillStyle = "rgb(128,0,0)";
        c.fillRect(0, 0, 256, 256);
        return { png, webp: canvas.toDataURL("image/webp", 1) };
      });
      if (!images.webp.startsWith("data:image/webp;"))
        throw Error("Engine cannot generate required synthetic WebP");
      await context.route("https://tiles.thalassatiles.com/**", (route) => {
        const dem = route.request().url().includes("/dem/");
        return route.fulfill({
          contentType: dem ? "image/webp" : "image/png",
          headers: { "access-control-allow-origin": "*" },
          body: Buffer.from(
            (dem ? images.webp : images.png).split(",")[1],
            "base64",
          ),
        });
      });
      await warm.reload();
      result.save = await warm.evaluate(
        async () => await window.__offlineRelief.save(),
      );
      result.afterSave = await snapshot(warm, origin);
      await warm.evaluate(async () => {
        await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
          await new Promise((resolve) =>
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              resolve,
              { once: true },
            ),
          );
      });
      result.afterActivation = await snapshot(warm, origin);
      const sentinels = await warm.evaluate(
        async ({ cacheName, origin, manifestPath, legacy }) => {
          const cache = await caches.open(cacheName),
            manifest = await cache.match(
              manifestPath ? origin + manifestPath : legacy,
            );
          const payload = manifest
            ? await manifest.text()
            : (window.__cacheOperations.findLast(
                (op) =>
                  op.operation === "put" &&
                  op.url.includes("manifest") &&
                  op.detail?.bodyText,
              )?.detail.bodyText ??
              JSON.stringify({
                schema: 1,
                tiles: [],
                diagnostic: "manifest already absent",
              }));
          const bytes = new TextEncoder().encode(payload),
            expected = [];
          for (const crossOrigin of [false, true])
            for (const binary of [false, true])
              for (const length of [false, true])
                for (const writes of [1, 36]) {
                  const key = `${crossOrigin ? "https://tiles.thalassatiles.com" : origin}/__sentinel_${binary ? "bytes" : "string"}_${length ? "length" : "no-length"}_${writes}`;
                  const headers = {
                    "content-type": "application/json",
                    ...(length
                      ? { "content-length": String(bytes.length) }
                      : {}),
                  };
                  for (let i = 0; i < writes; i++)
                    await cache.put(
                      key,
                      new Response(binary ? bytes.slice().buffer : payload, {
                        headers,
                      }),
                    );
                  expected.push({
                    key,
                    binary,
                    length,
                    writes,
                    expectedText: payload,
                  });
                }
          return expected;
        },
        { cacheName, origin, manifestPath, legacy },
      );
      result.expectedSentinels = sentinels;
      result.directSameKey = await warm.evaluate(
        async ({ cacheName, manifestPath, legacy, origin, payload }) => {
          const cache = await caches.open(cacheName),
            key = manifestPath ? origin + manifestPath : legacy;
          await cache.put(
            key,
            new Response(payload, {
              headers: { "content-type": "application/json" },
            }),
          );
          const hit = await cache.match(key);
          return {
            key,
            keys: (await cache.keys()).map((r) => r.url),
            text: hit ? await hit.text() : null,
          };
        },
        {
          cacheName,
          manifestPath,
          legacy,
          origin,
          payload: sentinels[0].expectedText,
        },
      );
      result.urlMatrix = await warm.evaluate(
        async ({ cacheName, origin, payload }) => {
          const cache = await caches.open(cacheName),
            results = [];
          const paths = [
            "/__thalassa-offline-relief-manifest-v1",
            "/__offline-relief-manifest-v1",
            "/__thalassa-offline-relief-index-v1",
            "/__thalassa-offline-relief-manifest-v1.json",
            "/__thalassa/offline-relief/v1/index.json",
            "/__manifest",
            "/manifest.json",
            "/offline.json",
            "/__sentinel_manifest",
            "/__sentinel-manifest",
            "/__sentinel_manifest_v1",
            "/__sentinel_manifest-v1",
            "/__sentinel_string_no-length_1",
            "/__thalassa-offline-relief-manifest-v2",
            "/__thalassa-offline-relief-manifest-v1?v=1",
            "/offline-relief/index.json",
            "/offline-relief-index.json",
            "/relief-index",
            "/relief-index?v=1",
          ];
          for (const host of [origin, "https://tiles.thalassatiles.com"])
            for (const path of paths)
              for (const requestObject of [false, true]) {
                const key = host + path,
                  url = new URL(key),
                  request = new Request(key);
                await cache.put(
                  requestObject ? request : key,
                  new Response(payload, {
                    headers: { "content-type": "application/json" },
                  }),
                );
                const hit = await cache.match(key),
                  ignored = await cache.match(key, { ignoreVary: true }),
                  requestHit = await cache.match(new Request(key));
                const text = hit ? await hit.text() : null,
                  allKeys = (await cache.keys()).map((r) => r.url);
                results.push({
                  key,
                  requestObject,
                  components: {
                    origin: url.origin,
                    pathname: url.pathname,
                    search: url.search,
                    hash: url.hash,
                  },
                  codepoints: Array.from(key, (c) => c.codePointAt(0)),
                  nativeRequestURL: request.url,
                  method: request.method,
                  mode: request.mode,
                  matched: Boolean(hit),
                  exactBody: text === payload,
                  ignoreVary: Boolean(ignored),
                  requestMatched: Boolean(requestHit),
                  actualKeys: allKeys,
                });
              }
          return results;
        },
        { cacheName, origin, payload: sentinels[0].expectedText },
      );
      await warm.evaluate(
        async ({ core, html, script }) => {
          const c = await caches.open(core);
          await c.put(
            "/e2e/fixtures/offline-relief.html",
            new Response(html, { headers: { "content-type": "text/html" } }),
          );
          await c.put(
            "/assets/offline-relief-fixture-134.js",
            new Response(script, {
              headers: { "content-type": "application/javascript" },
            }),
          );
          await caches.delete("thalassa-v199-runtime-tiles");
        },
        { core, html, script },
      );
      let keeper;
      if (mode !== "none") {
        keeper = await context.newPage();
        await keeper.goto(origin + "/keeper.html");
        if (mode === "retained")
          await keeper.evaluate(async (name) => {
            window.__retainedReliefCache = await caches.open(name);
          }, cacheName);
        result.keeperBeforeClose = await snapshot(keeper, origin);
      }
      result.beforeClose = await snapshot(warm, origin);
      await warm.evaluate(
        async () =>
          await new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (e) => resolve(e.data);
            navigator.serviceWorker.controller.postMessage("offline-fault", [
              channel.port2,
            ]);
          }),
      );
      await context.addInitScript(() => {
        window.__pauseReliefHydration = true;
      });
      const cold = await context.newPage();
      await warm.close();
      if (keeper) result.keeperAfterClose = await snapshot(keeper, origin);
      await context.unrouteAll({ behavior: "wait" });
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
      await cold.goto(origin + "/e2e/fixtures/offline-relief.html");
      await cold.waitForFunction(
        () => Boolean(window.__sentinelPreHydrate),
        null,
        { timeout: 15000 },
      );
      result.coldBeforeHydrate = await snapshot(cold, origin);
      result.coldGate = await cold.evaluate(() => window.__sentinelPreHydrate);
      result.missingSentinels = sentinels
        .filter(
          (s) =>
            !result.coldBeforeHydrate.sentinels.some(
              (r) => r.key === s.key && r.text === s.expectedText,
            ),
        )
        .map(({ expectedText, ...rest }) => rest);
      await cold.evaluate(() => window.__continueReliefHydration());
      let renderDeadline;
      try {
        result.render = await Promise.race([
          cold.evaluate(async () => await window.__offlineRelief.probe()),
          new Promise(
            (_, reject) =>
              (renderDeadline = setTimeout(
                () => reject(Error("Render probe timeout")),
                12000,
              )),
          ),
        ]);
      } catch (error) {
        result.renderError = String(error);
      } finally {
        clearTimeout(renderDeadline);
      }
      console.log(
        JSON.stringify({
          mode,
          engine: engineName,
          save: result.save,
          manifestAfterSave: Boolean(result.afterSave.manifestText),
          manifestAfterActivation: Boolean(result.afterActivation.manifestText),
          manifestBeforeClose: Boolean(result.beforeClose.manifestText),
          manifestCold: Boolean(result.coldBeforeHydrate.manifestText),
          missingSentinels: result.missingSentinels,
          pixel: result.render?.pixel,
        }),
      );
    } catch (error) {
      result.error = String(error);
      console.log(JSON.stringify({ mode, error: result.error }));
    } finally {
      await context?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await writeFile(output, JSON.stringify(report, null, 2));
    }
  }
} finally {
  await browser.close();
}
console.log(`Diagnostic report: ${output}`);
