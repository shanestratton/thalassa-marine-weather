# Upper-RH display-unavailable candidate

Source-only scientific policy candidate: `upper-rh-display-unavailable-v1`. No provider request, native qualification, activation or publication is authorized by this file. The historical packing-boundary-only proposal is superseded by the complete retained survey below; its original source and failure evidence remain unchanged.

## Actual retained evidence

The original NCALED run remains `2026-10-17T00:00:00Z`, expiring `2026-10-17T18:00:00Z`. Raw scientific source `cf21a611c6b22db62449bc1658e7ae8b931476be` describes the genuine 521×491 original grid. All 49 forecast originals and the constant mask have been captured once, with exact aggregate original size 137,421,911 bytes. No re-acquisition is proposed.

The actual retained survey receipt is `work/arome142-range-survey-actual-verified/VERIFIED_COLLECTION.json`; its native details are `text/native/physical-range-survey.json`. It inspected all 245 selected field headers and all 49×5 arrays under the original strict scientific rules. Twenty leads refused only on RH. Across 12,534,739 raw RH grid sample-hours, 258 samples exceeded 100%. Of these, 217 fall within their recorded packing interval and 41 do not: lead30 has four, lead32 nine and lead37 twenty-eight. Their maxima are respectively 100.01163864135742%, 100.0125732421875% and 100.01066207885742%, with packing error 0.007814407348632812%.

The audit found no violations in the other 196 selected U/V/temperature/pressure fields, no nonfinite-present values and no uninspected fields. This establishes their observed scalar/range results, not a completed new static qualification. These counts include land and sea; the affected sea-cell intersection is not yet measured. They are not a user-coverage or accuracy percentage. The old complete49 attempt still failed qualification and produced no qualified tiles or public cohort.

## Scientific interpretation and limit

[Météo-France's parameter guide](https://donneespubliques.meteofrance.fr/client/document/description_parametres_modeles_181.pdf), HU/HU(2m), defines the model's RH using saturation over liquid water and diagnoses the 2m field above the model surface. An ice/mixed-phase explanation taken from another model or pressure level cannot establish the cause here.

[ECMWF GRIB2 template5.42](https://codes.ecmwf.int/grib/format/grib2/templates/5/42/) describes the packed representation. The exact [ecCodes2.50 packing-error implementation](https://github.com/ecmwf/eccodes/blob/2.50.0/src/eccodes/accessor/SimplePackingError.cc) gives the recorded uncertainty bound. The full survey disproves a packing-only explanation for every upper sample. Neither those sources nor the captured original establish that any offending sample should equal 100%. Actual supersaturation, upstream processing and the cause of individual excesses remain unproven. The policy makes no meteorological diagnosis.

## Narrow policy and unchanged refusals

Only the optional RH display view changes. After unchanged message framing, exact metadata/units/grid/scan/UTC/lead/cardinality and bitmap admission, finite RH above 100 becomes NaN, which the existing consumer represents as null. The original GRIB file is untouched. A separate view is allocated when quarantine is required. Values at 0 and exactly 100 remain numeric; no clamp, rounding correction, interpolation, farther-cell search, model substitution or new upper numerical range is introduced.

Negative RH or infinite present RH retains the original packet refusal. Original missing values remain missing. All existing U/V/pressure/temperature/mask guards, the RH consumer domain 0–100, original resolution, exact-zero sea admission and output/deadline/storage limits remain unchanged. The shared decoder has this display policy, but actual original qualification is requested only for this captured NCALED cohort; no other domain is thereby qualified.

Every finite upper value, including an extreme finite value, is quarantined rather than numerically accepted. A new arbitrary upper threshold would assert an unsupported scientific boundary and still provide no usable RH number. If an entire RH grid is quarantined or missing, its availability is explicitly `unavailable`; valid independently checked U/V/T/P need not be discarded. This is optional-variable availability isolation, not a claim that extreme RH is valid or that a whole five-variable cohort is fully available. Negative/nonfinite-present refusals remain conservative packet failures within this narrowly scoped change.

Per-packet QA is a fixed object, below 2KiB without sample lists. It records source finite extrema, separate upper extrema/count, original bitmap missing, other original missing, valid-display and total missing counts, `complete`/`partial`/`unavailable`, reason `upper-rh-outside-display-domain`, unproven cause and explicit false clamp/normalization flags. The static native proof aggregates these counts, preserves per-packet QA and the 49 original digests, and binds all four actual scientific file hashes. Its wording now distinguishes intact original GRIB bytes and original grid positions from changed optional display values; it no longer claims all original numerical cell values are preserved.

## Evidence required before adoption

Pure scalar/QA tests and existing actual consumer tests can run without native imports. New generated ecCodes/NumPy cases are prepared, including exact100, the next representable float above100, small and far upper values, negative/infinite refusal, bitmap distinction, entirely unavailable RH, scan direction, unchanged other fields and generated49 static/point null preservation. They remain unexecuted until a separately reviewed confined Linux run. The existing four native cases remain unchanged and required.

The actual consumer already maps qualified NaN to null at the nearest original sea cell and retains optional RH gaps through the report. It continues to reject unqualified numeric RH outside 0–100. No application runtime change is needed. The new consumer regression tests explicitly retain a valid neighboring cell and a global supplement while requiring the original gap to remain null.

A separate retained-only qualification phase is required under a new scientific source identity. It must not relabel or renew the earlier failed capture+qualification attempt, renew the model clock, or extend the original 18:00UTC expiry. See the companion retained-qualification plan. Until that genuine native/static evidence passes and root reviews it, full49 static qualification, public availability and activation remain held.
