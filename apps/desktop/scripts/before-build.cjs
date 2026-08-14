/**
 * Desktop bundles ship precompiled renderer assets. Returning false here tells
 * electron-builder to skip the node_modules collector/install step, which
 * avoids workspace dependency graph explosions and keeps packaging
 * deterministic across environments. Packaged installers prepare the Fan
 * Agent Python payload separately through `npm run build:bundled-backend`.
 * See `electron/main.cjs::createBundledBackend`.
 */
module.exports = async function beforeBuild() {
  return false
}
