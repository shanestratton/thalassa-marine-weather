# Fresh local simulator frameworks for the isolated WKWebView UI proof.
# The input is an owned private copy of @capacitor/ios 8.5.2, never node_modules.
# This generator invokes no CocoaPods, package manager, network, build or signing.
# Framework metadata is locally generated and is not dependency provenance.
require 'json'
require 'pathname'
require 'find'
require 'digest'
require 'xcodeproj'

SOURCE_VERSION = '8.5.2'.freeze
SOURCE_FILE_COUNT = 106
# SHA256(sorted(relative_path + NUL + file_SHA256 + LF)); complete copied package.
SOURCE_SNAPSHOT_SHA256 = '857c1beede78d3d6d3fe2e7ee7423ecf0a0cc7e95a86575bfc1d9d9e23bbae4b'.freeze
CODE_INVENTORY_SHA256 = '37593bb3d8487fc0103031b6a631b9a658303875df7bcdfbc86943df2f969d40'.freeze
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TREE_BYTES = 16 * 1024 * 1024

def refuse_unless(condition)
  raise 'Refused isolated framework inputs' unless condition
end

def owned_regular(path, maximum)
  stat = File.lstat(path)
  refuse_unless(stat.file? && !stat.symlink? && stat.uid == Process.uid &&
    stat.nlink == 1 && stat.size.positive? && stat.size <= maximum &&
    (stat.mode & 0022).zero?)
  stat
end

def relative_source_files(source_root)
  files = []
  total_bytes = 0
  Find.find(source_root) do |path|
    stat = File.lstat(path)
    refuse_unless(!stat.symlink? && stat.uid == Process.uid && (stat.mode & 0022).zero?)
    relative = path.delete_prefix(source_root + '/')
    unless path == source_root
      refuse_unless(relative.split('/').length <= 8 &&
        relative.split('/').all? { |part| part.match?(/\A[A-Za-z0-9_+.-]+\z/) &&
          !%w[. ..].include?(part) })
    end
    if stat.directory?
      next
    end
    owned_regular(path, MAX_FILE_BYTES)
    files << relative
    total_bytes += stat.size
    refuse_unless(files.length <= SOURCE_FILE_COUNT && total_bytes <= MAX_TREE_BYTES)
  end
  files.sort
end

def build_info(path, name)
  # Exclusive output; these values describe this local build, not an upstream binary.
  xml = <<~XML
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>CFBundleDevelopmentRegion</key><string>en</string>
      <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
      <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
      <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
      <key>CFBundleName</key><string>#{name}</string>
      <key>CFBundlePackageType</key><string>FMWK</string>
      <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
      <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
    </dict>
    </plist>
  XML
  File.open(path, 'wx', 0600) do |file|
    file.write(xml)
    file.flush
    file.fsync
  end
end

