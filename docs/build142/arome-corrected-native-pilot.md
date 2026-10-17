# Corrected NCALED retained-original native pilot

Scientific source is `cf21a611c6b22db62449bc1658e7ae8b931476be`.
Only its two canonical NCALED grid records change the scientific admission:
521 × 491, 255,811 original cells, 158.5–171.5°E and 26–13.75°S.
`native.py` and its physical ranges, units, clocks, scan handling and array
cardinality checks retain their original bytes. The other domains do too.

`corrected_original_native.py` is a separate controller. It imports the exact
corrected catalogue only after checking the unchanged original kernel helper,
actual Linux limits and source hashes. It checks every selected scalar header
before calling the unchanged decoder and reports all full-field cardinalities,
finite/unknown counts and decoded hashes. It never patches a catalogue in RAM.

The only input is the retained 1,373,100-byte lead-zero original with SHA-256
`4e2e34400535158f696f1684c74bebb6d08126e37f9f713f29f94a30498bd733`.
Its genuine acquisition provenance remains the original 9f source/run, while
the separate decode records the corrected cf21 scientific source. There is no
provider read or source alias. The original 17 October 2026 00 UTC model run
expires at 18 UTC; decoding does not renew that clock.

Fifteen pure controller refusal cases pass locally without native imports.
Actual Linux decoding is pending the separately reviewed immutable control.
Any actual physical-range or other decoder refusal remains a failed admission.
The pilot cannot qualify a sea mask or all 49 forecast hours and cannot publish.
Historical 9f, 0c33, 93ba and c14 controls and their success/failure receipts remain
unchanged. No complete regional coverage is claimed by this pilot.
