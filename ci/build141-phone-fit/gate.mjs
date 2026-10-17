import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TARGET = Object.freeze({
  repo: "shanestratton/thalassa-marine-weather",
  source: "18a360429a0e9cc73460b708075061b6d991ea45",
  sourceBranch: "codex/build-141-observed-ocean",
  originalB132: "a9372b33c967d79d8676e9bb3564b68c794cc33b",
  originalB133: "9c0d9f2f2e5ca3a00226bc023b44a850e3666225",
  originalB134: "4d22c003bb5493b3573b1d0f394a5a3dc74f4b07",
  originalB135: "08ede95ed8399e476ed1e7285ebe1f3e8775e0c5",
  originalB136: "b6fdb1626cec1d850e7f8d2f3f3df88921c34d5c",
  originalB137: "12f7a34b4e3f15613bd4a55a965237b77f9376e3",
  originalB138: "8e6edf36a0c0514c252c347b68e7bb86cc7e0da9",
  originalB139: "e28dc0c136e8a45ab5aa1cc0e3d1ce8fd3a67334",
  originalB140: "a6eac4f72ab871c195e518c589378e6020d9c5f2",
  master: "a6eac4f72ab871c195e518c589378e6020d9c5f2",
  validationRun: Number("39037294959"),
  validationDefinition: "e9612f3e771247295c2dc726f6f05ad9f58d5560",
  validationPath: ".github/workflows/validate-testflight-141-phone-fit.yml",
  validationBranch: "codex/build-141-phone-fit-full-validation",
});

export const requiredSteps = Object.freeze({
  "full (unit-coverage)": [
    "Verify exact source and all four build numbers",
    "All unit tests with coverage",
    "Record successful full suite",
    "Preserve unit coverage"
  ],
  "full (two-browser-e2e)": [
    "Verify exact source and all four build numbers",
    "Build production app for both browser engines",
    "Install both browser engines",
    "All Chromium and mobile Safari E2E tests",
    "Complete bounded NOAA package browser checks, both engines",
    "Complete packed-data synthetic entry proofs in both engines",
    "Complete packed-data actual release entry proofs in both engines",
    "Record successful full suite"
  ],
  "full (keyboard-1)": [
    "Verify exact source and all four build numbers",
    "Install both browser engines",
    "Complete keyboard, daylight and split-pane shard",
    "Record successful full suite"
  ],
  "full (keyboard-2)": [
    "Verify exact source and all four build numbers",
    "Install both browser engines",
    "Complete keyboard, daylight and split-pane shard",
    "Record successful full suite"
  ],
  "full (keyboard-3)": [
    "Verify exact source and all four build numbers",
    "Install both browser engines",
    "Complete keyboard, daylight and split-pane shard",
    "Record successful full suite"
  ],
  "full (keyboard-pixel)": [
    "Verify exact source and all four build numbers",
    "Install both browser engines",
    "Wind pixel checks, one worker",
    "Record successful full suite"
  ],
  "full (plan-your-day)": [
    "Verify exact source and all four build numbers",
    "Install both browser engines",
    "Complete Plan Your Day fit suite",
    "Record successful full suite"
  ],
  "quick release gates": [
    "Verify exact application commit and preserved release ancestors",
    "Ephemeral PostgreSQL underway privacy, capability and RLS replay",
    "Preserve ephemeral PostgreSQL replay evidence",
    "Ephemeral AIS PostGIS privacy, fleet budget and concurrency replay",
    "Preserve ephemeral AIS PostgreSQL replay evidence",
    "Ephemeral engine-hour confirmation and concurrency replay",
    "Preserve ephemeral engine-hour replay evidence",
    "Dependency audits and both release gates",
    "Lint, migration, route, formatting, mirror and type checks",
    "Portable Signal K protocol type and mirror proof",
    "Edge formatting, types and all behavior tests",
    "Network-denied actual send-push handler cases",
    "Offline publisher, catalogue and regional relief validators",
    "Guard tests",
    "Update 5 staged-source and anchor-lease guard tests",
    "Update 6 staged-source and confirmed-engine guard tests",
    "Update 7 staged-source and wake/radar guard tests",
    "Production build, hidden-map cleanup and artifact checks",
    "Install Lighthouse browser",
    "Lighthouse budgets",
    "Assert Lighthouse audited the real application shell",
    "Preserve Lighthouse evidence"
  ],
  "package (ais-ingest)": [
    "Verify exact application commit and preserved release ancestors",
    "Install, audit and validate independent dependency tree",
    "Build and test package"
  ],
  "package (deepgram-proxy)": [
    "Verify exact application commit and preserved release ancestors",
    "Install, audit and validate independent dependency tree",
    "Type-check Deepgram proxy"
  ],
  "package (pi-cache)": [
    "Verify exact application commit and preserved release ancestors",
    "Install, audit and validate independent dependency tree",
    "Build and test package",
    "Prove all three actual-source Pi staging guards refuse before release",
    "Preserve actual-source pre-release staging refusal evidence"
  ],
  "anchor safe-area database": [
    "Require an exact reviewed source",
    "Verify exact source and isolated anchor PostgreSQL identity",
    "Install only pinned isolated PostgreSQL client",
    "Execute actual migration, RLS, legacy and competing transactions",
    "Preserve success or failure proof"
  ]
});

export function assertTargetPinned() {
  if (
    ![
      TARGET.source,
      TARGET.validationDefinition,
      TARGET.originalB136,
      TARGET.originalB137,
      TARGET.originalB138,
      TARGET.originalB139,
      TARGET.originalB140,
      TARGET.master,
    ].every((value) => /^[a-f0-9]{40}$/.test(value)) ||
    !Number.isSafeInteger(TARGET.validationRun) ||
    TARGET.validationRun < 1 ||
    TARGET.sourceBranch !== "codex/build-141-observed-ocean"
  )
    throw new Error("Release source and validation pins are not complete");
}

