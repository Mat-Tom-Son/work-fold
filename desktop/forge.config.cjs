const path = require("node:path");
const { cp } = require("node:fs/promises");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const identity = require("../src/shared/product-identity.json");

const root = path.resolve(__dirname, "..");

async function copyCliShimsToPackage(buildPath) {
  await cp(
    path.join(root, "desktop", "cli"),
    path.join(buildPath, "bin"),
    { recursive: true, force: true },
  );
}

module.exports = {
  packagerConfig: {
    name: identity.productName,
    executableName: identity.productName,
    icon: path.join(root, "desktop", "assets", "icon"),
    asar: true,
    ignore: [
      /^\/\.env(?:\..*)?$/,
      /^\/\.git(?:\/|$)/,
      /^\/\.github(?:\/|$)/,
      /^\/\.pi(?:\/|$)/,
      /^\/desktop(?:\/|$)/,
      /^\/dist\/web-local(?:\/|$)/,
      /^\/docs(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/package-lock\.json$/,
      /^\/scripts(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/tests(?:\/|$)/,
      /^\/tsconfig(?:\..*)?\.json$/,
      /^\/web-local(?:\/|$)/,
      /^\/AGENTS\.md$/,
      /^\/README\.md$/,
      /^\/vite\.local\.config\.ts$/,
    ],
    extraResource: [
      path.join(root, "dist", "web-local"),
      path.join(root, "desktop", "assets"),
    ],
    // The retained Forge diagnostic lane must match Electron Builder's
    // package-root bin layout; afterComplete runs after ASAR creation.
    afterComplete: [copyCliShimsToPackage],
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32"],
    },
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      // Forge 7 currently peers on @electron/fuses v1, whose wire builder names
      // eight entries. Electron 42 adds WasmTrapHandlers at index 8; the package
      // verifier below asserts that ninth fuse remains enabled.
      strictlyRequireAllFuses: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // The stock Electron package does not include a browser-specific custom
      // snapshot, so keep the optional snapshot selector off.
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};
