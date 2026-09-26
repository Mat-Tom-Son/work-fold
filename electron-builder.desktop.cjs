const path = require("node:path");
const identity = require("./src/shared/product-identity.json");

const root = __dirname;
const macReleaseBuild = process.env.WORKFOLD_MAC_RELEASE_BUILD === "1";
const unsignedMacBuild = process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD === "1";
const macSignIdentity = process.env.WORKFOLD_MAC_SIGN_IDENTITY?.trim();
const electronBuilderMacIdentity = macSignIdentity?.replace(/^Developer ID Application:\s*/i, "");
const macReleaseOwner = process.env.WORKFOLD_MAC_RELEASE_OWNER?.trim() || identity.sourceRepositoryOwner;
const macReleaseRepo = process.env.WORKFOLD_MAC_RELEASE_REPO?.trim() || identity.macReleaseRepositoryName;
const macFeedBuild = process.env.WORKFOLD_DESKTOP_RELEASE_PLATFORM === "darwin";
const outputDirectory = process.env.WORKFOLD_DESKTOP_OUTPUT_DIR?.trim() || "out/builder";

module.exports = {
  appId: unsignedMacBuild ? identity.macSmokeAppId : identity.productionAppId,
  productName: unsignedMacBuild ? identity.macSmokeProductName : identity.productName,
  extraMetadata: {
    workFoldBuildChannel: unsignedMacBuild ? "mac-local-smoke" : "production",
  },
  copyright: "Copyright © 2026 Mat-Tom-Son",
  artifactName: `${identity.productName}-\${version}-\${os}-\${arch}.\${ext}`,
  forceCodeSigning: macReleaseBuild || process.env.WORKFOLD_REQUIRE_CODE_SIGNING === "1",
  electronUpdaterCompatibility: ">=2.16",
  generateUpdatesFilesForAllChannels: false,
  publish: [
    {
      provider: "github",
      owner: macFeedBuild ? macReleaseOwner : identity.sourceRepositoryOwner,
      repo: macFeedBuild ? macReleaseRepo : identity.sourceRepositoryName,
      releaseType: "release",
    },
  ],
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  directories: {
    output: outputDirectory,
    buildResources: "desktop/assets",
  },
  files: ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "dist/desktop/**/*", "resources/included-tools/**/*"],
  extraFiles: [
    {
      from: "desktop/cli",
      to: "bin",
      filter: [identity.cliCommand, `${identity.cliCommand}.cmd`, `${identity.cliCommand}-cli.ps1`, `${identity.cliCommand}-cli.jxa.js`],
    },
  ],
  extraResources: [
    {
      from: "dist/web-local",
      to: "web-local",
    },
    {
      from: "desktop/assets",
      to: "assets",
    },
  ],
  afterPack: require("./scripts/sign-computer-helper.cjs"),
  asar: true,
  // Node worker entrypoints and native canvas bindings must be real files.
  // PDF.js, its fonts and other JS libraries remain in the verified archive.
  asarUnpack: ["resources/included-tools/documents/worker.mjs", "node_modules/@napi-rs/**/*.node"],
  compression: "normal",
  npmRebuild: false,
  // Supported builder toolset with a statically linked AppImage runtime.
  // It removes the host libfuse2 dependency; Chromium still needs namespaces.
  toolsets: { appimage: "1.0.3" },
  appImage: { executableArgs: [] },
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
    ],
    icon: path.join(root, "desktop", "assets", "icon.ico"),
    executableName: identity.productName,
    // A self-signed certificate is useful for personal artifact continuity but
    // is not a public trust anchor. Enable updater Authenticode enforcement only
    // after a CA-backed publisher identity has been configured and tested.
    verifyUpdateCodeSignature: process.env.WORKFOLD_TRUSTED_CODE_SIGNING === "1",
    signtoolOptions: {
      signingHashAlgorithms: ["sha256"],
      rfc3161TimeStampServer: "http://timestamp.digicert.com",
    },
  },
  linux: {
    target: [{ target: "deb", arch: ["x64"] }, { target: "rpm", arch: ["x64"] }, { target: "AppImage", arch: ["x64"] }],
    executableName: "work-fold-desktop",
    syncDesktopName: true,
    category: "Office",
    maintainer: identity.sourceRepositoryOwner,
    synopsis: "Work with AI in ordinary folders",
    // hicolor's standard theme includes 512px; a lone 1024px PNG is installed
    // into an unindexed directory and appears as a missing icon in GNOME.
    icon: path.join(root, "desktop", "assets", "icon-512.png"),
    // Linux candidates are downloadable packages until a Linux feed has passed
    // installed upgrade acceptance. Never inherit the production Mac feed.
    publish: null,
    extraFiles: [{ from: "out/included-tools/linux-cli", to: "bin" }],
    extraResources: [{ from: "out/included-tools/computer-helper", to: "computer-helper", filter: ["linux-bridge", "source.json", "LICENSE.pi-computer-use", "THIRD-PARTY-LICENSES.txt"] },
      { from: "out/included-tools/wayland-helper", to: "wayland-helper" },
      { from: "out/included-tools/chrome-native-host", to: "chrome-native-host" }],
    desktop: { entry: { StartupWMClass: "work-fold", Keywords: "AI;Assistant;Folders;" } },
  },
  deb: {
    afterInstall: "out/generated-linux-assets/after-install.sh",
    afterRemove: "out/generated-linux-assets/after-remove.sh",
    depends: ["libc6 (>= 2.39)", "libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libglib2.0-bin", "libatspi2.0-0", "libsecret-1-0", "libuuid1", "libgbm1", "libasound2",
      "libei1 (>= 1.2)", "libxkbcommon0", "libgstreamer1.0-0", "libgstreamer-plugins-base1.0-0", "gstreamer1.0-plugins-base", "gstreamer1.0-pipewire", "xdg-desktop-portal"],
    recommends: ["gnome-keyring"],
  },
  rpm: {
    afterInstall: "out/generated-linux-assets/after-install.sh",
    afterRemove: "out/generated-linux-assets/after-remove.sh",
    depends: ["glibc >= 2.39", "gtk3", "libnotify", "nss", "libXScrnSaver", "libXtst", "xdg-utils", "glib2", "at-spi2-core", "libsecret", "libuuid", "mesa-libgbm", "alsa-lib",
      "libei >= 1.2", "libxkbcommon", "gstreamer1", "gstreamer1-plugins-base", "pipewire-gstreamer", "xdg-desktop-portal"],
  },
  mac: {
    extraResources: [{ from: "out/included-tools/computer-helper", to: "computer-helper" }, { from: "out/included-tools/chrome-native-host", to: "chrome-native-host" }],
    // The afterPack hook signs this Swift app without Electron JIT entitlements.
    signIgnore: ["/computer-helper/", "/chrome-native-host/"],
    target: ["dmg", "zip"],
    icon: path.join(root, "desktop", "assets", "icon.icns"),
    category: "public.app-category.productivity",
    minimumSystemVersion: "12.0",
    darkModeSupport: true,
    executableName: unsignedMacBuild ? identity.macSmokeProductName : identity.productName,
    identity: macReleaseBuild ? electronBuilderMacIdentity : unsignedMacBuild ? "-" : undefined,
    hardenedRuntime: macReleaseBuild,
    notarize: macReleaseBuild,
    entitlements: path.join(root, "desktop", "entitlements.plist"),
    entitlementsInherit: path.join(root, "desktop", "entitlements.plist"),
  },
  dmg: {
    artifactName: `${identity.productName}-\${version}-mac-\${arch}.\${ext}`,
    title: `${identity.productName} \${version}`,
    icon: path.join(root, "desktop", "assets", "icon.icns"),
    background: path.join(root, "out", "generated-assets", "dmg-background.png"),
    iconSize: 112,
    iconTextSize: 14,
    window: {
      width: 720,
      height: 440,
    },
    contents: [
      {
        x: 180,
        y: 260,
        type: "file",
      },
      {
        x: 540,
        y: 260,
        type: "link",
        path: "/Applications",
      },
    ],
  },
  nsis: {
    include: path.join(root, "desktop", "nsis", "cli-path.nsh"),
    artifactName: `${identity.productName}-Setup-\${version}.\${ext}`,
    uninstallDisplayName: identity.productName,
    shortcutName: identity.productName,
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: "always",
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    differentialPackage: true,
  },
};
