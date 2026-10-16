# Build 136 PDF byte reduction

Production builds omit jsPDF 4.2.1's unused HTML/canvas-emulation registration IIFEs and its unused AcroForm registration. The transform requires exact package version, complete source SHA256 `5b7f65fa3928b104febbcc37c7174f8e5aa3b8d9d24d0378a3fecad693d86f76`, top-level AST identity/count and individual block hashes. Unknown input stops the build. Source maps retain the original vendor source. Development keeps the published package.

PDF primitives, text/font handling and image decoders including PNG/JPEG/WebP/RGBA remain present. The app writers use those primitives and addImage; checklist boxes remain drawn rectangles. A static AST admission test rejects HTML/context2d dependencies, PDF consumer canvas access and addField/AcroForm usage. A future interactive-form feature requires reviewing this transform.

The AcroForm-only extension removes the exact 83,920-character registration region bounded by `var jsPDFAPI = jsPDF.API` and `var AcroForm = jsPDF.AcroForm`, SHA256 `5101634ff10803fcd6a17b731426c401355534cd915f5b4ecadc99dc11010fd7`, plus its twelve named exports. TypeScript lexical-symbol and export-alias analysis proves the removed bindings have no outside consumers except those twelve exports. Core exports, image plugins, font parsers, shaping and bidi behavior remain untouched.

The published minified browser entry and final transformed entry produced byte-identical float-plan, maintenance-checklist, service-history and hourly-route-weather documents after normalizing only jsPDF's random document ID. Eight PDF artifacts cover eight page pairs. Poppler rendered every pair identically; receipt SHA256 `930c9c4b9a94d0f60a132d6762738107111c853298283029d28c74efc6879561`. Generated canvas fixtures use colored image sentinels for non-Latin runs; this is output parity, while existing PDF text tests separately check run preservation. No hardware/device-font claim is made. All 126 PDF regression tests and scoped lint pass. The initial HTML/canvas-only source passed full app TypeScript; the later isolated extension must join the final combined source check before release.

Actual configured builds use existing public release variables without logging their values. The source checkpoints measured:

| Source                                                               | JavaScript bytes |  Change |
| -------------------------------------------------------------------- | ---------------: | ------: |
| Baseline `101986db98ab31b52da31ef5c96c5ea1e34a465f`                  |       10,725,376 |         |
| HTML/canvas-only `173cfeaf5871f1fadfe26b41e5cc5f90420df82b`          |       10,677,905 | -47,471 |
| Lossless timezone packing `f5914da326db73765cd84b31390ef8b41198feb0` |       10,642,954 | -34,951 |
| AcroForm-only extension `aeaf43bbc16bfdf6924dcbcf0d4b8cc19e199ff4`   |       10,611,205 | -31,749 |

The three cuts save 114,171 bytes against that baseline and leave 31,841 bytes below the unchanged 10,643,046-byte limit. This measures the earlier build-136 checkpoint; later phone-course, UDP/Signal K and other additions require a fresh complete configured build. No threshold is raised and this isolated measurement alone does not certify the later complete release.
