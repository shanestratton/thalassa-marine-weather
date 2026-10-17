# Build 133-06 barometer

The modal selects 6, 12, 24 or 48 hours of observed history with a separate forecast MSL trace through the next 12 hours. The 163 px Glass cell is unchanged. Phone calibration is never applied to the boat trace. Guide copy describes pressure bands without predicting a front, gale or arrival time from pressure alone.

The Pi samples its BMP390, falling back to timestamped Signal K `environment.outside.pressure` (Pa converted once to hPa). Stale, future and implausible bus readings are rejected. Sensor changes start a separate tendency segment. Actual fresh Signal K position is retained with observations; a selected forecast/map location is never used to qualify a daily correction.

Ten days are held in memory and in daily append files; expired day files are removed once per day. A minute appends one observation instead of rewriting ten days. The previous `barometer.json` record is read during upgrade. Partial final writes are isolated, malformed rows are skipped, and disk failures do not stop sampling. Continuous phone samples now accumulate in fixed 100-second buckets, correcting the prior rolling-overwrite bug.

Tendency uses the established marine bands and robust observed endpoints. Gaps over 45 minutes invalidate a tendency. In the tropics, five agreeing prior daily changes from nearby sensor positions can supply a correction. Each historical 3-hour change is detrended by its surrounding 24-hour change; today's pressure fall is excluded from learning. Between-day dispersion supplies a displayed empirical uncertainty allowance. Missing, moved or inconsistent history explicitly leaves raw change visible. The estimator is an engineering choice requiring boat validation, not a universal tropical amplitude. A very rapid raw fall cannot be cancelled by the correction.

The app's notification manager monitors a rapid fall independently of the open modal. Confirmation requires advancing observations over two live minutes; repeated reads of one sample cannot confirm an alert. One notification fires per episode, with hysteresis and five clear minutes before rearming. Stale data neither fires nor clears an episode. ALERTS requests local device permission; without permission the in-app warning remains. Delivery is immediate and local while the app runs. No server push, owner-away pressure rule or Pi alarm relay was added. The full Instrument Panel shares the corrected tendency and labels it when applied; its pale hand retains the actual raw three-hour change.

## Evidence and gates

- Local integration: 49 Vitest tests in eight files passed, including modal windows/forecast geometry/boat calibration, continuous phone history, source switching and stale clocks, advancing-observation confirmation, permission/delivery, and NotificationManager account boundaries.
- Local integration: strict isolated TypeScript compilation and three Node tests passed for Pi sensor fallback/freshness and restart/torn-append/ten-day retention. The full Pi package still requires its installed dependencies and integration CI.
- Targeted ESLint completed with zero errors (the Instrument Panel retained eleven existing unused-variable warnings); changed files passed Prettier. Full repository Vitest, lint, client/Pi builds and the unchanged bundle budget remain integration CI gates.
- Pending real hardware: BMP390/Signal K dropout recovery, ten-day retention over upgrade/restart, iPhone notification delivery and permission flow, and the learned daily correction against the boat's actual tropical record. Requires staged Pi update 5; no Pi install/deploy was performed here.

## Primary references

- [Met Office marine glossary](https://weather.metoffice.gov.uk/guides/coast-and-sea/glossary): three-hour pressure tendency bands.
- [Sen, MAUSAM (1951), doi:10.54302/mausam.v2i3.4679](https://mausamjournal.imd.gov.in/index.php/MAUSAM/article/view/4679): corrections must suit the station and period; a universal mean correction can mislead.
- [NOAA NWS ER 76-14, Barometric Pressure and Pressure Change](https://repository.library.noaa.gov/view/noaa/70668): natural twice-daily pressure rhythm.
