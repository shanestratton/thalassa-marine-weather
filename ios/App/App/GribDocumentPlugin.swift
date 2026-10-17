import Foundation
import Capacitor

/// Imports a private, bounded copy. No network URL, external filename or app storage is exposed to Files.
@objc(GribDocumentPlugin)
public final class GribDocumentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GribDocumentPlugin"
    public let jsName = "GribDocument"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "copyGpx", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "copyChart", returnType: CAPPluginReturnPromise)]
    private static let queue = DispatchQueue(label: "thalassa.grib-import")
    private static let maximum = 32 * 1024 * 1024

    @objc func copy(_ call: CAPPluginCall) {
        copyDocument(call, gpx: false)
    }
    @objc func copyGpx(_ call: CAPPluginCall) {
        copyDocument(call, gpx: true)
    }
    @objc func copyChart(_ call: CAPPluginCall) {
        guard let consent = call.getString("rights"), ["own", "open"].contains(consent) else {
            call.reject("Confirm this is your own chart or an openly licensed chart."); return
        }
        copyDocument(call, gpx: false, chart: true)
    }
    private func copyDocument(_ call: CAPPluginCall, gpx: Bool, chart: Bool = false) {
        let extensions = chart ? ["mbtiles", "kap", "tif", "tiff"] : (gpx ? ["gpx"] : ["grb", "grib", "grb1", "grib1", "grb2", "grib2"])
        let maximum = gpx ? 8 * 1024 * 1024 : Self.maximum
        let rootName = chart ? "chart-library" : (gpx ? "gpx-import" : "grib-import")
        guard let raw = call.getString("url"), raw.utf8.count <= 8192,
              let source = URL(string: raw), source.isFileURL,
              source.user == nil, source.password == nil, source.query == nil, source.fragment == nil,
              source.host == nil || source.host == "" || source.host == "localhost",
              extensions.contains(source.pathExtension.lowercased()),
              let namespace = call.getString("ownerNamespace"), namespace.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
            call.reject(chart ? "Choose a local MBTiles, KAP or GeoTIFF file." : (gpx ? "Choose a local GPX attachment." : "Choose a local GRIB attachment.")); return
        }
        Self.queue.async {
            let manager = FileManager.default
            let scoped = source.startAccessingSecurityScopedResource()
            defer { if scoped { source.stopAccessingSecurityScopedResource() } }
            var outcome: [String: Any]?
            var failure: Error?
            var coordination: NSError?
            NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordination) { readable in
                var pending: URL?
                do {
                    let info = try readable.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
                    guard info.isRegularFile == true, info.isSymbolicLink != true,
                          let size = info.fileSize, size >= 8, size <= maximum else { throw ImportFailure.invalid }
                    // Capacitor Filesystem Directory.Data is Documents on iOS. File sharing stays disabled.
                    let data = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    let root = data.appendingPathComponent(rootName, isDirectory: true)
                    try manager.createDirectory(at: root, withIntermediateDirectories: true)
                    let rootInfo = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard rootInfo.isDirectory == true, rootInfo.isSymbolicLink != true else { throw ImportFailure.invalid }
                    if chart {
                        var backupRoot = root
                        var backupValues = URLResourceValues()
                        backupValues.isExcludedFromBackup = true
                        try backupRoot.setResourceValues(backupValues)
                    }
                    var total = 0, count = 0, visited = 0
                    guard let files = manager.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey], options: [.skipsHiddenFiles]) else { throw ImportFailure.invalid }
                    for case let item as URL in files {
                        visited += 1
                        guard visited <= 128 else { throw ImportFailure.quota }
                        let value = try item.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
                        guard value.isSymbolicLink != true else { throw ImportFailure.invalid }
                        if value.isRegularFile == true {
                            if chart && ["index.json", "index.pending"].contains(item.lastPathComponent) {
                                guard let metadataSize = value.fileSize, metadataSize <= 16 * 1024 else { throw ImportFailure.quota }
                            } else { count += 1; total += value.fileSize ?? maximum }
                        }
                        guard count < (gpx ? 4 : 8), total + size <= (gpx ? 16 : 64) * 1024 * 1024 else { throw ImportFailure.quota }
                    }
                    let folder = root.appendingPathComponent(namespace, isDirectory: true)
                    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
                    let folderInfo = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard folderInfo.isDirectory == true, folderInfo.isSymbolicLink != true else { throw ImportFailure.invalid }
                    let suffix = chart ? "." + source.pathExtension.lowercased() : (gpx ? ".gpx" : ".grb")
                    let filename = UUID().uuidString.lowercased() + suffix
                    let destination = folder.appendingPathComponent(filename)
                    pending = destination
                    guard manager.createFile(atPath: destination.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else { throw ImportFailure.invalid }
                    let input = try FileHandle(forReadingFrom: readable)
                    defer { try? input.close() }
                    let output = try FileHandle(forWritingTo: destination)
                    defer { try? output.close() }
                    var copied = 0
                    while let chunk = try input.read(upToCount: 65536), !chunk.isEmpty {
                        copied += chunk.count
                        guard copied <= maximum, copied <= size else { throw ImportFailure.invalid }
                        try output.write(contentsOf: chunk)
                    }
                    guard copied == size else { throw ImportFailure.invalid }
                    outcome = ["path": "\(rootName)/\(namespace)/\(filename)", "size": copied]
                    pending = nil
                } catch { failure = error; if let pending = pending { try? manager.removeItem(at: pending) } }
            }
            if let result = outcome, coordination == nil, failure == nil { call.resolve(result) }
            else { call.reject(chart ? "The chart could not be copied, exceeds 32 MiB or saved chart storage is full." : (gpx ? "The GPX file could not be copied, exceeds 8 MiB or temporary import storage is full." : (failure as? ImportFailure == .quota ? "Saved GRIB storage is full. Remove a previous imported file before importing another." : "The local GRIB file could not be copied or exceeds 32 MiB."))) }
        }
    }
    private enum ImportFailure: Error, Equatable { case invalid, quota }
}
