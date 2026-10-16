# Build 136 PDF font and constant-data reduction

Source checkpoint: `c0da96d27ffb84d943ec33b1c1e667e995e85b7e`.
Baseline: composed 136 `6054ba5ecdc2312302c7374ebd4a6deb5dc00b8d`.
The configured production artifact passes the existing budget without changing
its limits or application report features.

| Configured artifact      |   JavaScript | Headroom against 10,643,046 B |
| ------------------------ | -----------: | ----------------------------: |
| Composed 136 baseline    | 10,679,306 B |                     -36,260 B |
| PDF font/data checkpoint | 10,628,284 B |                      14,762 B |

Saving: **51,022 B**. The jsPDF chunk changes from 276,620 to 225,598 B;
the aggregate JavaScript delta is exactly that chunk's reduction. Main JavaScript
stays 23,985 B raw / 9,480 B gzip, with 451 JavaScript files. Total deployed
assets are 15,127,457 B against the unchanged 18,874,368 B limit. The later
paired-Pi notice consumer is outside this baseline and requires a fresh combined
measurement before shipping.

## Reviewed transform

The existing production-only transform still pins jsPDF 4.2.1 and the entire
published ESM source SHA-256:
`5b7f65fa3928b104febbcc37c7174f8e5aa3b8d9d24d0378a3fecad693d86f76`.
It now additionally checks exact AST regions and hashes for the unused TrueType
loader/parser, its custom-font UTF-8 event handling, VFS and cell/table emulation.
The removed TrueType implementation's bindings have no references outside that
region, verified through TypeScript symbol identity.

All standard-font registrations and resource IDs remain. Default Helvetica,
all four Helvetica style metrics and Courier normal metrics are unchanged.
The other font metric payloads become empty metadata placeholders so untouched
standard-font encoding registration still initializes without event errors.
The production source guard rejects new unsupported family/style selection,
custom-font/VFS access or jsPDF cell/table use, including font method aliases.
The maintenance report's own `MaintenancePage.table` is recognized from its
local class and constructor binding; it remains unchanged. Ordinary data fields
named `cell` and database tables are not PDF API calls.

PDF primitives, all existing image codecs, Arabic shaping and bidi processing
remain. Only the private bidi class array's representation changes: the exact
2,048 entries become 231 category/count runs in 474 immutable bytes. The decoder
checks encoded length, run boundaries and a 2,048-entry output ceiling. The table's
original values SHA-256 is
`adf675476359b5604f7b0e3da0403e9104b785e6ff2a1b53ed20ac8a309e4d35`.
Tests compare every reconstructed entry, reject malformed runs and compare
actual mixed RTL/LTR PDF text ordering. The bidi algorithm is unchanged.

## Actual proof

All 12 focused `JspdfPrimitives` cases pass, including:

- the published minified jsPDF browser build versus the production transform;
- exact output from the real float-plan, maintenance checklist, service-history
  and hourly-route report writers, normalizing only jsPDF's random document ID;
- retained font metadata/widths/default IDs, Arabic shaping and image APIs;
- exhaustive bidi table equality, bounded malformed-data refusal and eight mixed
  RTL/LTR ordering cases;
- AST/reference guards and scanning all 1,831 current production source modules.

Poppler rendered the four writer pairs at 72 dpi: eight paired pages have
identical dimensions and RGB pixels. The contact sheet was inspected. The
existing non-Latin canvas fixture uses colored sentinel images; equality proves
unchanged output, not native device font coverage.

Local evidence is outside application source:

- `work/build136-configured-font-c0da/` and its measurement JSON/log;
- `work/pdf136-fonts-artifacts/`, including both sets of four PDFs, sixteen page
  PNGs, the inspected contact sheet and `render-proof.json`;
- `work/validation136-pdf-font-focused.log`.

Measurement JSON SHA-256:
`02a2fff963373b7cb4dcdc5399df5dda121bcb6f0aa475d165eb6e3042dd0672`.
Candidate-stamped render receipt SHA-256:
`28390acf59c01c632a9f706f0aa9bb02d35bc9fd462c2016bdc1322f466541e0`.
Scoped ESLint, formatting and whitespace checks pass. No extra whole-app
compiler was started; the combined release still needs its normal type/build,
native and full CI gates on final source.
