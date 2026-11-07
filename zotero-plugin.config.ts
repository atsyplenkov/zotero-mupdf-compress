/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: "https://github.com/{{owner}}/{{repo}}/releases/download/release/{{updateJson}}",
  xpiDownloadLink: "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",
  build: {
    assets: [
      "addon/**/*.*",
      "addon/notices/**/*",
      "addon/native/mutool",
      "addon/native/session-lock",
    ],
    hooks: {
      "build:copyAssets": async (ctx) => {
        const target = join(ctx.dist, "addon");
        const source = join(target, "source");
        await mkdir(source, { recursive: true });
        await cp("src", join(source, "src"), { recursive: true });
        await mkdir(join(source, "typings"), { recursive: true });
        await cp("typings/global.d.ts", join(source, "typings", "global.d.ts"));
        for (const name of [
          "LICENSE",
          "package.json",
          "package-lock.json",
          "tsconfig.json",
          "zotero-plugin.config.ts",
        ]) {
          await cp(name, join(source, name));
        }
        await cp("LICENSE", join(target, "LICENSE"));
      },
    },
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },
  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },
});
