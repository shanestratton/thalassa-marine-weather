import test from "node:test";
import assert from "node:assert/strict";
import { TARGET, requiredSteps, validateEvidence, inspect } from "./gate.mjs";
function evidence() {
  return {
    run: {
      id: TARGET.validationRun,
      head_sha: TARGET.validationDefinition,
      path: TARGET.validationPath,
      head_branch: TARGET.validationBranch,
      event: "push",
      run_attempt: 1,
      actor: { login: "shanestratton" },
      head_repository: { full_name: TARGET.repo },
      status: "completed",
      conclusion: "success",
    },
    listing: {
      total_count: 12,
      jobs: Object.entries(requiredSteps).map(([name, steps]) => ({
        name,
        run_id: TARGET.validationRun,
        head_sha: TARGET.validationDefinition,
        head_branch: TARGET.validationBranch,
        status: "completed",
        conclusion: "success",
        steps: steps.map((name) => ({
          name,
          status: "completed",
          conclusion: "success",
        })),
      })),
    },
    refs: {
      candidate: TARGET.source,
      b132: TARGET.originalB132,
      master: TARGET.master,
      b133: TARGET.originalB133,
      b134: TARGET.originalB134,
      b135: TARGET.originalB135,
      b136: TARGET.originalB136,
      b137: TARGET.originalB137,
      b138: TARGET.originalB138,
      b139: TARGET.originalB139,
      b140: null,
    },
  };
}
const check = (e) => validateEvidence(e.run, e.listing, e.refs);
test("twelve genuine successful jobs and required steps pass", () =>
  assert.equal(check(evidence()), "passed"));
for (const name of Object.keys(requiredSteps))
  test(`reject failed job ${name}`, () => {
    const e = evidence();
    e.listing.jobs.find((j) => j.name === name).conclusion = "failure";
    assert.throws(() => check(e));
  });
for (const outcome of ["skipped", "cancelled", "neutral", null])
  test(`reject ${outcome} result`, () => {
    const e = evidence();
    e.listing.jobs[0].conclusion = outcome;
    assert.throws(() => check(e));
  });
test("reject skipped test step even if job reports success", () => {
  const e = evidence();
  e.listing.jobs[0].steps[1].conclusion = "skipped";
  assert.throws(() => check(e));
});
for (const stepName of [
  "Ephemeral PostgreSQL underway privacy, capability and RLS replay",
  "Preserve ephemeral PostgreSQL replay evidence",
]) {
  test(`reject missing required SQL step: ${stepName}`, () => {
    const e = evidence();
    const job = e.listing.jobs.find(
      (job) => job.name === "quick release gates",
    );
    job.steps = job.steps.filter((step) => step.name !== stepName);
    assert.throws(() => check(e));
  });
  test(`reject skipped required SQL step: ${stepName}`, () => {
    const e = evidence();
    e.listing.jobs
      .find((job) => job.name === "quick release gates")
      .steps.find((step) => step.name === stepName).conclusion = "skipped";
    assert.throws(() => check(e));
  });
}
for (const jobName of [
  "quick release gates",
  "package (ais-ingest)",
  "package (deepgram-proxy)",
  "package (pi-cache)",
]) {
  const stepName =
    "Verify exact application commit and preserved release ancestors";
  test(`reject missing exact-source step in ${jobName}`, () => {
    const e = evidence();
    const job = e.listing.jobs.find((job) => job.name === jobName);
    job.steps = job.steps.filter((step) => step.name !== stepName);
    assert.throws(() => check(e));
  });
  test(`reject skipped exact-source step in ${jobName}`, () => {
    const e = evidence();
    e.listing.jobs
      .find((job) => job.name === jobName)
      .steps.find((step) => step.name === stepName).conclusion = "skipped";
    assert.throws(() => check(e));
  });
}
test("reject missing suite", () => {
  const e = evidence();
  e.listing.jobs.pop();
  e.listing.total_count = 10;
  assert.throws(() => check(e));
});
test("reject truncated evidence", () => {
  const e = evidence();
  e.listing.jobs.pop();
  assert.throws(() => check(e));
});
test("reject duplicate jobs", () => {
  const e = evidence();
  e.listing.jobs[10] = e.listing.jobs[0];
  assert.throws(() => check(e));
});
for (const ref of [
  "candidate",
  "b132",
  "master",
  "b133",
  "b134",
  "b135",
  "b136",
  "b137",
  "b138",
  "b139",
  "b140",
])
  test(`reject moved ${ref}`, () => {
    const e = evidence();
    e.refs[ref] = "changed";
    assert.throws(() => check(e));
  });
