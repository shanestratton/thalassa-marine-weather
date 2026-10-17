import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/// Imports a private, bounded copy. No network URL, external filename or app storage is exposed to Files.
@objc(GribDocumentPlugin)
public final class GribDocumentPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "GribDocumentPlugin"
    public let jsName = "GribDocument"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "copyGpx", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "copyChart", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "pickChart", returnType: CAPPluginReturnPromise)]
    private static let queue = DispatchQueue(label: "thalassa.grib-import")
    private static let maximum = 32 * 1024 * 1024
    private var chartPickerCall: CAPPluginCall?

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
    @objc func pickChart(_ call: CAPPluginCall) {
        guard let consent = call.getString("rights"), ["own", "open"].contains(consent),
              let namespace = call.getString("ownerNamespace"), namespace.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
            call.reject("Confirm this is your own chart or an openly licensed chart."); return
        }
        DispatchQueue.main.async {
            guard self.chartPickerCall == nil, let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil else {
                call.reject("Close the current file picker first."); return
            }
            self.chartPickerCall = call
            // Extension/file bounds precede the private copy; JS content/hash
            // admission follows it. A UTI or filename is never licence evidence.
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = chartPickerCall else { return }
        chartPickerCall = nil
        guard urls.count == 1, let url = urls.first else { call.reject("Choose one local chart file."); return }
        copyDocument(call, gpx: false, chart: true, sourceURL: url)
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        chartPickerCall?.reject("Chart selection cancelled.")
        chartPickerCall = nil
    }
    private func copyDocument(_ call: CAPPluginCall, gpx: Bool, chart: Bool = false, sourceURL: URL? = nil) {
        let extensions = chart ? ["mbtiles", "kap", "tif", "tiff"] : (gpx ? ["gpx"] : ["grb", "grib", "grb1", "grib1", "grb2", "grib2"])
        let maximum = gpx ? 8 * 1024 * 1024 : Self.maximum
        let rootName = chart ? "chart-library" : (gpx ? "gpx-import" : "grib-import")
        // The picker URL carries its security scope; a string round-trip loses
        // that grant. Its string is bounded separately, while Open-in retains
        // the original strictly validated file-URL string fallback.
        guard let raw = sourceURL?.absoluteString ?? call.getString("url"), raw.utf8.count <= 8192,
              let source = sourceURL ?? URL(string: raw), source.isFileURL,
              source.user == nil, source.password == nil, source.query == nil, source.fragment == nil,
              source.host == nil || source.host == "" || source.host == "localhost",
              extensions.contains(source.pathExtension.lowercased()),
              let namespace = call.getString("ownerNamespace"), namespace.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
            call.reject(chart ? "Choose a local MBTiles, KAP or GeoTIFF file." : (gpx ? "Choose a local GPX attachment." : "Choose a local GRIB attachment.")); return
        }
        Self.queue.async {
            let chartDeadline = ProcessInfo.processInfo.systemUptime + 15
            let manager = FileManager.default
            let scoped = source.startAccessingSecurityScopedResource()
            defer { if scoped { source.stopAccessingSecurityScopedResource() } }
            var outcome: [String: Any]?
            var failure: Error?
            var coordination: NSError?
            var chartDestination: URL?
            NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordination) { readable in
                var pending: URL?
                do {
                    if chart && ProcessInfo.processInfo.systemUptime >= chartDeadline { throw ImportFailure.invalid }
                    if chart {
                        // Open-in is untrusted input. It must not turn this
                        // app into a deputy for another account's retained
                        // chart or the old chart cache. iOS's Inbox remains a
                        // permitted incoming attachment location.
                        let candidate = readable.standardizedFileURL.resolvingSymlinksInPath().path
                        let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: false).standardizedFileURL.resolvingSymlinksInPath().path
                        let caches = try manager.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: false).standardizedFileURL.resolvingSymlinksInPath().path
                        guard (!candidate.hasPrefix(documents + "/") || candidate.hasPrefix(documents + "/Inbox/")),
                              !candidate.hasPrefix(caches + "/") else { throw ImportFailure.invalid }
                    }
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
                    var enumerationFailure: Error?
                    // Chart capacity needs the complete existing library. Keep
                    // legacy GRIB/GPX's hidden-file/continue-on-error behavior.
                    guard let files = manager.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey], options: chart ? [] : [.skipsHiddenFiles], errorHandler: { _, error in
                        if chart {
                            if enumerationFailure == nil { enumerationFailure = error }
                            return false
                        }
                        return true
                    }) else { throw ImportFailure.invalid }
                    for case let item as URL in files {
                        if chart && ProcessInfo.processInfo.systemUptime >= chartDeadline { throw ImportFailure.invalid }
                        visited += 1
                        guard visited <= 128 else { throw ImportFailure.quota }
                        let value = try item.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
                        guard value.isSymbolicLink != true else { throw ImportFailure.invalid }
                        if value.isRegularFile == true {
                            if chart && ["index.json", "index.pending"].contains(item.lastPathComponent) {
                                guard let metadataSize = value.fileSize, metadataSize >= 0, metadataSize <= 16 * 1024 else { throw ImportFailure.quota }
                            } else {
                                if chart {
                                    guard let retainedSize = value.fileSize, retainedSize >= 0,
                                          retainedSize <= 64 * 1024 * 1024 - total else { throw ImportFailure.quota }
                                    total += retainedSize
                                    count += 1
                                } else { count += 1; total += value.fileSize ?? maximum }
                            }
                        }
                        guard count < (gpx ? 4 : 8), total + size <= (gpx ? 16 : 64) * 1024 * 1024 else { throw ImportFailure.quota }
                    }
                    if chart, let enumerationFailure = enumerationFailure { throw enumerationFailure }
                    if chart && ProcessInfo.processInfo.systemUptime >= chartDeadline { throw ImportFailure.invalid }
                    let folder = root.appendingPathComponent(namespace, isDirectory: true)
                    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
                    let folderInfo = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard folderInfo.isDirectory == true, folderInfo.isSymbolicLink != true else { throw ImportFailure.invalid }
                    let suffix = chart ? "." + source.pathExtension.lowercased() : (gpx ? ".gpx" : ".grb")
                    let filename = UUID().uuidString.lowercased() + suffix
                    let destination = folder.appendingPathComponent(filename)
                    if chart && manager.fileExists(atPath: destination.path) { throw ImportFailure.invalid }
                    if chart { chartDestination = destination }
                    pending = destination
                    guard manager.createFile(atPath: destination.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else { throw ImportFailure.invalid }
                    let input = try FileHandle(forReadingFrom: readable)
                    defer { try? input.close() }
                    let output = try FileHandle(forWritingTo: destination)
                    defer { try? output.close() }
                    var copied = 0
                    while let chunk = try input.read(upToCount: 65536), !chunk.isEmpty {
                        if chart && ProcessInfo.processInfo.systemUptime >= chartDeadline { throw ImportFailure.invalid }
                        copied += chunk.count
                        guard copied <= maximum, copied <= size else { throw ImportFailure.invalid }
                        try output.write(contentsOf: chunk)
                    }
                    guard copied == size else { throw ImportFailure.invalid }
                    outcome = ["path": "\(rootName)/\(namespace)/\(filename)", "size": copied]
                    if chart { outcome?["name"] = source.lastPathComponent }
                    pending = nil
                } catch { failure = error; if let pending = pending { try? manager.removeItem(at: pending) } }
            }
            if let result = outcome, coordination == nil, failure == nil { call.resolve(result) }
            else {
                if chart, let destination = chartDestination { try? manager.removeItem(at: destination) }
                call.reject(chart ? "The chart could not be copied, exceeds 32 MiB or saved chart storage is full." : (gpx ? "The GPX file could not be copied, exceeds 8 MiB or temporary import storage is full." : (failure as? ImportFailure == .quota ? "Saved GRIB storage is full. Remove a previous imported file before importing another." : "The local GRIB file could not be copied or exceeds 32 MiB.")))
            }
        }
    }
    private enum ImportFailure: Error, Equatable { case invalid, quota }
}
