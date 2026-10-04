# Adding and updating o-charts

## Skipper flow

1. Open **Vessel → Boat Network → ENC Charts** on a device paired to the boat's Pi.
2. Choose **Add or update charts** and paste the delivery email or its download link. Up to four deliveries can be queued together.
3. Check the package names and select **Add or update on Pi**. When an email includes a SHA-256 checksum, it is checked before conversion.
4. Leave the boat's Pi powered, online and connected to its registered o-charts dongle. Keep the window open to submit each queued delivery in turn. If it closes, the Pi can still finish its current delivery; unsent deliveries must be submitted later.
5. Thalassa reports new, updated and unchanged charts separately, then automatically attempts to copy them to this phone. Pi installation and phone copying are independent stages: after disconnection, use **Recent Pi installs → Check recent installs → Sync charts** to continue without downloading the package again.

The download must belong to this boat's licensed system. Expired links, missing installation keys, a disconnected dongle or an incomplete conversion are errors, not successful installations. Existing Pi chart coverage is retained when a delivery fails validation. Never paste or publish a private download link in a public diary.

## Revision handling

- Native chart IDs and producing offices come from the licensed key XML, not the region/package name. Synthetic `OC-*` IDs remain stable for existing references.
- Edition, update number, issue date and exact content hashes identify revisions. Older editions/updates cannot overwrite newer charts.
- A package rebuild can change only the SENC creation date without changing the ENC revision. After verifying the installed bytes, this is treated as unchanged; navigation data and every other field must still match. The selected installed blob and its hash are preserved.
- Each delivery is converted into isolated staging. Every expected cell must be present and validated before one atomic index publication.
- Immutable chart blobs and a shared index lock protect concurrent watcher, S-63 and upload writes. Updates do not delete other regions or cells omitted from a delivery. Omission alone is not evidence that a chart was cancelled; retained cells should not be described as refreshed by that delivery.
- Signed Pi responses and exact-byte fingerprints bind phone copies to the indexed revision. Updating a chart invalidates affected route-check fingerprints and depth-overlay caches, including overlapping charts.
- Installation receipts survive service restarts; they are bounded to 30 entries and seven days. Receipts do not contain the private source URL. An interrupted job must be inspected before a fresh download is requested.

## Deployment requirements

Deploy both the Pi service and `tools/senc-extractor`; deploying `pi-cache` alone is insufficient. The extractor needs `tsx` available in its own directory at runtime (it is currently declared under devDependencies, so do not omit those dependencies), plus the existing licensed o-charts reader and registered dongle. The service launches the extractor directly via `node --import tsx`, without an implicit npm download.

Use SSD-backed temporary storage with sufficient free space for the archive, decrypted source and converted charts. On the boat Pi, the service's `TMPDIR` is `/opt/thalassa-chart-staging`; its RAM-backed `/tmp` is too small for the Australia delivery.

Before restarting a boat Pi, confirm that interrupting live instruments and Shore Watch updates is safe. Preserve its local environment, pairing identity, existing chart store and source archives. Back up the running service/extractor and chart index. Build before restarting, check service health afterward, then install one delivery at a time and verify its receipt and signed chart index. A successful local app build does not mean the Pi or phone has been updated.

This work does not change public-beta chart access, chart licensing, or redistribution permissions.

## This boat's 27 September 2026 deliveries

The Pi already has the Australia update (934 refreshed cells) and New Caledonia (91 new cells). After building and running the updated iPhone app in Xcode, connect it to the paired boat Pi and use **ENC Charts → Check recent installs → Sync charts** on each completed receipt. Do not submit the download links again. The two deliveries total approximately 1.1 GB of converted chart data before HTTP compression; use the boat network when practical.

Five source cells contain no DEPARE/DRGARE depth polygons: `FR47049A`, `FR47049B`, `FR47049C`, `AU415130` and `AU468063`. They installed on the Pi but are deliberately excluded by the phone's depth-coverage check. Retrying or reinstalling cannot add missing source data. The other 1,020 delivered cells passed the phone's chart-schema check; this does not certify navigation safety or current local conditions.

The newer Australia package omitted `SB5102P3`; without an explicit cancellation it was retained, not refreshed. Four historical Australian entries with unresolved package ownership were also preserved. No existing chart regions were deleted.
