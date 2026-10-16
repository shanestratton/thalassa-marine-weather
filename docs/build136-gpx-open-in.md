# GPX opened from Mail or Files

Build136 source adds the imported `com.topografix.gpx` viewer type and sends local `.gpx` document URLs through the existing security-scoped, coordinated native copier. The app's Documents directory remains private. No file sharing or opening app storage in place is enabled.

The copier and reader accept at most8MiB, reject remote/ambiguous URLs and XML entity declarations, and use a generated account namespace. Only one preview file is held in memory. The original temporary copy is removed after reading; late copies are cleaned when an account changes or the15-second deadline expires. Native temporary storage is separately capped at four files/16MiB. No route or track is uploaded by this handoff.

The existing GPX preview still presents the skipper's explicit Log import and Passage Planner actions. An account change clears its private data immediately, fences late file/save results and cancels an active import. The asynchronous preview acknowledges its queued file only after reading, so React's development remount does not lose a cold-start attachment. Duplicate native launch/open events preview once.

Validation:81 native-copy, URL-handoff, GPX parsing, preview, account-change and existing GRIB regression tests pass. The new native copier still needs the combined GitHub Mac compile. Actual Mail/Files handoff on an iPhone is unverified. The separate Signal K route-to-boat course writer is not part of this checkpoint.
