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
while removing it from normal module resolution. Final repaired whole-app
TypeScript must pass under the original root-only dependency environment before
the configured production budget is accepted. Original failure and intermediate
dependency-enabled success remain evidence rather than being overwritten.

Native identity remains139 in this source-only phase. This repair performs no
provider activation, native identity bump, signing, upload or deployment. The
parent owns the later release order and unsigned Mac compile.
