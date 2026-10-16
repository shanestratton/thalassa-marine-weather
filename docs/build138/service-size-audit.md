# Build 138: unused service member audit

Base: `ad9d2d7ccd9a489253b1fcb6d7d2a2e6a138497d`. This change removes thirteen unreachable members from three internal singleton services, plus their newly unused imports/constant. It leaves the configured bundle cap unchanged.

## Caller evidence

A TypeScript syntax-tree scan of repository `.ts`/`.tsx` identifiers and string literals, followed by raw-text searches (including JS, tests, fixtures and computed/reflection access), found no production or test calls to these members:

| Service | Removed members                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Diary   | `_fileToDataUri`, `_invalidateCache`, `getCurrentLocation`, `uploadAudio`, `saveAudioForEntry`, `_removeAudioStorageRef` |
| ShipLog | `autoStartIfEnabled`, `captureLogEntry`                                                                                  |
| Chat    | `sendPinDrop`, `sendRecipeShareDM`, `logAudit`, `editChannel`, `getMyJoinRequestStatus`                                  |

`saveAudioForEntry` was reachable only from the unused `uploadAudio` wrapper. The remaining appearances of `getCurrentLocation` are a historical compose comment and an existing assertion that the page does **not** call it. Historical comments mentioned `autoStartIfEnabled`; the two in ShipLog now describe the actual explicit-start path. The service classes are not exported; their singleton objects have no computed member dispatch or reflection over these names. No tests were removed or changed.

Reachable underlying operations remain: diary compose uses its boat/phone position arbitration and current recording flow; media outbox/retirement/storage cleanup retains its existing paths; ShipLog initialization resumes through its native-lease decision and explicit starts/capture queues; pin/recipe DMs use the current `sendDM` path; admin operations still use `logAuditForOperation`. The `PIN_DROP_PREFIX` public re-export remains. OfflineQueue, moderation, privacy and notification code are unchanged.

## Measured representation savings

An isolated `esbuild.transform` comparison of each full module before/after used esbuild 0.28.1 with `{ loader: 'ts', minify: true, target: 'esnext', treeShaking: false, legalComments: 'none' }`. This does not run Vite, change bundler options or predict the exact composed artifact delta.

| Module         | Source bytes before → after | Minified bytes before → after | Minified saving |
| -------------- | --------------------------: | ----------------------------: | --------------: |
| DiaryService   |           219,566 → 215,539 |               67,261 → 66,106 |           1,155 |
| ShipLogService |           159,337 → 156,828 |               49,015 → 48,351 |             664 |
| ChatService    |             97,901 → 94,751 |               38,338 → 37,436 |             902 |
| Total          |         9,686 bytes removed |                               | **2,721 bytes** |

Evidence is retained outside the checkout in `work/audit138-service-methods.cjs`, `work/audit138-service-methods.jsonl`, `work/measure138-service-final.cjs` and `work/measure138-service-final.json`. Source byte counts compare Git's base text with the saved working files; minified comparisons normalize line endings through esbuild.

## Additional candidate retained for review

LonelyHeartsService's historical dating API has no production callers, but existing identity/media tests call it. It is retained intact. Its remaining runtime consumers are LonelyHeartsPage (`getCrewProfile`), the scope-bound service proxy in useCrewFinderActions, useCrewListConversation and AdminPanel's Crew List moderation. The other crew component imports are types. The current UI's Like and noted-introduction handlers send/withdraw `crew_intro_requests`; its Matches state hydrates accepted introductions. It does not use the historical dating likes/matches flow. Removing that twenty-method cluster in memory measured 27,941 source characters / 10,403 minified bytes, but no API or test was deleted to claim those savings.

## Validation

Existing behavior regressions: **257 tests passed in fourteen suites**, covering Diary service/position arbitration/account isolation/deletion/media ownership, Chat service/account isolation/offline/blocking/accepted crew channels, and ShipLog account/shore/source behavior. Log: `work/validation138-dead-members-focused.log`. Scoped ESLint has zero errors or warnings (`work/validation138-dead-members-lint.log`); Prettier and diff checks pass. Whole-app TypeScript and configured production size remain part of the root release pass.
