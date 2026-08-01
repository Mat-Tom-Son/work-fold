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
  files: ["package.json", "LICENSE", "dist/desktop/**/*"],
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
  asar: true,
  compression: "normal",
  npmRebuild: false,
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
  mac: {
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
