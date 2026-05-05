import Foundation
import Capacitor
import MusicKit
import AVFoundation

/**
 * AppleMusicPlugin — MusicKit-based Apple Music control for Calypso.
 *
 * Rebuilt 2026-05-04 from MPMediaQuery / MPMusicPlayerController to
 * pure MusicKit. The old code couldn't play Apple Music subscription
 * content because all DRM-protected streaming tracks have nil
 * assetURL via the legacy APIs. MusicKit handles streaming
 * subscription content natively — full catalog access (~100M
 * tracks), proper coexistence with our app's audio session, and
 * fine-grained playback control.
 *
 * Authorization model: MusicAuthorization.request() prompts the
 * user with the modern MusicKit consent dialog (NSAppleMusicUsage-
 * Description in Info.plist). Required before any catalog access.
 *
 * Methods exposed to the JS layer:
 *   Authorization
 *     - requestMusicKitAuthorization
 *     - getMusicKitAuthorizationStatus
 *
 *   Catalog playback (search & play any Apple Music content)
 *     - searchAndPlay(query, kind?)
 *
 *   User library access
 *     - getUserPlaylists — returns user's library playlists with
 *       metadata + artwork URLs for the Music page UI
 *     - playPlaylist(id) — play a specific playlist by its
 *       MusicItemID
 *
 *   Playback control
 *     - pause / resume / next / previous / nowPlaying
 *
 *   TTS playback (separate AVAudioPlayer pipeline for Calypso's
 *   voice — preserved from previous implementation)
 *     - playTtsAudio(audio_b64)
 *     - cancelTtsAudio
 *
 * The developer token signing happens server-side via the Supabase
 * edge function `musickit-token`. The iOS layer fetches the token
 * lazily and caches in JS until expiry.
 */
@objc(AppleMusicPlugin)
public class AppleMusicPlugin: CAPPlugin {

    // ── TTS state (preserved from previous architecture) ────────────
    private var ttsPlayer: AVAudioPlayer?
    private var ttsPlayerDelegate: TtsPlayerDelegate?

    // ── Hydrated playlist cache ─────────────────────────────────────
    // After getPlaylistTracks hydrates a playlist via .with([.tracks]),
    // we stash the resulting Track array here keyed by playlist ID.
    // Subsequent playTrackInPlaylist / addPlaylistToQueue calls can
    // skip the (slow on large libraries) MusicLibraryRequest +
    // .with([.tracks]) round-trip and just use the cached objects.
    //
    // Stored as `Any` because `Track` is `@available(iOS 15.0, *)` —
    // class properties can't carry availability constraints, so we
    // erase the type and cast on use. The two helper methods below
    // contain the cast in one place.
    private var hydratedTrackCache: [String: Any] = [:]
    private var hydratedNameCache: [String: String] = [:]

    // ── Catalog song-search cache ───────────────────────────────────
    // searchCatalogSongs caches the resulting [Song] keyed by song ID
    // so addSongToPlaylist can later reach back to the actual Song
    // object without re-running MusicCatalogSearchRequest. Same `Any`
    // erasure as above for @available compatibility.
    private var catalogSongCache: [String: Any] = [:]

    @available(iOS 15.0, *)
    private func cachePlaylist(id: String, name: String, tracks: [Track]) {
        hydratedTrackCache[id] = tracks
        hydratedNameCache[id] = name
    }

    @available(iOS 15.0, *)
    private func cachedPlaylist(id: String) -> (name: String, tracks: [Track])? {
        guard let tracks = hydratedTrackCache[id] as? [Track],
              let name = hydratedNameCache[id] else {
            return nil
        }
        return (name, tracks)
    }

    // MARK: - Authorization

    @available(iOS 15.0, *)
    @objc func requestMusicKitAuthorization(_ call: CAPPluginCall) {
        Task {
            let status = await MusicAuthorization.request()
            await MainActor.run {
                call.resolve([
                    "status": Self.authStatusString(status),
                    "granted": status == .authorized,
                ])
            }
        }
    }

    @available(iOS 15.0, *)
    @objc func getMusicKitAuthorizationStatus(_ call: CAPPluginCall) {
        let status = MusicAuthorization.currentStatus
        call.resolve([
            "status": Self.authStatusString(status),
            "granted": status == .authorized,
        ])
    }