begin
  refuse_unless(ARGV.length == 1)
  supplied_manifest = ARGV.fetch(0)
  refuse_unless(Pathname.new(supplied_manifest).absolute?)
  owned_regular(supplied_manifest, 16 * 1024)
  manifest_path = File.realpath(supplied_manifest)
  refuse_unless(manifest_path == supplied_manifest)
  manifest = JSON.parse(File.binread(manifest_path))
  refuse_unless(manifest.is_a?(Hash) && manifest.keys.sort == %w[root sourceRoot] &&
    manifest.values.all? { |value| value.is_a?(String) && Pathname.new(value).absolute? })

  root = File.realpath(manifest.fetch('root'))
  source_root = File.realpath(manifest.fetch('sourceRoot'))
  refuse_unless(root == manifest['root'] && source_root == manifest['sourceRoot'] &&
    (root.start_with?('/private/tmp/') || root.start_with?('/private/var/folders/')) &&
    File.dirname(manifest_path) == root && source_root == File.join(root, 'source'))
  root_stat = File.lstat(root)
  source_stat = File.lstat(source_root)
  refuse_unless(root_stat.directory? && !root_stat.symlink? && root_stat.uid == Process.uid &&
    (root_stat.mode & 0777) == 0700 && source_stat.directory? &&
    !source_stat.symlink? && source_stat.uid == Process.uid)
  refuse_unless((File.lstat(manifest_path).mode & 0777) == 0600)

  project_path = File.join(root, 'Frameworks.xcodeproj')
  info_paths = %w[Cordova Capacitor].to_h { |name| [name, File.join(root, "Info-#{name}.plist")] }
  refuse_unless(([project_path] + info_paths.values).none? { |path| File.exist?(path) || File.symlink?(path) })

  files = relative_source_files(source_root)
  refuse_unless(files.length == SOURCE_FILE_COUNT)
  snapshot = files.map do |relative|
    relative + "\0" + Digest::SHA256.file(File.join(source_root, relative)).hexdigest + "\n"
  end.join
  refuse_unless(Digest::SHA256.hexdigest(snapshot) == SOURCE_SNAPSHOT_SHA256)
  package = JSON.parse(File.binread(File.join(source_root, 'package.json')))
  refuse_unless(package.is_a?(Hash) && package['name'] == '@capacitor/ios' &&
    package['version'] == SOURCE_VERSION)

  capacitor_prefix = 'Capacitor/Capacitor/'
  cordova_prefix = 'CapacitorCordova/CapacitorCordova/'
  capacitor_files = files.select { |path| path.start_with?(capacitor_prefix) && path.match?(/\.(?:h|m|swift)\z/) }
  cordova_files = files.select { |path| path.start_with?(cordova_prefix) && path.match?(/\.(?:h|m)\z/) }
  code_files = (capacitor_files + cordova_files).sort
  refuse_unless(Digest::SHA256.hexdigest(code_files.join("\n") + "\n") == CODE_INVENTORY_SHA256)
  refuse_unless(capacitor_files.count { |path| path.end_with?('.swift') } == 46 &&
    capacitor_files.count { |path| path.end_with?('.m') } == 9 &&
    capacitor_files.count { |path| path.end_with?('.h') } == 9 &&
    cordova_files.count { |path| path.end_with?('.m') } == 12 &&
    cordova_files.count { |path| path.end_with?('.h') } == 18)
  required_resources = [
    capacitor_prefix + 'assets/native-bridge.js',
    capacitor_prefix + 'PrivacyInfo.xcprivacy',
    cordova_prefix + 'PrivacyInfo.xcprivacy'
  ]
  refuse_unless(required_resources.all? { |path| files.include?(path) })

  # No external source references: every source/resource path below is root-relative.
  project = Xcodeproj::Project.new(project_path)
  cordova = project.new_target(:framework, 'Cordova', :ios, '15.0')
  capacitor = project.new_target(:framework, 'Capacitor', :ios, '15.0')
  capacitor.add_dependency(cordova)
  sdk_group = project.main_group.new_group('SDK frameworks')
  sdk_frameworks = %w[Foundation UIKit WebKit].to_h do |name|
    [name, sdk_group.new_file("System/Library/Frameworks/#{name}.framework", 'SDKROOT')]
  end
  targets = { 'Cordova' => cordova, 'Capacitor' => capacitor }
  source_groups = targets.to_h { |name, _target| [name, project.main_group.new_group("#{name} copied sources")] }
  inventories = { 'Cordova' => cordova_files, 'Capacitor' => capacitor_files }

  targets.each do |name, target|
    # Replace default links with this closed SDK list; no app/pod/package targets.
    target.frameworks_build_phase.files.to_a.each(&:remove_from_project)
    sdk_frameworks.each_value { |reference| target.frameworks_build_phase.add_file_reference(reference) }
    inventories.fetch(name).each do |relative|
      reference = source_groups.fetch(name).new_file(File.join('source', relative))
      if relative.end_with?('.h')
        if name == 'Cordova'
          refuse_unless(relative == cordova_prefix + 'CapacitorCordova.h' ||
            File.dirname(relative) == cordova_prefix + 'Classes/Public')
        end
        build_file = target.headers_build_phase.add_file_reference(reference)
        # Capacitor's two excluded module-map headers remain public, as upstream.
        build_file.settings = { 'ATTRIBUTES' => ['Public'] }
      else
        target.source_build_phase.add_file_reference(reference)
      end
    end
    resources = name == 'Capacitor' ? required_resources.first(2) : required_resources.last(1)
    resources.each do |relative|
      reference = source_groups.fetch(name).new_file(File.join('source', relative))
      target.resources_build_phase.add_file_reference(reference)
    end

    module_map = name == 'Capacitor' ?
      capacitor_prefix + 'Capacitor.modulemap' : cordova_prefix + 'CapacitorCordova.modulemap'
    settings = {
      'PRODUCT_NAME' => name,
      'PRODUCT_MODULE_NAME' => name,
      'PRODUCT_BUNDLE_IDENTIFIER' => "app.thalassa.research.local-ui.#{name}",
      'CURRENT_PROJECT_VERSION' => '1',
      'MARKETING_VERSION' => SOURCE_VERSION,
      'INFOPLIST_FILE' => File.basename(info_paths.fetch(name)),
      'GENERATE_INFOPLIST_FILE' => 'NO',
      'SDKROOT' => 'iphonesimulator',
      'SUPPORTED_PLATFORMS' => 'iphonesimulator',
      'IPHONEOS_DEPLOYMENT_TARGET' => '15.0',
      'ARCHS' => 'arm64',
      'ONLY_ACTIVE_ARCH' => 'YES',
      'DEFINES_MODULE' => 'YES',
      'MODULEMAP_FILE' => File.join('source', module_map),
      'CLANG_ENABLE_MODULES' => 'YES',
      'CLANG_ENABLE_OBJC_ARC' => 'YES',
      'CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER' => 'NO',
      'SWIFT_VERSION' => '5.0',
      'SWIFT_INSTALL_OBJC_HEADER' => 'YES',
      'SWIFT_OBJC_INTERFACE_HEADER_NAME' => "#{name}-Swift.h",
      'SWIFT_OPTIMIZATION_LEVEL' => '-Onone',
      'SWIFT_COMPILATION_MODE' => 'singlefile',
      'FRAMEWORK_SEARCH_PATHS' => ['$(inherited)', '$(BUILT_PRODUCTS_DIR)'],
      'HEADER_SEARCH_PATHS' => [
        '$(inherited)',
        '$(SRCROOT)/source/Capacitor/Capacitor',
        '$(SRCROOT)/source/CapacitorCordova/CapacitorCordova',
        '$(SRCROOT)/source/CapacitorCordova/CapacitorCordova/Classes/Public'
      ],
      'OTHER_LDFLAGS' => ['$(inherited)', '-Wl,-no_adhoc_codesign'],
      'LD_DYLIB_INSTALL_NAME' => "@rpath/#{name}.framework/#{name}",
      'SYMROOT' => '$(PROJECT_DIR)/DerivedData/Build/Products',
      'OBJROOT' => '$(PROJECT_DIR)/DerivedData/Build/Intermediates.noindex',
      'CONFIGURATION_BUILD_DIR' => '$(SYMROOT)/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)',
      'CLANG_MODULE_CACHE_PATH' => '$(PROJECT_DIR)/Modules',
      'MODULE_CACHE_DIR' => '$(PROJECT_DIR)/Modules',
      'SDK_STAT_CACHE_DIR' => '$(PROJECT_DIR)/SDKStatCaches',
      'COMPILER_INDEX_STORE_ENABLE' => 'NO',
      'INDEX_ENABLE_DATA_STORE' => 'NO',
      'COMPILATION_CACHE_ENABLE_CACHING' => 'NO',
      'CODE_SIGNING_ALLOWED' => 'NO',
      'CODE_SIGNING_REQUIRED' => 'NO',
      'CODE_SIGN_IDENTITY' => '',
      'DEVELOPMENT_TEAM' => '',
      'AD_HOC_CODE_SIGNING_ALLOWED' => 'NO',
      'SUPPORTS_MACCATALYST' => 'NO',
      'SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD' => 'NO',
      'ENABLE_BITCODE' => 'NO',
      'SKIP_INSTALL' => 'YES',
      'COPY_PHASE_STRIP' => 'NO',
      'STRIP_INSTALLED_PRODUCT' => 'NO',
      'DEBUG_INFORMATION_FORMAT' => 'dwarf',
      'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES'
    }
    target.build_configurations.each { |configuration| configuration.build_settings.merge!(settings) }
  end
  capacitor.frameworks_build_phase.add_file_reference(cordova.product_reference)
  project.build_configurations.each do |configuration|
    configuration.build_settings.merge!(
      'SDKROOT' => 'iphonesimulator',
      'SUPPORTED_PLATFORMS' => 'iphonesimulator',
      'ARCHS' => 'arm64',
      'ONLY_ACTIVE_ARCH' => 'YES',
      'IPHONEOS_DEPLOYMENT_TARGET' => '15.0',
      'CODE_SIGNING_ALLOWED' => 'NO',
      'CODE_SIGNING_REQUIRED' => 'NO',
      'CODE_SIGN_IDENTITY' => '',
      'COMPILER_INDEX_STORE_ENABLE' => 'NO',
      'CLANG_MODULE_CACHE_PATH' => '$(PROJECT_DIR)/Modules'
    )
  end
  refuse_unless(project.targets.length == 2 &&
    targets.values.all? { |target| target.shell_script_build_phases.empty? } &&
    capacitor.source_build_phase.files.length == 55 && capacitor.headers_build_phase.files.length == 9 &&
    cordova.source_build_phase.files.length == 12 && cordova.headers_build_phase.files.length == 18)
  info_paths.each { |name, path| build_info(path, name) }
  project.save
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(cordova)
  scheme.add_build_target(capacitor)
  scheme.save_as(project.path, 'Capacitor', true)
  puts 'Generated isolated local simulator framework project only; no build or signing.'
rescue StandardError
  warn 'Unable to generate isolated local simulator frameworks; inputs or generation refused.'
  exit 1
end
