# Isolated research Xcode project. Input sources/frameworks/resources must
# already be snapshots beneath the private project root; no Pods/cap sync.
require 'json'
require 'pathname'
require 'xcodeproj'

begin
  raise 'One private manifest required' unless ARGV.length == 1
  manifest_path = File.realpath(ARGV[0])
  manifest = JSON.parse(File.read(manifest_path))
  base_keys = %w[bindingSwift bundleId moduleMap platform projectRoot sources].sort
  raise 'Unsupported generator inputs' unless manifest.keys.sort == base_keys ||
    (manifest.keys.sort == (base_keys + ['localUiFixture']).sort &&
      [true, false].include?(manifest['localUiFixture']))
  root = File.realpath(manifest.fetch('projectRoot'))
  raise 'Unexpected bundle or platform' unless manifest['bundleId'] == 'app.thalassa.research.scuttlebutt-auth' &&
    %w[iphoneos iphonesimulator].include?(manifest['platform'])
  raise 'Local UI fixture is simulator-only' if manifest['localUiFixture'] && manifest['platform'] != 'iphonesimulator'
  raise 'Manifest must be local to project' unless File.dirname(manifest_path) == root
  raise 'Private project required' unless File.stat(root).uid == Process.uid && (File.stat(root).mode & 0777) == 0700
  project_path = File.join(root, 'ScuttlebuttResearchAuth.xcodeproj')
  raise 'Never overwrite an existing project' if File.exist?(project_path)
  sources = manifest.fetch('sources')
  raise 'Bounded native sources required' unless sources.is_a?(Array) && sources.length.between?(3, 24) &&
    sources.uniq.length == sources.length
  sources.each do |name|
    raise 'Only local Swift snapshots' unless name.is_a?(String) && name.match?(/\A[A-Za-z0-9_-]+\.swift\z/) &&
      File.file?(File.join(root, 'Sources', name)) && !File.symlink?(File.join(root, 'Sources', name))
  end
  binding = manifest.fetch('bindingSwift')
  module_map = manifest.fetch('moduleMap')
  raise 'Local generated binding required' unless binding.match?(/\A[A-Za-z0-9_-]+\.swift\z/) &&
    module_map.match?(/\A[A-Za-z0-9_.-]+\.modulemap\z/) &&
    [binding, module_map].all? { |name| File.file?(File.join(root, 'Bindings', name)) }
  %w[public capacitor.config.json research-config.json config.xml Provider/libthalassa_vodozemac_native.a
     Frameworks/Capacitor.framework Frameworks/Cordova.framework].each do |name|
    raise 'Missing private project snapshot' unless File.exist?(File.join(root, name)) &&
      !File.symlink?(File.join(root, name))
  end

  project = Xcodeproj::Project.new(project_path)
  target = project.new_target(:application, 'ScuttlebuttResearchAuth', :ios, '17.0')
  native = project.main_group.new_group('Sources')
  sources.each { |name| target.source_build_phase.add_file_reference(native.new_file(File.join(root, 'Sources', name))) }
  target.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, 'Bindings', binding)))

  resources = project.main_group.new_group('Research resources')
  %w[capacitor.config.json research-config.json config.xml].each do |name|
    target.resources_build_phase.add_file_reference(resources.new_file(File.join(root, name)))
  end
  if manifest['localUiFixture']
    fixture = File.join(root, 'research-local-ui-fixture.json')
    raise 'Fixture resource missing' unless File.file?(fixture) && !File.symlink?(fixture)
    target.resources_build_phase.add_file_reference(resources.new_file(fixture))
  end
  public_ref = resources.new_file(File.join(root, 'public'))
  public_ref.last_known_file_type = 'folder'
  target.resources_build_phase.add_file_reference(public_ref)

  frameworks = project.main_group.new_group('Cached framework snapshots')
  embed = target.new_copy_files_build_phase('Embed cached Capacitor frameworks')
  embed.dst_subfolder_spec = '10'
  %w[Capacitor Cordova].each do |name|
    reference = frameworks.new_file(File.join(root, 'Frameworks', name + '.framework'))
    target.frameworks_build_phase.add_file_reference(reference)
    # No CodeSignOnCopy: this workflow never signs the application or frameworks.
    embed.add_file_reference(reference)
  end
  target.frameworks_build_phase.add_file_reference(
    frameworks.new_file(File.join(root, 'Provider', 'libthalassa_vodozemac_native.a'))
  )

  settings = {
    'PRODUCT_BUNDLE_IDENTIFIER' => manifest['bundleId'],
    'PRODUCT_NAME' => 'ScuttlebuttResearchAuth',
    'INFOPLIST_FILE' => 'Info.plist',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'SWIFT_VERSION' => '5.0',
    'SWIFT_OPTIMIZATION_LEVEL' => '-Onone',
    'SWIFT_COMPILATION_MODE' => 'singlefile',
    'SWIFT_INCLUDE_PATHS' => ['$(inherited)', '$(SRCROOT)/Bindings'],
    'HEADER_SEARCH_PATHS' => ['$(inherited)', '$(SRCROOT)/Bindings'],
    'FRAMEWORK_SEARCH_PATHS' => ['$(inherited)', '$(SRCROOT)/Frameworks'],
    'LIBRARY_SEARCH_PATHS' => ['$(inherited)', '$(SRCROOT)/Provider'],
    'OTHER_SWIFT_FLAGS' => ['$(inherited)', '-Xcc', '-fmodule-map-file=$(SRCROOT)/Bindings/' + module_map],
    'OTHER_LDFLAGS' => ['$(inherited)', '-lsqlite3', '-ObjC', '-Wl,-no_adhoc_codesign'],
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks'],
    'IPHONEOS_DEPLOYMENT_TARGET' => '17.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'SUPPORTED_PLATFORMS' => 'iphoneos iphonesimulator',
    'SUPPORTS_MACCATALYST' => 'NO',
    'SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD' => 'NO',
    'CODE_SIGNING_ALLOWED' => 'NO',
    'CODE_SIGNING_REQUIRED' => 'NO',
    'CODE_SIGN_IDENTITY' => '',
    'DEVELOPMENT_TEAM' => '',
    'AD_HOC_CODE_SIGNING_ALLOWED' => 'NO',
    'ENABLE_BITCODE' => 'NO',
    'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES',
    'COMPILER_INDEX_STORE_ENABLE' => 'NO',
    'COPY_PHASE_STRIP' => 'NO',
    'STRIP_INSTALLED_PRODUCT' => 'NO',
    'SKIP_INSTALL' => 'YES',
    'DEBUG_INFORMATION_FORMAT' => 'dwarf'
  }
  target.build_configurations.each { |config| config.build_settings.merge!(settings) }
  if manifest['localUiFixture']
    paths = %w[research.simulated.xcent research.simulated.xcent.der].map { |name| File.join(root, name) }
    raise 'Simulator link entitlements missing' unless paths.all? { |path| File.file?(path) && !File.symlink?(path) }
    target.build_configurations.each do |config|
      config.build_settings['OTHER_LDFLAGS'] += [
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements', '-Xlinker', paths[0],
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__ents_der', '-Xlinker', paths[1]
      ]
    end
  end
  project.build_configurations.each do |config|
    config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '17.0'
    config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
    config.build_settings['CLANG_MODULE_CACHE_PATH'] = '$(PROJECT_DIR)/Modules'
  end
  info = {
    'CFBundleDevelopmentRegion' => 'en',
    'CFBundleDisplayName' => 'Scuttlebutt Research',
    'CFBundleExecutable' => '$(EXECUTABLE_NAME)',
    'CFBundleIdentifier' => '$(PRODUCT_BUNDLE_IDENTIFIER)',
    'CFBundleInfoDictionaryVersion' => '6.0',
    'CFBundleName' => '$(PRODUCT_NAME)',
    'CFBundlePackageType' => 'APPL',
    'CFBundleShortVersionString' => '0.1.0',
    'CFBundleVersion' => '2',
    'LSRequiresIPhoneOS' => true,
    'UILaunchScreen' => {},
    'UIApplicationSceneManifest' => {
      'UIApplicationSupportsMultipleScenes' => false,
      'UISceneConfigurations' => {
        'UIWindowSceneSessionRoleApplication' => [{
          'UISceneConfigurationName' => 'Research Window',
          'UISceneClassName' => 'UIWindowScene',
          'UISceneDelegateClassName' => 'ResearchSceneDelegate'
        }]
      }
    },
    'UISupportedInterfaceOrientations' => %w[UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight],
    'UISupportedInterfaceOrientations~ipad' => %w[UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight]
  }
  # Deliberately no ATS exception, URL scheme, external navigation or permissions.
  Xcodeproj::Plist.write_to_path(info, File.join(root, 'Info.plist'))
  project.save
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(target)
  scheme.set_launch_target(target)
  scheme.save_as(project.path, 'ScuttlebuttResearchAuth', true)
  puts 'Generated isolated unsigned research project.'
rescue StandardError
  warn 'Unable to generate isolated research project; input/configuration refused.'
  exit 1
end
