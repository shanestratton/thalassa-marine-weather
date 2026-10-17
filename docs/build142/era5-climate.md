# 142-05 wind and wave climate

The optional card sits beside SeasonRiskCard inside both existing trip scrolls.
It is lazy, collapsed by default, and makes no download before opening. Its
independent error boundary preserves the seasonal card if a climate chunk fails.
It uses the actual saved route geometry or one uniquely linked saved route;
port labels and a straight line between ports cannot supply missing geometry.
Route/account changes cancel the work and immediately hide the previous result,
including an A/B/A account transition.

The contract is hourly ERA5 reanalysis for 1991–2020 on an explicitly regridded
1° grid. Wind uses 10 m u/v (165/166), not wave-model neutral wind; wave roses use
significant wave height and mean wave from-direction (140229/140230). Monthly
means cannot produce these distributions. Each rose has 16 from-directions and
eight fixed magnitude bins. Calm is separate: wind <1 kt, waves <0.1 m. Exact
polar from-directions remain missing. The UI discloses the coarse grid, units,
period, missing coverage, source, modifications and CC BY 4.0 attribution.

Each variable/year/month must contain at least 90% of its original calendar
hours before its year bit qualifies. All 30 year bits in both variables are
needed for a route cell to contribute. This is a disclosed Thalassa coverage
rule, not a claim of certified WMO normals. The period follows WMO's standard
30-year baseline. A route uses bounded great-circle midpoint sampling and local
frequencies weighted by route length; adjacent grid cells are not treated as
independent observations. Missing cells do not become calm water. Only months
covering the entire route can enter the explicitly historical lower-exposure
list, ordered by ≥34 kt wind frequency then ≥3 m significant-wave frequency.
The card is not a forecast, safe-passage recommendation or routing input.

The reader accepts a fixed public weather-bucket prefix with immutable
generation/manifest/tile SHA-256 and byte checks. Bounds are 128 cells, 32 tiles,
512 KiB per tile, 8 MiB aggregate, 45 seconds and two global native reads. Slots
remain charged until native settlement even when abort wins. A missing/invalid
dataset, offline policy, incomplete geometry or absent cells stays unavailable
or incomplete. No placeholder public dataset is installed.

Source proof: 16 focused algorithm/reader/UI cases and four phone cases pass.
The phone cases use fictional hashes/distributions only, actual ClimateRoseCard
inside the existing ModalSheet, Chrome and WebKit at 300/375 px with 130% type.
Controls/footer Close retain actual 44 px targets and centre hit tests; document
extent remains 667 px. The wind/wave roses and bottom-scrolled Close were visually
inspected. A first test-only timeout used the opener's old name after expanding;
the corrected locator preserves every geometry assertion. The specs are included
in the ordinary keyboard matrix alongside the ensemble proof. Whole composed
TypeScript, production bytes and physical-phone acceptance remain release gates.

The source-only backend framework is separate from this UI admission. It plans
720 monthly originals (wind and wave for 30×12 months), durably reserves before
an injected transport, decodes one original under Linux kernel limits, accumulates
on disk and publishes immutable children plus readbacks before the latest pointer.
It has no live CDS adapter, credentials, timer or automatic publication. Actual
CDS acceptance, supported fixed download hosts/retry rules, hash-locked ecCodes
runtime, positive/refusal Linux fixtures, resource/retention review and complete
dataset publication are still required. Presence-only checks found no credential
at three conventional paths; that does not establish that the user has no CDS
account. There has been no ERA5 bulk fetch or climate public write.

Primary sources checked 17 October 2026:

- [WMO climatological normals](https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/climate-services/wmo-climatological-normals)
- [ERA5 data documentation](https://confluence.ecmwf.int/spaces/CKB/pages/76414402/ERA5+data+documentation)
- [ERA5 complete CDS dataset](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-complete?tab=d_download)
- [ERA5 complete retrieval and regridding](https://confluence.ecmwf.int/pages/viewpage.action?pageId=315584259)
- [ecCodes Python API](https://sites.ecmwf.int/docs/eccodes/namespaceec_codes.html)
