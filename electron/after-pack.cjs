"use strict";
// electron-builder extraResources skips node_modules (it honors .gitignore,
// which lists node_modules/). Copy the tree stage.sh installed into the
// packaged resources so Linux .deb/AppImage and Windows NSIS/zip all ship it.
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const src = path.join(__dirname, "hog-app", "node_modules");
  if (!fs.existsSync(path.join(src, "ws"))) {
    throw new Error(`afterPack: ${src}/ws is missing; stage.sh should have run npm ci --omit=dev`);
  }
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  const hogApp = path.join(resources, "hog-app");
  if (!fs.existsSync(path.join(hogApp, "server.mjs"))) {
    throw new Error(`afterPack: ${hogApp}/server.mjs is missing; extraResources did not stage hog-app`);
  }
  const dest = path.join(hogApp, "node_modules");
  fs.cpSync(src, dest, { recursive: true, force: true });
  if (!fs.existsSync(path.join(dest, "ws"))) {
    throw new Error(`afterPack: ${dest}/ws is missing after copy`);
  }
  console.log(`afterPack: copied hog-app/node_modules into ${dest}`);
};