for (const property of [
  "id",
  "head_sha",
  "head_branch",
  "path",
  "event",
  "run_attempt",
])
  test(`reject changed run ${property}`, () => {
    const e = evidence();
    e.run[property] = "changed";
    assert.throws(() => check(e));
  });
for (const property of ["run_id", "head_sha", "head_branch"])
  test(`reject changed job ${property}`, () => {
    const e = evidence();
    e.listing.jobs[0][property] = "changed";
    assert.throws(() => check(e));
  });
test("reject different actor", () => {
  const e = evidence();
  e.run.actor.login = "someone-else";
  assert.throws(() => check(e));
});
test("reject fork", () => {
  const e = evidence();
  e.run.head_repository.full_name = "someone/fork";
  assert.throws(() => check(e));
});
test("pending is not success", () => {
  const e = evidence();
  e.run.status = "in_progress";
  e.run.conclusion = null;
  assert.equal(check(e), "pending");
});
test("failure stops waiting immediately", () => {
  const e = evidence();
  e.run.status = "in_progress";
  e.listing.jobs[0].conclusion = "failure";
  assert.throws(() => check(e));
});
test("reject GitHub API error, without leaking the token", async () => {
  await assert.rejects(
    inspect(async () => ({ ok: false, status: 403 }), "PRIVATE-TEST-TOKEN"),
    /HTTP 403/,
  );
});
test("all reads use exact repository, GET and no redirects", async () => {
  const e = evidence();
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.ok(url.startsWith(`https://api.github.com/repos/${TARGET.repo}/`));
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    if (url.endsWith("/b140")) return { ok: false, status: 404 };
    return {
      ok: true,
      json: async () =>
        url.includes("/jobs?")
          ? e.listing
          : url.includes("/actions/runs/")
            ? e.run
            : {
                object: {
                  sha: url.endsWith("/b132")
                    ? e.refs.b132
                    : url.endsWith("/master")
                      ? e.refs.master
                      : url.endsWith("/b133")
                        ? e.refs.b133
                        : url.endsWith("/b134")
                          ? e.refs.b134
                          : url.endsWith("/b135")
                            ? e.refs.b135
                            : url.endsWith("/b136")
                              ? e.refs.b136
                              : url.endsWith("/b137")
                                ? e.refs.b137
                                : url.endsWith("/b138")
                                  ? e.refs.b138
                                  : url.endsWith("/b139") ? e.refs.b139 : e.refs.candidate,
                },
              },
    };
  };
  assert.equal(await inspect(fetcher, "TEST-TOKEN"), "passed");
  assert.equal(calls, 13);
});

test("missing140 absence evidence fails closed", () => {
  const e = evidence();
  delete e.refs.b140;
  assert.throws(() => check(e));
});

