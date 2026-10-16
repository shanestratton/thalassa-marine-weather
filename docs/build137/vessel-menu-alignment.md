# Vessel Systems and Music alignment

The paired shortcuts already shared a vertical baseline. Their smaller icon
chips, horizontal insets and gaps differed from the surrounding rows, however,
so the pair looked detached from the menu. Compact Vessel menus now share the
pair's existing spacing and icon dimensions. Systems lines up with Boat Binder,
NMEA Gateway, Settings and Boat Network; Music uses the same anatomy in the
second column. Labels keep their existing font sizes and every action retains
its 44 px minimum target. Taller pages retain the full-width shortcut layout.

The real app was checked in Chrome and WebKit at 300, 375 and 430 px widths,
with normal and 130% text, against the unmodified source at
`015b17fe62757701e4d37020acfb7e0e91a20bbd`. All 12 alignment/reachability
cases pass. These preserve the existing target, viewport, description, Systems
dialog, Escape/focus-return and Music navigation assertions and add measured
common left edges, icon dimensions and paired vertical baselines.

All 12 before/after comparisons have identical outer page dimensions, document
extent and scroll-port bounds. No internal scrolling increases. At 375 px with
130% text, the existing internal scroll height decreases by 15 px in both
browsers; the other ten internal scroll extents are unchanged.

Local evidence in the task's `work` directory:

- `vessel137-own-browser`: original screenshots and geometry, 12 cases.
- `vessel137-own-after`: final screenshots and geometry, 12 cases.
- `vessel137-extent-comparison.json`: exact page/document/port comparison.
- `validation137-vessel-alignment-after.log`: final 12 browser cases.
- `validation137-vessel-alignment-focused.log`: 45 focused checks in four suites.
- `validation137-vessel-existing-fit-after.log`: all 24 original phone and
  landscape fit cases pass in Chrome and WebKit, with their assertions intact.

All off-origin browser requests and WebSockets were refused. This is source
browser evidence; it does not assert physical-device acceptance or release.
