# Sharper satellite public-read admission, 17 October 2026

The candidate public-beta profile enables the existing sharper display layer.
Distribution still requires the exact final-source configured bundle, full CI,
unsigned native compile and signed TestFlight release gates. The existing hourly
mosaic remains an explicit user choice. Satellite Mode continues to block reads.

The reviewed source is `3aadb53cc37287b08b1f5de6d2a96746320580f0`.
The actual Supabase `satellite-view` deployment is version1, ID
`9ccd2bff-061f-437d-8cf2-772e1fd0521c`, bundle SHA256
`39312cb298ecaa79d5bbc63d36f56913d27d5ba918cb35e8a27ba92c621e4526`.
All eight deployed runtime files matched their frozen Git bytes. The existing
native Supabase CLI credential admitted only `SATELLITE_VIEW_ENABLED=true`;
no management credential was exported. The mandatory HMAC quota, exact public
query contract, fixed provider hosts, original clocks, body limits and deadlines
remain unchanged. No private Vercel dashboard was accessed.

One bounded live attempt at11:44UTC made17 credentialless public GETs, receiving
425,986 body bytes and retaining11 original PNGs across six products. The newest
Himawari11:10UTC and GOES East11:20UTC images were entirely transparent and held.
Their separately selected older10:20/10:30UTC frames had usable detail. GOES West,
hourly Meteosat, daily VIIRS night and hourly upper water vapour had usable newest
frames. This proves at least one explicit usable frame per product in the tested
windows, not that every default or every location has current coverage. The app
never silently replaces a blank default with an older frame or clear-sky claim.

An independent offline native replay used the frozen production guards in Chrome
and WebKit: each decoded all11 SHA-verified originals, accepting nine and holding
the same two transparent images. It made no WAN requests and changed no clock.
All captured metadata leases were separately refused at the actual later replay
clock. A listed timestamp remains weaker than an independently verified image
acquisition clock; no world-wide, physical-iPhone, alarm or navigation claim follows.

Retained external operator evidence SHA256:

- Actual public attempt: `6d08c1b5d4d7086b8cdc5c7380873716e51d5fe89bb377baa2397beaa15d8489`.
- Independent native decode: `2f5f372c094678625ed0829284564dfd39ddb7a03291ef60cbb34166f565f7d0`.
- Source and phone proof: `820e2da0e0ced7caa8a35ff921859aef54f0471ab88fbc9bc1260e29ee44da8e`.

The source/rights disclosures in [sharper-satellite.md](sharper-satellite.md)
continue to apply, including clock-hour-only Meteosat and visible attribution.
This admission adds no direct browser-provider endpoint, licence entitlement,
paid purchase, durable image history or automatic source fallback.
