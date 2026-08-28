import { defineConfig, type Plugin } from "vite";
import { resolve, dirname } from "path";
import { copyFile, mkdir, readFile } from "fs/promises";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));

// Maps each library entry key to its source module path (relative to dist/lib).
// With `preserveModules`, modules that are ALSO entry points are only emitted
// under their entry key name (e.g. `signals.js`), not under their module path
// (e.g. `elur/reactivity.js`). The tsc declarations import internal modules by
// their source path, so arethetypeswrong would fail to resolve the runtime.
// This plugin copies each entry file to its module path so the runtime layout
// matches the declarations exactly.
const ENTRY_TO_MODULE_PATH: Record<string, string> = {
    "elur": "index",
    "signals": "elur/reactivity",
    "router": "elur/router",
    "form": "elur/form",
    "store": "elur/store",
    "plugins": "elur/plugins",
    "async": "elur/async",
    "template": "elur/template/index",
    "server": "elur/server/index",
    "hydrate": "elur/hydrate/index",
    "component": "elur/component",
    "context": "elur/context",
    "lifecycle": "elur/lifecycle",
    "devtools": "elur/devtools",
};

function preserveModuleCopies(outDir: string): Plugin {
    return {
        name: "elur-preserve-module-copies",
        async closeBundle() {
            for (const [entry, modulePath] of Object.entries(ENTRY_TO_MODULE_PATH)) {
                // Copy .js and .cjs always; copy .map only if the entry
                // actually has a sourceMappingURL (Rollup doesn't emit .map
                // for pure re-export entries with preserveModules).
                for (const ext of ["js", "cjs"]) {
                    const src = resolve(outDir, `${entry}.${ext}`);
                    const dest = resolve(outDir, `${modulePath}.${ext}`);
                    await mkdir(dirname(dest), { recursive: true });
                    await copyFile(src, dest);

                    // Check if this file references a source map.
                    const content = await readFile(src, "utf8");
                    const mapMatch = content.match(/\/\/# sourceMappingURL=(.+)$/);
                    if (mapMatch) {
                        const mapExt = `${ext}.map`;
                        const mapSrc = resolve(outDir, `${entry}.${mapExt}`);
                        const mapDest = resolve(outDir, `${modulePath}.${mapExt}`);
                        try {
                            await copyFile(mapSrc, mapDest);
                        } catch (err) {
                            throw new Error(
                                `[elur] preserveModuleCopies: ${entry}.${ext} references ` +
                                `source map but ${mapSrc} is missing: ${(err as Error).message}`,
                            );
                        }
                    }
                }
            }
        },
    };
}

// ── Library build configuration ───────────────────────────────────────────────
//
//   npm run build:lib
//
// Produces:
//   dist/lib/elur.js      — ES module  (primary)
//   dist/lib/elur.cjs     — CommonJS   (legacy Node.js / bundlers)
//   dist/lib/*.d.ts         — Type declarations (generated separately by tsc)

export default defineConfig({
    // Do not copy the public/ folder into the library output
    publicDir: false,

    plugins: [preserveModuleCopies(resolve(configDir, "dist/lib"))],

    build: {
        outDir: "dist/lib",
        // vite clears the dir before building JS — tsc adds .d.ts files after
        emptyOutDir: true,
        sourcemap: true,
        // Minify with Oxc (Rolldown-native). The previous esbuild mangling
        // collided import bindings with callback parameters in shared chunks,
        // which broke SSR array rendering. Oxc does not reproduce the bug (the
        // artifact is verified by `npm run test:artifact`). Vite 8 deprecated
        // `minify: "esbuild"` in favour of Oxc.
        minify: "oxc",

        lib: {
            entry: {
                "elur": resolve("src/index.ts"),
                "signals": resolve("src/elur/reactivity.ts"),
                "router": resolve("src/elur/router.ts"),
                "form": resolve("src/elur/form.ts"),
                "store": resolve("src/elur/store.ts"),
                "plugins": resolve("src/elur/plugins.ts"),
                "async": resolve("src/elur/async.ts"),
                "template": resolve("src/elur/template/index.ts"),
                "server": resolve("src/elur/server/index.ts"),
                "hydrate": resolve("src/elur/hydrate/index.ts"),
                "component": resolve("src/elur/component.ts"),
                "context": resolve("src/elur/context.ts"),
                "lifecycle": resolve("src/elur/lifecycle.ts"),
                "devtools": resolve("src/elur/devtools.ts"),
            },
            name: "Elur",
            formats: ["es", "cjs"],
        },

        rollupOptions: {
            // Elur has zero runtime dependencies — nothing to mark external.
            external: ["node:async_hooks"],
            output: [
                {
                    // ESM output. preserveModules keeps one file per module so
                    // the runtime layout matches the tsc-emitted declarations
                    // (arethetypeswrong requires types to resolve to real
                    // runtime files) and enables per-module tree-shaking.
                    format: "es",
                    entryFileNames: "[name].js",
                    chunkFileNames: "[name].js",
                    preserveModules: true,
                },
                {
                    // CJS output
                    format: "cjs",
                    entryFileNames: "[name].cjs",
                    chunkFileNames: "[name].cjs",
                    exports: "named",
                    preserveModules: true,
                },
            ],
        },
    },
});
