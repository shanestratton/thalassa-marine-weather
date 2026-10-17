# Final142 source validation repair

Exact composed source `546d12f95cc1a1abb2c76eaae3531a791644fc5f` failed whole-app
TypeScript at `2026-10-17T07:24:54.014Z` with one diagnostic:
`pi-cache/src/ownBoatSkill/store.ts` could not resolve `better-sqlite3`.
The first receipt/log remain
`work/validation142-composed-546d12f95cc1-whole-tsc.{json,log}`.

Temporarily making the existing, lock-matching Pi dependencies available made that
same source pass at `07:27:33.158Z`, recorded separately as
`work/validation142-composed-546d12f95cc1-dependency-repair-whole-tsc.{json,log}`.
No dependency was installed or package file changed. That showed an actual hidden
CI dependency: the pure scorer and its app-side test imported `PrivateWindSample`
from the SQLite-backed ledger. App CI and the unsigned native workflow install
root dependencies only; TypeScript followed the imported type into the otherwise
excluded Pi store and required its native package declarations.

The canonical type is now exported by the pure `ownBoatSkill/source.ts` contract.
The scorer and test import it there, and `store.ts` keeps its previous compatible
type export. No sample fields, scoring, SQLite behavior, test assertions, package
lock, type-checker exclusion or build ceiling changes. This is a type boundary
repair, not a reason to install a server database into the app build.

The four focused source/scorer/transaction/session suites pass all 59 cases, with
scoped lint, Prettier and `git diff --check` clean. The reused local Pi dependency
junction was moved to an ignored `.local` name, preserving its installed target
while removing it from normal module resolution. Exact repaired source
`11af28f2465b333fa4c48a0f73addfe5c411b2e3` passed whole-app TypeScript with
root-only dependencies at `2026-10-17T07:31:29.922Z`. Its configured Vite build
finished successfully at `07:33:38.927Z`, but the unchanged JavaScript budget
failed: 10,650,289 bytes against 10,643,046, an excess of 7,243 bytes.
The exact receipt remains
`work/build142-configured-final-11af28f2465b-receipt.json`. Original failure,
intermediate dependency-enabled success and the genuine budget failure remain
evidence rather than being overwritten.

The subsequent source normally merges the reviewed139 document-teardown repair
through141 `740bb8636082d513c6e17b902ceb218fa8bd01d6`. The lossless representation
candidate in [authored-prose-packing.md](authored-prose-packing.md) requires a
fresh exact-source compiler and configured full-artifact measurement before any
size acceptance; an isolated estimate is insufficient.

Native identity remains139 in this source-only phase. This repair performs no
provider activation, native identity bump, signing, upload or deployment. The
parent owns the later release order and unsigned Mac compile.