for (const [jobName, stepName] of [
  [
    "full (two-browser-e2e)",
    "Complete bounded NOAA package browser checks, both engines",
  ],
  [
    "quick release gates",
    "Ephemeral AIS PostGIS privacy, fleet budget and concurrency replay",
  ],
  ["quick release gates", "Preserve ephemeral AIS PostgreSQL replay evidence"],
  [
    "quick release gates",
    "Offline publisher, catalogue and regional relief validators",
  ],
  [
    "quick release gates",
    "Ephemeral engine-hour confirmation and concurrency replay",
  ],
  ["quick release gates", "Preserve ephemeral engine-hour replay evidence"],
  [
    "quick release gates",
    "Update 6 staged-source and confirmed-engine guard tests",
  ],
  ["quick release gates", "Update 7 staged-source and wake/radar guard tests"],
  ["quick release gates", "Network-denied actual send-push handler cases"],
  ["quick release gates", "Portable Signal K protocol type and mirror proof"],
  [
    "package (pi-cache)",
    "Prove all three actual-source Pi staging guards refuse before release",
  ],
  [
    "package (pi-cache)",
    "Preserve actual-source pre-release staging refusal evidence",
  ],
])
  for (const failure of ["missing", "skipped", "duplicate"])
    test(`140 blocks ${failure} check: ${stepName}`, () => {
      const e = evidence(),
        job = e.listing.jobs.find((job) => job.name === jobName),
        step = job.steps.find((step) => step.name === stepName);
      if (failure === "missing")
        job.steps = job.steps.filter((row) => row !== step);
      else if (failure === "skipped") step.conclusion = "skipped";
      else job.steps.push({ ...step });
      assert.throws(() => check(e));
    });
test("shipped134 is preserved independently of master and140 absence", () => {
  assert.equal(TARGET.originalB134, "4d22c003bb5493b3573b1d0f394a5a3dc74f4b07");
  assert.equal(TARGET.master, TARGET.originalB139);
  const e = evidence();
  delete e.refs.b134;
  assert.throws(() => check(e));
});
test("a rerun cannot masquerade as the original successful validation", () => {
  const e = evidence();
  e.run.run_attempt = 2;
  assert.throws(() => check(e));
});
test("a failed140 absence read is not treated as a missing branch", async () => {
  const e = evidence();
  await assert.rejects(
    inspect(async (url) => {
      if (url.endsWith("/b140")) return { ok: false, status: 403 };
      return {
        ok: true,
        json: async () =>
          url.includes("/jobs?")
            ? e.listing
            : url.includes("/actions/runs/")
              ? e.run
              : { object: { sha: TARGET.source } },
      };
    }, "FIXTURE-TOKEN"),
    /HTTP 403/,
  );
});

for (const [jobName, stepName] of [
  [
    "full (two-browser-e2e)",
    "Complete packed-data synthetic entry proofs in both engines",
  ],
  [
    "full (two-browser-e2e)",
    "Complete packed-data actual release entry proofs in both engines",
  ],
  [
    "anchor safe-area database",
    "Execute actual migration, RLS, legacy and competing transactions",
  ],
  ["anchor safe-area database", "Preserve success or failure proof"],
])
  for (const mode of ["missing", "skipped", "duplicate"])
    test("140 rejects " + mode + " new check: " + stepName, () => {
      const e = evidence(),
        job = e.listing.jobs.find((row) => row.name === jobName),
        step = job.steps.find((row) => row.name === stepName);
      if (mode === "missing")
        job.steps = job.steps.filter((row) => row !== step);
      else if (mode === "skipped") step.conclusion = "skipped";
      else job.steps.push({ ...step });
      assert.throws(() => check(e));
    });
test("shipped137 and proposed138 identities remain independently mandatory", () => {
  assert.equal(TARGET.originalB137, "12f7a34b4e3f15613bd4a55a965237b77f9376e3");
  for (const name of ["b137", "b138"]) {
    const e = evidence();
    delete e.refs[name];
    assert.throws(() => check(e));
  }
});

for(const [jobName,steps]of Object.entries(requiredSteps))for(const stepName of steps)for(const mode of ["missing","skipped","duplicate"])test(`140 every declared required step refuses ${mode}: ${jobName}/${stepName}`,()=>{const e=evidence(),job=e.listing.jobs.find(j=>j.name===jobName),step=job.steps.find(s=>s.name===stepName);if(mode==="missing")job.steps=job.steps.filter(s=>s!==step);else if(mode==="skipped")step.conclusion="skipped";else job.steps.push({...step});assert.throws(()=>check(e));});
test("verified139 remains mandatory independently of140 absence",()=>{assert.equal(TARGET.originalB139,"e28dc0c136e8a45ab5aa1cc0e3d1ce8fd3a67334");const e=evidence();delete e.refs.b139;assert.throws(()=>check(e));});