export function validateEvidence(run, listing, refs) {
  assertTargetPinned();
  if (
    run.id !== TARGET.validationRun ||
    run.head_sha !== TARGET.validationDefinition ||
    run.path !== TARGET.validationPath ||
    run.head_branch !== TARGET.validationBranch ||
    run.event !== "push" ||
    run.run_attempt !== 1 ||
    run.actor?.login !== "shanestratton" ||
    run.head_repository?.full_name !== TARGET.repo
  )
    throw new Error(
      "Unexpected validation identity, source definition, actor or run attempt",
    );
  if (
    refs.candidate !== TARGET.source ||
    refs.b132 !== TARGET.originalB132 ||
    refs.master !== TARGET.master ||
    refs.b133 !== TARGET.originalB133 ||
    refs.b134 !== TARGET.originalB134 ||
    refs.b135 !== TARGET.originalB135 ||
    refs.b136 !== TARGET.originalB136 ||
    refs.b137 !== TARGET.originalB137 ||
    refs.b138 !== TARGET.originalB138 ||
    refs.b139 !== TARGET.originalB139 ||
    refs.b140 !== TARGET.originalB140 ||
    refs.b141 !== null
  )
    throw new Error(
      "A release source branch changed; refresh and revalidate, never ship a stale candidate",
    );
  if (
    !Array.isArray(listing.jobs) ||
    listing.total_count !== listing.jobs.length
  )
    throw new Error("Incomplete job evidence");
  const expected = Object.keys(requiredSteps);
  const names = listing.jobs.map((job) => job.name);
  if (
    listing.jobs.some(
      (job) =>
        job.run_id !== TARGET.validationRun ||
        job.head_sha !== TARGET.validationDefinition ||
        job.head_branch !== TARGET.validationBranch,
    )
  )
    throw new Error(
      "A validation job belongs to a different run, definition or branch",
    );
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !expected.includes(name))
  )
    throw new Error("Duplicate or unexpected validation jobs");
  if (
    listing.jobs.some(
      (job) => job.status === "completed" && job.conclusion !== "success",
    )
  )
    throw new Error(
      "A release validation job failed, was skipped or was cancelled; upload is blocked",
    );
  if (run.status !== "completed") {
    if (
      !["queued", "in_progress", "pending", "waiting", "requested"].includes(
        run.status,
      )
    )
      throw new Error("Unexpected validation status");
    return "pending";
  }
  if (run.conclusion !== "success" || names.length !== expected.length)
    throw new Error("Full validation did not pass all twelve jobs");
  for (const job of listing.jobs) {
    if (job.status !== "completed" || job.conclusion !== "success")
      throw new Error(`Job not passed: ${job.name}`);
    for (const name of requiredSteps[job.name]) {
      const steps = (job.steps ?? []).filter((step) => step.name === name);
      if (
        steps.length !== 1 ||
        steps[0].status !== "completed" ||
        steps[0].conclusion !== "success"
      )
        throw new Error(
          `Required release check did not actually pass: ${job.name} / ${name}`,
        );
    }
  }
  return "passed";
}

export async function inspect(fetcher, token) {
  assertTargetPinned();
  async function get(endpoint, absent404 = false) {
    const response = await fetcher(
      `https://api.github.com/repos/${TARGET.repo}/${endpoint}`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (absent404 && response.status === 404) return null;
    if (!response.ok)
      throw new Error(`GitHub validation read failed: HTTP ${response.status}`);
    return response.json();
  }
  const [
    run,
    listing,
    candidate,
    b132,
    master,
    b133,
    b134,
    b135,
    b136,
    b137,
    b138,
    b139,
    b140,
    b141,
  ] = await Promise.all([
    get(`actions/runs/${TARGET.validationRun}`),
    get(`actions/runs/${TARGET.validationRun}/jobs?filter=latest&per_page=100`),
    get(`git/ref/heads/${TARGET.sourceBranch}`),
    get("git/ref/heads/b132"),
    get("git/ref/heads/master"),
    get("git/ref/heads/b133"),
    get("git/ref/heads/b134"),
    get("git/ref/heads/b135"),
    get("git/ref/heads/b136"),
    get("git/ref/heads/b137"),
    get("git/ref/heads/b138"),
    get("git/ref/heads/b139"),
    get("git/ref/heads/b140"),
    get("git/ref/heads/b141", true),
  ]);
  return validateEvidence(run, listing, {
    candidate: candidate.object?.sha,
    b132: b132.object?.sha,
    master: master.object?.sha,
    b133: b133.object?.sha,
    b134: b134.object?.sha,
    b135: b135.object?.sha,
    b136: b136.object?.sha,
    b137: b137.object?.sha,
    b138: b138.object?.sha,
    b139: b139.object?.sha,
    b140: b140.object?.sha,
    b141: b141 === null ? null : b141.object?.sha,
  });
}

async function main() {
  const token = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  if (!token) throw new Error("GitHub read token is missing");
  const wait = process.argv.includes("--wait");
  const deadline = Date.now() + (wait ? 155 * 60_000 : 0);
  for (;;) {
    const state = await inspect(fetch, token);
    if (state === "passed") {
      const message = `All twelve release jobs and their required steps passed for ${TARGET.source}, build 141; source refs remain unchanged.`;
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
      return;
    }
    if (!wait || Date.now() >= deadline)
      throw new Error(
        "Full validation is not finished; signing/upload is blocked",
      );
    console.log(
      "Waiting for the exact build-141 validation; no Apple signing or upload has started.",
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
