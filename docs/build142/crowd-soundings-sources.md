# Crowd soundings: reviewed sources and separation

Roadmap14209 covers public display-only soundings, conservative QA/grids,
0.5m-spaced contour tiles, a lazy Obs layer and DCDB contribution. Spacing is
not an accuracy claim. No crowd product enters routing, clearance or alarms.
Private phase1 capture and its three canonical core mirrors remain unchanged.

Primary sources checked17October2026:

- The [IHO catalogue](https://iho.int/en/bathymetric-publications) lists
  [B12edition3.0.0](https://iho.int/uploads/user/pubs/bathy/B_12_CSB-Guidance_Document-Edition_3.0.0_Final.pdf).
  Sections2.3 and3.2 distinguish instrument offsets, raw/as-captured depths,
  metadata and tidal reduction. Raw depths with original UTC and offset context
  are preferred for DCDB; a tide-reduced display grid is a separate product.
- The [live NCEI DCDB page](https://www.ncei.noaa.gov/iho-data-centre-digital-bathymetry)
  links the actual [2025submission guide](<https://www.ncei.noaa.gov/sites/default/files/2025-07/Guidance%20for%20Submitting%20CSB%20Data%20to%20the%20IHODCDB_v2.0%20(3).pdf>),
  [format3.0 examples](https://www.ncei.noaa.gov/sites/default/files/2024-04/SampleCSBFileFormats.pdf)
  and [Trusted Node agreement](https://www.ncei.noaa.gov/sites/default/files/2024-04/IHOCSBTrustedNodeAgreementFormTemplate.pdf).
  The earlier `sites/g/files` guide URL returned404. Following the live link
  resolved `sites/default/files`, and all9pages were readable.
- Onboarding requires a reviewed sample, an agreed prefix/UUID identity and an
  issued token. The guide's example API is a **test** endpoint. No production
  admission, prefix, token or provider contact is inferred. No contact or upload
  is performed.
- The [official schema repository](https://github.com/CI-CMG/csbschema) documents
  provisional XYZ/GeoJSON3.0 and newer GeoJSON3.1. Export must name the convention
  actually reviewed during onboarding, not silently adopt a different version.

Legacy private consent2026-10-05 grants no public permission. Map and DCDB/CC0
choices start independentlyOFF, owner/vessel scoped, revision-bound and
future-only. Thirty days must pass after a batch ends. Capture OFF is separate
from publication OFF. Public CC0 copies cannot be recalled; OFF stops future
release and excludes the source from the next active Thalassa generation after
current owner/privacy checks. It does not promise removal from external archives.

Draft confirmation or a reported offset alone is not sounder calibration. The
public policy requires explicitly checked reference/source/product, measured
waterline offset, date, uncertainty and checked depth range. T adds that offset
once; W does not add it again. No boat, draft or model is hardcoded. Existing Pi
captures declare GNSS time; phone captures currently declare device clock and
remain held for this public QA.

Map reduction requires original observed water levels with explicit reviewed
common datum/region, UTC bracket, QC, uncertainty and reusable rights. WorldTides,
unknown datum, zero tide and proximity-only station assumptions cannot qualify.
Cells require independent boats and UTC days; missing cells stay empty. Contours
use only fully qualified neighboring cells of the same datum. Current privacy
zones receive a cell-sized exclusion buffer before aggregation. Public products
carry no owner/vessel/track identifiers.

This first policy/consent/migration packet is source only. Actual PostgreSQL
RLS/concurrency, Linux QA, publication, browser layout, tide-source authority,
DCDB onboarding and physical Pi acceptance require separate evidence. It has
not been deployed or run against a database.
