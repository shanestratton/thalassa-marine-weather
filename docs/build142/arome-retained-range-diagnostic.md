# Retained NCALED physical-range diagnostic

The complete49 attempt captured all 48 remaining originals and retained all 50 originals, including h000 and the constant mask. Its unchanged decoder then raised `AdmissionError: original field physical range`. The error contains no field, lead, counts or extrema, so its cause is not yet qualified.

`retained_range_diagnostic.py` is a diagnostic controller only. It verifies all 50 exact original digests before decoding, retains the original issue and 18:00 UTC expiry, admits the same scalar metadata/cardinality/bitmap gates, and calls the byte-identical scientific decoder. On the first physical-range refusal, it inspects that exact decoder traceback frame, records the field, lead, unchanged range, missing/nonfinite/outside counts, finite extrema and at most 16 original-scan samples. It then re-raises the original `AdmissionError`. Values are neither clamped nor changed.

A fresh diagnostic process does not renew the original 1200-second qualification clock and cannot qualify or publish a cohort. It records that historical deadline without treating a different VM's monotonic clock as current authority. The reviewed control must enforce a separate bounded diagnostic timeout, the original 2 GiB memory/address-space, zero swap, 16 tasks, one CPU, nonroot/zero capabilities/NNP/FD 0–2, root-owned readonly source/originals and network denial before any native imports. The genuine compiled fixtures must pass under those limits before the diagnostic.

No provider download, range/units/clock/grid change, static publication, runtime installation, model admission or activation is included. A scientifically justified response to the actual refusal requires separate source review and retained-only qualification.