    @available(iOS 15.0, *)
    private static func authStatusString(_ s: MusicAuthorization.Status) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .denied:        return "denied"
        case .restricted:    return "restricted"
        case .authorized:    return "authorized"
        @unknown default:    return "unknown"
        }
    }

    // MARK: - Catalog search + play

    /**
     * Search Apple Music catalog and play the best match. The kind
     * parameter narrows the search:
     *   "songs"     — only songs
     *   "albums"    — only albums
     *   "artists"   — only artists (plays top songs)
     *   "playlists" — only playlists
     *   "auto"      — tries artists → albums → playlists → songs
     *                  in priority order (most user intents map to
     *                  artist or album first)
     *
     * Returns the queue type matched + first track metadata so
     * Calypso can narrate "Playing Wish You Were Here by Pink Floyd"
     * without a follow-up nowPlaying call.
     */
    @available(iOS 15.0, *)
    @objc func searchAndPlay(_ call: CAPPluginCall) {
        guard let query = call.getString("query"), !query.isEmpty else {
            call.reject("query is required")
            return
        }
        let kindArg = call.getString("kind") ?? "auto"
        NSLog("[AppleMusic] searchAndPlay query='\(query)' kind=\(kindArg)")

        Task {
            // Authorization gate — request inline if notDetermined.
            let status = MusicAuthorization.currentStatus
            if status == .notDetermined {
                let newStatus = await MusicAuthorization.request()
                if newStatus != .authorized {
                    await MainActor.run {
                        call.resolve([
                            "status": "permission_denied",
                            "auth_status": Self.authStatusString(newStatus),
                        ])
                    }
                    return
                }
            } else if status != .authorized {
                await MainActor.run {
                    call.resolve([
                        "status": "permission_denied",
                        "auth_status": Self.authStatusString(status),
                    ])
                }
                return
            }

            let kindsToTry: [String]
            switch kindArg.lowercased() {
            case "songs", "song":           kindsToTry = ["songs"]
            case "artists", "artist":       kindsToTry = ["artists"]
            case "albums", "album":         kindsToTry = ["albums"]
            case "playlists", "playlist":   kindsToTry = ["playlists"]
            default:                        kindsToTry = ["artists", "albums", "playlists", "songs"]
            }

            // Track the first error we encounter — surfaced if no kind
            // returns a match, so the JS side can tell apart "Apple
            // legitimately has no Pink Floyd" from "MusicKit auth
            // failed, the app is missing an entitlement / capability".
            var firstError: String?
            for kind in kindsToTry {
                let outcome = await self.runCatalogSearch(query: query, kind: kind)
                switch outcome {
                case .match(let result):
                    NSLog("[AppleMusic] kind=\(kind) → playing '\(result.title)'")
                    let played = await self.startPlayback(result: result)
                    await MainActor.run {
                        if played {
                            call.resolve([
                                "status": "playing",
                                "matched_kind": kind,
                                "title": result.title,
                                "subtitle": result.subtitle,
                                "first_track_title": result.firstTrackTitle,
                                "first_track_artist": result.firstTrackArtist,
                                "track_count": result.trackCount,
                            ])
                        } else {
                            call.resolve([
                                "status": "playback_failed",
                                "matched_kind": kind,
                                "title": result.title,
                            ])
                        }
                    }
                    return
                case .empty:
                    continue
                case .failed(let msg):
                    if firstError == nil { firstError = msg }
                    continue
                }
            }

            // No match in any kind. Surface the underlying error if
            // there was one — usually means the app is missing the
            // MusicKit entitlement or the user has no subscription.
            if let err = firstError {
                NSLog("[AppleMusic] catalog search '\(query)' failed: \(err)")
                await MainActor.run {
                    call.resolve([
                        "status": "playback_failed",
                        "query": query,
                        "error": err,
                    ])
                }
                return
            }
            NSLog("[AppleMusic] no MusicKit catalog match for '\(query)'")
            await MainActor.run {
                call.resolve([
                    "status": "not_found",
                    "query": query,
                ])
            }
        }
    }

    /// Outcome of a single-kind catalog search. Distinguishes "Apple
    /// has nothing matching this term" from "the request itself
    /// failed" so the caller can produce a useful error.
    @available(iOS 15.0, *)
    private enum SearchOutcome {
        case match(CatalogResult)
        case empty
        case failed(String)
    }

    /// Internal search-result envelope.
    @available(iOS 15.0, *)
    private struct CatalogResult {
        let title: String
        let subtitle: String
        let firstTrackTitle: String
        let firstTrackArtist: String
        let trackCount: Int
        let queueSource: QueueSource
    }

    @available(iOS 15.0, *)
    private enum QueueSource {
        case songs([Song])
        case album(Album)
        case playlist(Playlist)
    }

    @available(iOS 15.0, *)
    private func runCatalogSearch(query: String, kind: String) async -> SearchOutcome {
        do {
            switch kind {
            case "songs":
                var req = MusicCatalogSearchRequest(term: query, types: [Song.self])
                req.limit = 25
                let resp = try await req.response()
                guard let song = resp.songs.first else { return .empty }
                return .match(CatalogResult(
                    title: song.title,
                    subtitle: song.artistName,
                    firstTrackTitle: song.title,
                    firstTrackArtist: song.artistName,
                    trackCount: 1,
                    queueSource: .songs([song])
                ))
            case "artists":
                var req = MusicCatalogSearchRequest(term: query, types: [Artist.self])
                req.limit = 5
                let resp = try await req.response()
                guard let artist = resp.artists.first else { return .empty }
                let detailedArtist = try await artist.with([.topSongs])
                guard let topSongs = detailedArtist.topSongs, !topSongs.isEmpty else {
                    return .empty
                }
                let songsArr = Array(topSongs)
                return .match(CatalogResult(
                    title: artist.name,
                    subtitle: "\(songsArr.count) tracks",
                    firstTrackTitle: songsArr.first?.title ?? "",
                    firstTrackArtist: songsArr.first?.artistName ?? artist.name,
                    trackCount: songsArr.count,
                    queueSource: .songs(songsArr)
                ))
            case "albums":
                var req = MusicCatalogSearchRequest(term: query, types: [Album.self])
                req.limit = 5
                let resp = try await req.response()
                guard let album = resp.albums.first else { return .empty }
                let detailedAlbum = try await album.with([.tracks])
                let trackCount = detailedAlbum.tracks?.count ?? 0
                let firstTrack = detailedAlbum.tracks?.first
                return .match(CatalogResult(
                    title: album.title,
                    subtitle: album.artistName,
                    firstTrackTitle: firstTrack?.title ?? "",
                    firstTrackArtist: firstTrack?.artistName ?? album.artistName,
                    trackCount: trackCount,
                    queueSource: .album(album)
                ))
            case "playlists":
                var req = MusicCatalogSearchRequest(term: query, types: [Playlist.self])
                req.limit = 5
                let resp = try await req.response()
                guard let playlist = resp.playlists.first else { return .empty }
                let detailedPlaylist = try await playlist.with([.tracks])
                let trackCount = detailedPlaylist.tracks?.count ?? 0
                let firstTrack = detailedPlaylist.tracks?.first
                return .match(CatalogResult(
                    title: playlist.name,
                    subtitle: playlist.curatorName ?? "Apple Music",
                    firstTrackTitle: firstTrack?.title ?? "",
                    firstTrackArtist: firstTrack?.artistName ?? "",
                    trackCount: trackCount,
                    queueSource: .playlist(playlist)
                ))
            default:
                return .empty
            }
        } catch {
            let msg = String(describing: error)
            NSLog("[AppleMusic] catalog search '\(kind)' failed: \(msg)")
            return .failed(msg)
        }
    }

    @available(iOS 15.0, *)
    private func startPlayback(result: CatalogResult) async -> Bool {
        let player = ApplicationMusicPlayer.shared
        do {
            // We avoid Queue(album:) and Queue(playlist:) here — those
            // initialisers on this SDK require non-optional startingAt
            // parameters with awkward types (Track for album,
            // Playlist.Entry for playlist) and there's no clean way to
            // express "just start from the top". Instead we hydrate the
            // tracks via .with([.tracks]) and pass them through the
            // Queue(for:) sequence init, which behaves the same way for
            // playback purposes.
            switch result.queueSource {
            case .songs(let songs):
                player.queue = ApplicationMusicPlayer.Queue(for: songs)
            case .album(let album):
                let detailed = try await album.with([.tracks])
                guard let tracks = detailed.tracks, !tracks.isEmpty else {
                    NSLog("[AppleMusic] album has no tracks: \(album.title)")
                    return false
                }
                player.queue = ApplicationMusicPlayer.Queue(for: tracks)
            case .playlist(let playlist):
                let detailed = try await playlist.with([.tracks])
                guard let tracks = detailed.tracks, !tracks.isEmpty else {
                    NSLog("[AppleMusic] playlist has no tracks: \(playlist.name)")
                    return false
                }
                player.queue = ApplicationMusicPlayer.Queue(for: tracks)
            }
            try await player.prepareToPlay()
            try await player.play()
            NSLog("[AppleMusic] ApplicationMusicPlayer.play() succeeded")
            return true
        } catch {
            NSLog("[AppleMusic] startPlayback error: \(error)")
            return false
        }
    }

    // MARK: - User library

    /**
     * Return the user's MusicKit library playlists. Used by the new
     * Music page in the app: tap a playlist → play it. Each playlist
     * carries id, name, curator, track count, and an artwork URL
     * the JS side can use directly in <img> src for the cover tile.
     */
    @available(iOS 15.0, *)
    @objc func getUserPlaylists(_ call: CAPPluginCall) {
        Task {
            let status = MusicAuthorization.currentStatus
            if status == .notDetermined {
                let newStatus = await MusicAuthorization.request()
                if newStatus != .authorized {
                    await MainActor.run {
                        call.resolve([
                            "status": "permission_denied",
                            "playlists": [],
                        ])
                    }
                    return
                }
            } else if status != .authorized {
                await MainActor.run {
                    call.resolve([
                        "status": "permission_denied",
                        "playlists": [],
                    ])
                }
                return
            }

            do {
                var req = MusicLibraryRequest<Playlist>()
                req.limit = 100
                let resp = try await req.response()
                // Return playlists fast — no track hydration here. The
                // earlier "hydrate every playlist with .with([.tracks])
                // in parallel via TaskGroup" approach hung for users
                // with many playlists; MusicKit doesn't appreciate
                // dozens of concurrent track-hydration requests. The JS
                // layer fetches preview tracks per-playlist in the
                // background after the grid renders, so the page loads
                // instantly and song lists fade in as previews arrive.
                let playlists: [[String: Any]] = resp.items.map { playlist in
                    var item: [String: Any] = [
                        "id": playlist.id.rawValue,
                        "name": playlist.name,
                        "curator": playlist.curatorName ?? "",
                    ]
                    if let artwork = playlist.artwork {
                        let url = artwork.url(width: 400, height: 400)
                        item["artwork_url"] = url?.absoluteString ?? ""
                    } else {
                        item["artwork_url"] = ""
                    }
                    item["preview_tracks"] = [] as [[String: String]]
                    return item
                }
                NSLog("[AppleMusic] getUserPlaylists → \(playlists.count) playlists (fast path, no hydration)")
                await MainActor.run {
                    call.resolve([
                        "status": "ok",
                        "playlists": playlists,
                    ])
                }
            } catch {
                NSLog("[AppleMusic] getUserPlaylists failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                        "playlists": [],
                    ])
                }
            }
        }
    }

    /**
     * Play a specific library playlist by its MusicItemID. The Music
     * page tap-to-play wires through here.
     */
    @available(iOS 15.0, *)
    @objc func playPlaylist(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required")
            return
        }
        Task {
            do {
                let req = MusicLibraryRequest<Playlist>()
                let resp = try await req.response()
                guard let playlist = resp.items.first(where: { $0.id.rawValue == id }) else {
                    await MainActor.run {
                        call.resolve(["status": "not_found", "id": id])
                    }
                    return
                }
                let player = ApplicationMusicPlayer.shared
                // Same Queue(for:) workaround as startPlayback() — the
                // Queue(playlist:) init wants a non-optional
                // Playlist.Entry for startingAt: on this SDK, so we
                // hydrate the tracks first and feed them through the
                // sequence-based init.
                let detailed = try await playlist.with([.tracks])
                guard let tracks = detailed.tracks, !tracks.isEmpty else {
                    await MainActor.run {
                        call.resolve([
                            "status": "error",
                            "error": "playlist has no tracks",
                        ])
                    }
                    return
                }
                player.queue = ApplicationMusicPlayer.Queue(for: tracks)
                try await player.prepareToPlay()
                try await player.play()
                let trackCount = tracks.count
                let firstTrack = tracks.first
                await MainActor.run {
                    call.resolve([
                        "status": "playing",
                        "playlist_name": playlist.name,
                        "track_count": trackCount,
                        "first_track_title": firstTrack?.title ?? "",
                        "first_track_artist": firstTrack?.artistName ?? "",
                    ])
                }
            } catch {
                NSLog("[AppleMusic] playPlaylist failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    // MARK: - Playlist detail (track list, queue ops)

    /**
     * Return all tracks in a user-library playlist with metadata for
     * the playlist-detail bottom sheet on the Music page. Each track
     * carries its id (so we can play-from-this-track later), title,
     * artist, duration in milliseconds, and a 200x200 artwork URL.
     */
    @available(iOS 15.0, *)
    @objc func getPlaylistTracks(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required")
            return
        }
        Task {
            do {
                let req = MusicLibraryRequest<Playlist>()
                let resp = try await req.response()
                guard let playlist = resp.items.first(where: { $0.id.rawValue == id }) else {
                    await MainActor.run {
                        call.resolve(["status": "not_found", "id": id])
                    }
                    return
                }
                let detailed = try await playlist.with([.tracks])
                let tracks = detailed.tracks ?? MusicItemCollection<Track>([])
                let trackArray = Array(tracks)
                // Cache the hydrated tracks so playTrackInPlaylist /
                // addPlaylistToQueue don't have to redo the slow
                // MusicLibraryRequest + .with([.tracks]) round-trip.
                self.cachePlaylist(id: id, name: playlist.name, tracks: trackArray)
                let trackList: [[String: Any]] = trackArray.map { track in
                    var item: [String: Any] = [
                        "id": track.id.rawValue,
                        "title": track.title,
                        "artist": track.artistName,
                        "duration_ms": Int((track.duration ?? 0) * 1000),
                    ]
                    if let url = track.artwork?.url(width: 200, height: 200) {
                        item["artwork_url"] = url.absoluteString
                    } else {
                        item["artwork_url"] = ""
                    }
                    return item
                }
                await MainActor.run {
                    call.resolve([
                        "status": "ok",
                        "playlist_name": playlist.name,
                        "tracks": trackList,
                    ])
                }
            } catch {
                NSLog("[AppleMusic] getPlaylistTracks failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    /**
     * Internal helper: resolve a playlist's hydrated tracks, preferring
     * the cache populated by getPlaylistTracks. Falls back to a fresh
     * MusicLibraryRequest + .with([.tracks]) only if the cache misses.
     */
    @available(iOS 15.0, *)
    private func resolveHydrated(id: String) async throws -> (name: String, tracks: [Track])? {
        if let cached = cachedPlaylist(id: id) {
            return cached
        }
        let req = MusicLibraryRequest<Playlist>()
        let resp = try await req.response()
        guard let playlist = resp.items.first(where: { $0.id.rawValue == id }) else {
            return nil
        }
        let detailed = try await playlist.with([.tracks])
        let trackArray = Array(detailed.tracks ?? MusicItemCollection<Track>([]))
        cachePlaylist(id: id, name: playlist.name, tracks: trackArray)
        return (playlist.name, trackArray)
    }

    /**
     * Voice-controlled "play one of my library playlists by name."
     * Fuzzy-matches the query against the skipper's saved playlist
     * names — exact match wins, then full-substring, then word-overlap
     * scoring. This is the library-only counterpart to searchAndPlay
     * (which hits the catalog and currently fails without a working
     * developer token); useful for "Calypso, play my rock rotation"
     * even while catalog auth is unsettled.
     */
    @available(iOS 15.0, *)
    @objc func playLibraryPlaylist(_ call: CAPPluginCall) {
        guard let query = call.getString("query"), !query.isEmpty else {
            call.reject("query is required")
            return
        }
        Task {
            do {
                let req = MusicLibraryRequest<Playlist>()
                let resp = try await req.response()
                let lowered = query.lowercased().trimmingCharacters(in: .whitespaces)
                let queryWords = lowered
                    .split(whereSeparator: { $0.isWhitespace })
                    .map { String($0) }
                    .filter { !$0.isEmpty }

                // Score each candidate. Exact name match > full substring
                // > all-words-match > partial-words-match. Higher score
                // wins; ties go to the first one encountered.
                struct Scored {
                    let playlist: Playlist
                    let score: Int
                }
                var bestSoFar: Scored? = nil
                for playlist in resp.items {
                    let name = playlist.name.lowercased()
                    var score = 0
                    if name == lowered {
                        score = 100
                    } else if name.contains(lowered) {
                        score = 80
                    } else if !queryWords.isEmpty {
                        let matched = queryWords.filter { name.contains($0) }.count
                        if matched == queryWords.count {
                            score = 60
                        } else if matched > 0 {
                            score = matched * 10
                        }
                    }
                    if score > 0 && (bestSoFar == nil || score > bestSoFar!.score) {
                        bestSoFar = Scored(playlist: playlist, score: score)
                    }
                }

                guard let best = bestSoFar?.playlist else {
                    NSLog("[AppleMusic] playLibraryPlaylist: no match for '\(query)'")
                    await MainActor.run {
                        call.resolve(["status": "not_found", "query": query])
                    }
                    return
                }

                let detailed = try await best.with([.tracks])
                guard let tracks = detailed.tracks, !tracks.isEmpty else {
                    await MainActor.run {
                        call.resolve(["status": "empty", "playlist_name": best.name])
                    }
                    return
                }
                // Cache so a subsequent voice command (e.g. "next track")
                // doesn't have to refetch.
                let trackArray = Array(tracks)
                self.cachePlaylist(id: best.id.rawValue, name: best.name, tracks: trackArray)

                let player = ApplicationMusicPlayer.shared
                player.queue = ApplicationMusicPlayer.Queue(for: trackArray)
                try await player.prepareToPlay()
                try await player.play()
                let firstTrack = trackArray.first
                await MainActor.run {
                    call.resolve([
                        "status": "playing",
                        "playlist_name": best.name,
                        "track_count": trackArray.count,
                        "first_track_title": firstTrack?.title ?? "",
                        "first_track_artist": firstTrack?.artistName ?? "",
                    ])
                }
            } catch {
                NSLog("[AppleMusic] playLibraryPlaylist failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    /**
     * Replace the player's queue with a playlist's tracks and start
     * playing. Used by the detail sheet's "Play" button. We previously
     * also exposed a separate addPlaylistToQueue that used queue.insert
     * to append, but that path hung intermittently on iOS — replacing
     * the queue is the reliable behaviour and matches the "Play this
     * playlist" intent the skipper actually wants.
     */
    @available(iOS 15.0, *)
    @objc func addPlaylistToQueue(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required")
            return
        }
        Task {
            do {
                guard let resolved = try await resolveHydrated(id: id) else {
                    await MainActor.run {
                        call.resolve(["status": "not_found", "id": id])
                    }
                    return
                }
                guard !resolved.tracks.isEmpty else {
                    await MainActor.run {
                        call.resolve(["status": "error", "error": "playlist has no tracks"])
                    }
                    return
                }
                let player = ApplicationMusicPlayer.shared
                player.queue = ApplicationMusicPlayer.Queue(for: resolved.tracks)
                try await player.prepareToPlay()
                try await player.play()
                await MainActor.run {
                    call.resolve([
                        "status": "playing",
                        "playlist_name": resolved.name,
                        "track_count": resolved.tracks.count,
                    ])
                }
            } catch {
                NSLog("[AppleMusic] addPlaylistToQueue failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    // MARK: - Library mutations (create playlist, add tracks)

    /**
     * Create a new (empty) playlist in the skipper's library. Used by
     * the music page's "+" button and by the create_playlist voice
     * tool. Returns the new playlist's id + name so callers can
     * re-render the grid or open the detail sheet on it.
     */
    @available(iOS 16.0, *)
    @objc func createPlaylist(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), !name.isEmpty else {
            call.reject("name is required")
            return
        }
        let description = call.getString("description")
        Task {
            do {
                let playlist: Playlist
                if let description = description, !description.isEmpty {
                    playlist = try await MusicLibrary.shared.createPlaylist(
                        name: name,
                        description: description
                    )
                } else {
                    playlist = try await MusicLibrary.shared.createPlaylist(name: name)
                }
                NSLog("[AppleMusic] createPlaylist '\(name)' → \(playlist.id.rawValue)")
                await MainActor.run {
                    call.resolve([
                        "status": "ok",
                        "id": playlist.id.rawValue,
                        "name": playlist.name,
                    ])
                }
            } catch {
                NSLog("[AppleMusic] createPlaylist failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    /**
     * Add the currently-playing track to a named library playlist.
     * Fuzzy-matches the playlist name (same logic as playLibraryPlaylist)
     * so the skipper can say "save this to my passage mix" without
     * needing the exact playlist name.
     *
     * Reads the now-playing item off ApplicationMusicPlayer's queue
     * via currentEntry.item, which is an enum (Song / MusicVideo). We
     * only support adding songs — music-video adds aren't useful for
     * sailing playlists.
     */
    @available(iOS 16.0, *)
    @objc func addCurrentTrackToPlaylist(_ call: CAPPluginCall) {
        guard let playlistQuery = call.getString("playlist"), !playlistQuery.isEmpty else {
            call.reject("playlist query is required")
            return
        }
        Task {
            do {
                // Find playlist by fuzzy name
                let req = MusicLibraryRequest<Playlist>()
                let resp = try await req.response()
                let lowered = playlistQuery.lowercased().trimmingCharacters(in: .whitespaces)
                let queryWords = lowered
                    .split(whereSeparator: { $0.isWhitespace })
                    .map { String($0) }
                    .filter { !$0.isEmpty }

                var bestPlaylist: Playlist? = nil
                var bestScore = 0
                for p in resp.items {
                    let nm = p.name.lowercased()
                    var s = 0
                    if nm == lowered { s = 100 }
                    else if nm.contains(lowered) { s = 80 }
                    else if !queryWords.isEmpty {
                        let m = queryWords.filter { nm.contains($0) }.count
                        if m == queryWords.count { s = 60 }
                        else if m > 0 { s = m * 10 }
                    }
                    if s > bestScore { bestScore = s; bestPlaylist = p }
                }
                guard let playlist = bestPlaylist else {
                    await MainActor.run {
                        call.resolve(["status": "playlist_not_found", "query": playlistQuery])
                    }
                    return
                }

                // Pull current track off the player
                let player = ApplicationMusicPlayer.shared
                guard let entry = player.queue.currentEntry, let item = entry.item else {
                    await MainActor.run {
                        call.resolve(["status": "no_track_playing"])
                    }
                    return
                }

                switch item {
                case .song(let song):
                    try await MusicLibrary.shared.add(song, to: playlist)
                    NSLog("[AppleMusic] added '\(song.title)' to playlist '\(playlist.name)'")
                    // Invalidate cache for this playlist so a subsequent
                    // sheet open re-fetches the freshly-extended track list.
                    self.hydratedTrackCache.removeValue(forKey: playlist.id.rawValue)
                    self.hydratedNameCache.removeValue(forKey: playlist.id.rawValue)
                    await MainActor.run {
                        call.resolve([
                            "status": "ok",
                            "playlist_name": playlist.name,
                            "track_title": song.title,
                            "track_artist": song.artistName,
                        ])
                    }
                case .musicVideo:
                    await MainActor.run {
                        call.resolve(["status": "not_a_song"])
                    }
                @unknown default:
                    await MainActor.run {
                        call.resolve(["status": "not_a_song"])
                    }
                }
            } catch {
                NSLog("[AppleMusic] addCurrentTrackToPlaylist failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    /**
     * Search the Apple Music catalog for SONGS only — used by the
     * "add tracks to playlist" sheet. Returns metadata for each hit
     * AND caches the actual `Song` objects keyed by id, so a later
     * addSongToPlaylist call can reach the real object without
     * re-running the catalog request.
     */
    @available(iOS 15.0, *)
    @objc func searchCatalogSongs(_ call: CAPPluginCall) {
        guard let query = call.getString("query"), !query.isEmpty else {
            call.reject("query is required")
            return
        }
        let limit = call.getInt("limit") ?? 20
        Task {
            do {
                var req = MusicCatalogSearchRequest(term: query, types: [Song.self])
                req.limit = max(1, min(limit, 50))
                let resp = try await req.response()
                let songs = Array(resp.songs)
                // Cache each Song under its id for later add operations.
                for song in songs {
                    self.catalogSongCache[song.id.rawValue] = song
                }
                let payload: [[String: Any]] = songs.map { song in
                    var item: [String: Any] = [
                        "id": song.id.rawValue,
                        "title": song.title,
                        "artist": song.artistName,
                        "duration_ms": Int((song.duration ?? 0) * 1000),
                    ]
                    if let url = song.artwork?.url(width: 200, height: 200) {
                        item["artwork_url"] = url.absoluteString
                    } else {
                        item["artwork_url"] = ""
                    }
                    if let albumTitle = song.albumTitle {
                        item["album"] = albumTitle
                    }
                    return item
                }
                NSLog("[AppleMusic] searchCatalogSongs '\(query)' → \(payload.count) songs")
                await MainActor.run {
                    call.resolve([
                        "status": "ok",
                        "songs": payload,
                    ])
                }
            } catch {
                NSLog("[AppleMusic] searchCatalogSongs failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    /**
     * Add a catalog song (looked up from the cache populated by
     * searchCatalogSongs) to a library playlist. The playlist is
     * resolved by id with the same fuzzy fallback as the rest of
     * the playlist mutators — exact id match wins, refetch via
     * MusicLibraryRequest if not cached.
     */
    @available(iOS 16.0, *)
    @objc func addSongToPlaylist(_ call: CAPPluginCall) {
        guard let songId = call.getString("song_id"), !songId.isEmpty else {
            call.reject("song_id is required")
            return
        }
        guard let playlistId = call.getString("playlist_id"), !playlistId.isEmpty else {
            call.reject("playlist_id is required")
            return
        }
        Task {
            do {
                guard let song = self.catalogSongCache[songId] as? Song else {
                    await MainActor.run {
                        call.resolve([
                            "status": "song_not_in_cache",
                            "note": "Song must come from a recent searchCatalogSongs call.",
                        ])
                    }
                    return
                }
                // Find the target playlist
                let req = MusicLibraryRequest<Playlist>()
                let resp = try await req.response()
                guard let playlist = resp.items.first(where: { $0.id.rawValue == playlistId }) else {
                    await MainActor.run {
                        call.resolve(["status": "playlist_not_found", "id": playlistId])
                    }
                    return
                }
                // REST API first. The native
                // MusicLibrary.shared.add(song, to: playlist) call
                // returns success on iOS but the actual track add
                // doesn't always persist to Apple's cloud library —
                // confirmed by skipper testing where the call returned
                // "succeeded" but the song never appeared in Apple
                // Music's view of the playlist. The REST endpoint
                // /v1/me/library/playlists/{id}/tracks is the source
                // of truth: it operates directly on the user's cloud
                // library and the change is reflected everywhere
                // (Apple Music app, other devices, etc.) within
                // seconds.
                //
                // We keep native as a fallback only — if REST somehow
                // fails (network, token issue, server-side rejection),
                // we'll try the native call; if THAT also fails we
                // surface not_supported and the UI redirects to Apple
                // Music for manual add.
                do {
                    try await self.restAddSongToPlaylist(songId: songId, playlistId: playlistId)
                    NSLog("[AppleMusic] REST add '\(song.title)' → '\(playlist.name)' succeeded")
                    self.hydratedTrackCache.removeValue(forKey: playlistId)
                    self.hydratedNameCache.removeValue(forKey: playlistId)
                    await MainActor.run {
                        call.resolve([
                            "status": "ok",
                            "playlist_name": playlist.name,
                            "song_title": song.title,
                            "song_artist": song.artistName,
                            "via": "rest",
                        ])
                    }
                    return
                } catch let restError {
                    NSLog("[AppleMusic] REST add failed: \(restError) — trying native fallback")
                }

                // Native fallback. Last-resort attempt before redirect.
                do {
                    try await MusicLibrary.shared.add(song, to: playlist)
                    NSLog("[AppleMusic] native add fallback succeeded for '\(song.title)' → '\(playlist.name)'")
                    self.hydratedTrackCache.removeValue(forKey: playlistId)
                    self.hydratedNameCache.removeValue(forKey: playlistId)
                    await MainActor.run {
                        call.resolve([
                            "status": "ok",
                            "playlist_name": playlist.name,
                            "song_title": song.title,
                            "song_artist": song.artistName,
                            "via": "native_fallback",
                        ])
                    }
                    return
                } catch let nsError as NSError {
                    NSLog("[AppleMusic] native fallback also failed: \(nsError)")
                    await MainActor.run {
                        call.resolve([
                            "status": "not_supported",
                            "error": nsError.localizedDescription,
                            "song_id": songId,
                        ])
                    }
                }
            }
        }
    }

    /**
     * REST-API path for adding a catalog song to a user library
     * playlist. Used as the fallback when native MusicLibrary.add
     * throws MPErrorDomain Code 5. Hits the documented Apple Music
     * Web API endpoint with both the developer token and the music
     * user token in headers.
     *
     * Throws on any HTTP non-2xx, network failure, or token fetch
     * failure. Caller swallows + maps to a "not_supported" status.
     */
    @available(iOS 16.0, *)
    private func restAddSongToPlaylist(songId: String, playlistId: String) async throws {
        let provider = DefaultMusicTokenProvider()
        let options = MusicTokenRequestOptions()
        let devToken = try await provider.developerToken(options: options)
        let userToken = try await provider.userToken(for: devToken, options: options)

        let urlString = "https://api.music.apple.com/v1/me/library/playlists/\(playlistId)/tracks"
        guard let url = URL(string: urlString) else {
            throw NSError(domain: "AppleMusic", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "bad URL"])
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(devToken)", forHTTPHeaderField: "Authorization")
        request.setValue(userToken, forHTTPHeaderField: "Music-User-Token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload: [String: Any] = [
            "data": [["id": songId, "type": "songs"]]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "AppleMusic", code: -2,
                userInfo: [NSLocalizedDescriptionKey: "no HTTP response"])
        }
        let bodyStr = String(data: data, encoding: .utf8) ?? "<no body>"
        // Apple's "Add Tracks to a Library Playlist" endpoint
        // documents 201 Created for actual additions. Some
        // installations return 200 OK with a body that may or may
        // not indicate the action took. We log the full status +
        // body so we can tell from Xcode console what Apple's
        // saying. Anything outside 2xx is treated as an error.
        NSLog("[AppleMusic] REST POST tracks → HTTP \(http.statusCode), body: \(bodyStr)")
        if !(200...299).contains(http.statusCode) {
            throw NSError(domain: "AppleMusic", code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)", "body": bodyStr])
        }
    }

    /**
     * Stub: Apple's MusicKit Swift framework does NOT publicly expose
     * a delete method for library playlists. Library content
     * deletion is restricted to the Apple Music app (likely a
     * deliberate Apple policy decision so third-party apps can't
     * accidentally wipe a user's library). We resolve the playlist
     * by id so the JS side can show a "open Apple Music to delete
     * X" prompt with the correct name, but the actual deletion has
     * to happen in Apple's app.
     */
    @available(iOS 15.0, *)
    @objc func deletePlaylist(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required")
            return
        }
        Task {
            do {
                let req = MusicLibraryRequest<Playlist>()
                let resp = try await req.response()
                let name = resp.items.first(where: { $0.id.rawValue == id })?.name ?? ""
                NSLog("[AppleMusic] deletePlaylist requested for '\(name)' — Apple does not expose this API.")
                await MainActor.run {
                    call.resolve([
                        "status": "not_supported",
                        "playlist_name": name,
                        "note": "Apple does not expose playlist deletion to third-party apps. Open the Apple Music app to delete this playlist.",
                    ])
                }
            } catch {
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    /**
     * Play a specific track in a playlist, queuing the rest of the
     * playlist (from that track onwards) after it. Mirrors the
     * "tap-a-song-in-an-album" UX. Reads from the same hydrated
     * cache as addPlaylistToQueue so back-to-back interactions on
     * the same playlist don't re-fetch.
     */
    @available(iOS 15.0, *)
    @objc func playTrackInPlaylist(_ call: CAPPluginCall) {
        guard let playlistId = call.getString("playlist_id"), !playlistId.isEmpty else {
            call.reject("playlist_id is required")
            return
        }
        guard let trackId = call.getString("track_id"), !trackId.isEmpty else {
            call.reject("track_id is required")
            return
        }
        Task {
            do {
                guard let resolved = try await resolveHydrated(id: playlistId) else {
                    await MainActor.run {
                        call.resolve(["status": "not_found", "id": playlistId])
                    }
                    return
                }
                guard !resolved.tracks.isEmpty else {
                    await MainActor.run {
                        call.resolve(["status": "error", "error": "playlist has no tracks"])
                    }
                    return
                }
                guard let idx = resolved.tracks.firstIndex(where: { $0.id.rawValue == trackId }) else {
                    await MainActor.run {
                        call.resolve(["status": "track_not_found", "track_id": trackId])
                    }
                    return
                }
                let fromHere = Array(resolved.tracks[idx...])
                let player = ApplicationMusicPlayer.shared
                player.queue = ApplicationMusicPlayer.Queue(for: fromHere)
                try await player.prepareToPlay()
                try await player.play()
                let firstTrack = fromHere.first
                await MainActor.run {
                    call.resolve([
                        "status": "playing",
                        "title": firstTrack?.title ?? "",
                        "artist": firstTrack?.artistName ?? "",
                    ])
                }
            } catch {
                NSLog("[AppleMusic] playTrackInPlaylist failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    // MARK: - Playback control

    @available(iOS 15.0, *)
    @objc func pause(_ call: CAPPluginCall) {
        ApplicationMusicPlayer.shared.pause()
        call.resolve(["status": "paused"])
    }

    @available(iOS 15.0, *)
    @objc func resume(_ call: CAPPluginCall) {
        Task {
            do {
                try await ApplicationMusicPlayer.shared.play()
                await MainActor.run { call.resolve(["status": "playing"]) }
            } catch {
                await MainActor.run {
                    call.resolve(["status": "failed", "error": String(describing: error)])
                }
            }
        }
    }

    @available(iOS 15.0, *)
    @objc func next(_ call: CAPPluginCall) {
        Task {
            try? await ApplicationMusicPlayer.shared.skipToNextEntry()
            await MainActor.run { call.resolve(["status": "skipped"]) }
        }
    }

    @available(iOS 15.0, *)
    @objc func previous(_ call: CAPPluginCall) {
        Task {
            try? await ApplicationMusicPlayer.shared.skipToPreviousEntry()
            await MainActor.run { call.resolve(["status": "skipped"]) }
        }
    }

    @available(iOS 15.0, *)
    @objc func nowPlaying(_ call: CAPPluginCall) {
        let player = ApplicationMusicPlayer.shared
        let state = player.state
        let isPlaying = state.playbackStatus == .playing
        let entry = player.queue.currentEntry

        var title = ""
        var artist = ""
        var album = ""
        var artworkUrl = ""
        if let entry = entry {
            title = entry.title
            // Pull artwork off the queue Entry directly — it's more
            // reliably populated than the inner item's artwork,
            // especially for tracks queued from a library playlist
            // where the item may wrap differently.
            if let url = entry.artwork?.url(width: 400, height: 400) {
                artworkUrl = url.absoluteString
            }
            // Entry subtitle is typically "Artist" or "Artist — Album"
            // — use as a default artist line in case the inner item
            // doesn't surface artistName cleanly.
            artist = entry.subtitle ?? ""
            switch entry.item {
            case .song(let song):
                if !song.artistName.isEmpty {
                    artist = song.artistName
                }
                album = song.albumTitle ?? ""
                // Fall back to the song's own artwork only if the
                // entry didn't have one.
                if artworkUrl.isEmpty, let url = song.artwork?.url(width: 400, height: 400) {
                    artworkUrl = url.absoluteString
                }
            default:
                break
            }
        }

        let stateString: String
        switch state.playbackStatus {
        case .playing:      stateString = "playing"
        case .paused:       stateString = "paused"
        case .stopped:      stateString = "stopped"
        case .interrupted:  stateString = "interrupted"
        case .seekingForward, .seekingBackward: stateString = "seeking"
        @unknown default:   stateString = "unknown"
        }

        call.resolve([
            "is_playing": isPlaying,
            "state": stateString,
            "title": title,
            "artist": artist,
            "album": album,
            "artwork_url": artworkUrl,
        ])
    }

    // MARK: - TTS playback (AVAudioPlayer)

    /**
     * Native TTS playback for Calypso. Bypasses WKWebView's HTML5
     * Audio entirely (which had its own audio session quirks).
     *
     * MusicKit interaction: even with our app's session set to
     * `.playback + .mixWithOthers`, AVAudioPlayer activating the
     * session bumps `ApplicationMusicPlayer.shared` into a stopped
     * state and music never recovers. Empirically the only reliable
     * fix is to explicitly pause MusicKit before the TTS plays and
     * resume it after the AVAudioPlayer delegate fires the
     * "finished" callback. The pause/resume happens fast enough that
     * the listener perceives a brief duck rather than a stop, and
     * `ApplicationMusicPlayer.play()` on iOS 15+ is reliable
     * (unlike the legacy MPMusicPlayerController, which was a
     * coin-flip).
     */
    @available(iOS 15.0, *)
    @objc func playTtsAudio(_ call: CAPPluginCall) {
        guard let b64 = call.getString("audio_b64"), !b64.isEmpty else {
            call.reject("audio_b64 is required")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Cancel any in-flight TTS — single utterance at a time.
            if let prev = self.ttsPlayer {
                prev.stop()
                self.ttsPlayer = nil
            }
            self.ttsPlayerDelegate = nil

            guard let data = Data(base64Encoded: b64) else {
                call.reject("invalid base64 audio")
                return
            }

            // Snapshot MusicKit playback state. If music was playing,
            // pause it now so AVAudioPlayer's session-activation
            // doesn't kill it permanently. We'll resume in the
            // delegate's onFinish closure.
            let musicPlayer = ApplicationMusicPlayer.shared
            let musicStateBefore = musicPlayer.state.playbackStatus
            let musicWasPlaying = musicStateBefore == .playing
            NSLog("[AppleMusic] playTtsAudio: musicState before TTS = \(musicStateBefore), willPauseAndResume=\(musicWasPlaying)")
            if musicWasPlaying {
                musicPlayer.pause()
                NSLog("[AppleMusic] playTtsAudio: paused — state now = \(musicPlayer.state.playbackStatus)")
            }

            do {
                let player = try AVAudioPlayer(data: data)
                player.volume = 1.0
                let delegate = TtsPlayerDelegate { [weak self] in
                    let stateAtFinish = ApplicationMusicPlayer.shared.state.playbackStatus
                    NSLog("[AppleMusic] TTS finished — musicState=\(stateAtFinish), willResume=\(musicWasPlaying)")
                    DispatchQueue.main.async {
                        self?.ttsPlayer = nil
                        self?.ttsPlayerDelegate = nil
                        if musicWasPlaying {
                            // The audio session was just used by
                            // AVAudioPlayer; give iOS a beat to settle
                            // routing and re-establish our category in
                            // case AVAudioPlayer mutated it implicitly,
                            // then call play() to resume.
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                                let session = AVAudioSession.sharedInstance()
                                try? session.setCategory(
                                    .playback,
                                    mode: .default,
                                    options: [.mixWithOthers]
                                )
                                try? session.setActive(true, options: [])
                                Task { @MainActor in
                                    let preState = ApplicationMusicPlayer.shared.state.playbackStatus
                                    NSLog("[AppleMusic] resume(): preState=\(preState)")
                                    do {
                                        try await ApplicationMusicPlayer.shared.play()
                                        let postState = ApplicationMusicPlayer.shared.state.playbackStatus
                                        NSLog("[AppleMusic] resume(): postState=\(postState) — success")
                                    } catch {
                                        NSLog("[AppleMusic] resume FAILED: \(error)")
                                    }
                                }
                            }
                        }
                        call.resolve(["status": "finished"])
                    }
                }
                player.delegate = delegate
                self.ttsPlayerDelegate = delegate
                self.ttsPlayer = player
                if !player.play() {
                    call.reject("AVAudioPlayer.play() returned false")
                    self.ttsPlayer = nil
                    self.ttsPlayerDelegate = nil
                    if musicWasPlaying {
                        Task { @MainActor in
                            try? await ApplicationMusicPlayer.shared.play()
                        }
                    }
                    return
                }
                NSLog("[AppleMusic] playTtsAudio: started (\(data.count)B, \(String(format: "%.1f", player.duration))s)")
            } catch {
                NSLog("[AppleMusic] playTtsAudio: AVAudioPlayer init failed: \(error)")
                if musicWasPlaying {
                    Task { @MainActor in
                        try? await ApplicationMusicPlayer.shared.play()
                    }
                }
                call.reject("AVAudioPlayer init failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func cancelTtsAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.ttsPlayer?.stop()
            self?.ttsPlayer = nil
            self?.ttsPlayerDelegate = nil
            call.resolve(["status": "cancelled"])
        }
    }
}

/**
 * AVAudioPlayerDelegate that fires a closure when playback finishes
 * (or errors out). Used by playTtsAudio to resolve its CAPPluginCall
 * at the right moment.
 */
private final class TtsPlayerDelegate: NSObject, AVAudioPlayerDelegate {
    let onFinish: () -> Void
    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish()
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        NSLog("[AppleMusic] TtsPlayer decode error: \(String(describing: error))")
        onFinish()
    }
}
