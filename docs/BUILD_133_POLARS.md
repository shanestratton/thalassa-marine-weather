# Pi polar learning — 133-05

The Pi consumes the opted-in track recorder's history in at most 500 rows per pass. Track row IDs, the learned aggregate and its cursor are checkpointed together in one SQLite setting, so a failed write or a reboot cannot count the same sailing twice. The track migration adds nullable RPM and true-wind-angle fields; old rows without coherent instrument timestamps cannot teach the polar.

PGN 127488 reaches the recorder through timestamped Signal K revolutions. Any running engine excludes a sample, and a previously running engine remains excluded if its RPM signal disappears. A boat without RPM can learn through a conservative baseline-polar and wind/speed-step heuristic. This heuristic does not prove that an engine is off; physical acceptance must check motoring and sailing on the boat's actual instruments.

The phone learner uses the same no-RPM sailing envelope and wind/speed-step fallback. Its engine-running latch is saved alongside the existing buckets and survives a learner restart; only an explicit zero RPM clears it. Existing learned buckets remain intact. The phone also rejects an alternator charging spike when RPM is unavailable, and preserves its existing policy that a missing SOG instrument is unknown rather than stationary.

The learner requires a settled minute, known STW/SOG and coherent fresh wind. It retains separate civil-day and civil-night aggregates, split at the sun's geometric altitude of −6 degrees, plus a combined aggregate. The app's solar calculation is checked against its existing SunCalc. No additional runtime dependency was added.

Preferences controls the Pi learner over the paired pinned transport. An unreachable Pi does not become a confirmed off switch: Preferences says when the Pi change was not confirmed. Learning on the Pi also requires the separately opted-in track recorder; this feature does not silently enable location recording.

Routing uses a sufficiently learned day/night grid when a fresh boat position is available, else the combined grid. Phone-only learned cells fill gaps without adding duplicate samples. The existing factory fallback, minimum eight learned cells and learned-speed bounds remain in force. The paired snapshot is cached for offline use and cannot cross a pairing change.

Local evidence: the affected app polar/routing group passed 125 tests in ten files; the Pi gate/track recorder group passed 32 tests before its additional no-RPM case. Pi TypeScript passed. Real TrackStore SQLite tests require hosted Linux validation: the local Windows dependency tree has no native better-sqlite3 binding. No Pi installation, physical engine test or TestFlight delivery is claimed here.
