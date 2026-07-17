# Handover — Fable 5 → Opus 4.8 (Claude A, quality-enforcer mission)

Shane is switching models mid-mission. This is everything you need to
pick up the march without missing a step. The project memory directory
(`~/.claude/projects/…/memory/`) is shared — read `MEMORY.md` first;
this file covers the last three days' state and the hard-won operating
rules that aren't in memory yet.

## Where the mission stands (2026-07-18 evening)

**The two-number system (never conflate them):**

- **Open adversarial score: 86.15/100** — arc 79.6 → 83.75 → 84.25 →
  86.15 across three 11-agent audits, ZERO refuted verdicts total.
- **Vs-frozen-bar scores:** cycle 1 = 97.7, cycle 2 = 99.75, cycle 3 =
  99.25 — each burn-down freezes one audit's findings and burns to zero.

**Cycle-3 verdict (the strongest yet):** safety 28.25/30; chief:
"validation core survived adversarial re-verification intact… edge-
geometry and degraded-data cases, not systematic wrong answers…
trustworthy for the 2.4 m Tayana in home waters, with eyes open."
Named gap for the bluewater market: ZOC-B zero-margin graze + >5 m
glaze cap + GEBCO positional trust.

**Docs (all in `docs/`):** `ENC_BURNDOWN_2026-07-16.md` (#1, closed),
`ENC_BURNDOWN_2026-07-17.md` (#2, closed), `ENC_BURNDOWN_2026-07-18.md`
(#3, closed 99.25), `ENC_AUDIT_2026-07-17_open.md` / `_closing.md`,
`ENC_AUDIT_2026-07-18_closing.md` (cycle-3 verdict + full transcript).

## Next actions (in order, pending Shane's word)

1. **Burn-down #4**: freeze the cycle-3 top-8 (in the closing-audit doc)
   at baseline 86.15. Chief's fix-first: **ZOC-aware lateral clearance
   margin** around AREA hazards (`EncSpatialIndex.ts` polygon checks are
   unpadded; CATZOC advisory gate at `landAvoidance.ts` ≥4 should be ≥3)
   **plus the free one-liner in the same commit**: the silent segment-vs-
   polygon catch (`landAvoidance.ts` ~986) needs a caution advisory —
   the last way a clean report can lie.
2. **White lights** render near-white on the white chart — map the
   `#f0e030` `_lightColor` key to a YELLOW flare glyph (`seamarkIcons.ts`
   light icon registration), per the codebase's own comment.
3. Rolling residues: tagAndPush extraction (0.25, partial-banked),
   TOPMAR/DAYMAR + CBLSUB/PIPSOL (one Pi extractor batch ships all),
   S-52 night palette (promoted roadmap project — Shane's explicit call).

## Operating rules (hard-won THIS session — believe them)

- **Shared tree**: other Claude sessions commit live in this repo.
  Stage EXPLICIT PATHS only; check `git status` before commits; their
  transient tsc/syntax errors are not yours to fix; my in-progress edits
  got swept into their commits twice — verify completeness in HEAD and
  bank against the real hash. NEVER build/sync while their tree is broken.
- **Memory pressure**: full `vitest run` and unflagged tsc/eslint OOM
  the Mac. `NODE_OPTIONS="--max-old-space-size=8192"` on everything;
  targeted test suites only (`tests/enc/` + specific files). NEVER run
  an 11-agent audit concurrent with `npm run build`.
- **Ship loop**: prettier --write before every commit (husky enforces);
  `npm run build && npx cap copy ios` after JS changes (Shane tests
  native iOS via Cmd+R — no browser previews, ever).
- **Doc editing**: the ledger tables get REFORMATTED by prettier between
  your read and write — exact-string table anchors fail silently, and a
  find-next-anchor slice once truncated whole sections. APPEND ledger
  rows; verify with grep after every doc edit.
- **Audit harness**: saved workflow script (11 agents: 5 dimensions ×
  audit+red-team + chief) at
  `~/.claude/projects/…/9d69c5a8-…/workflows/scripts/enc-final-open-audit-wf_d5a64621-927.js`
  — invoke via `Workflow({scriptPath})` for each cycle's closing audit.
  Fresh runs only (no resume) for honesty. ~16 min, ~1.6M tokens.
- **Protocol honesty**: open scores and vs-bar scores are labelled
  separately, always. Refuted/adjusted findings and partial banks are
  recorded as such. Never fudge — Shane's hard rule, and the audits
  reward it: the qualitative verdict is the real scoreboard.
- **Pi work**: re-extraction runbook is proven autonomous — see the
  `project_senc_extractor` memory (ssh skipper@calypso.local, sudo -n
  scope is LIMITED — check `sudo -n -l`, avnav stop/start covered, rm is
  not). Cloud bucket uploads: service key via
  `npx supabase projects api-keys --project-ref pcisdplnodrphauixcau
--output json`, manifest version MUST bump (now v8).

## Tone with Shane

Direct, warm, Aussie-adjacent. "Hup/march" = keep working autonomously,
commit+push freely, report at milestones with the score arc. He makes
the strategy calls (he chose the burn-down protocol, the blue-shallow
ramp, the palette promotion); bring him crisp options with a
recommendation. He's excited about this mission — earn it: the numbers
are real, keep them real.

Good hunting. — Fable 5
