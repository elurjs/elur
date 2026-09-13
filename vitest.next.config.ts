import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const NEXT_REACTIVITY = fileURLToPath(
  new URL("./src/elur/next/reactivity.ts", import.meta.url),
);
const NEXT_KEYED_DIFF = fileURLToPath(
  new URL("./src/elur/next/keyed-diff.ts", import.meta.url),
);
const NEXT_HYDRATE = fileURLToPath(
  new URL("./src/elur/next/hydrate.ts", import.meta.url),
);
const NEXT_MOUNT_HELPERS = fileURLToPath(
  new URL("./src/elur/next/mount-helpers.ts", import.meta.url),
);
const NEXT_NODE_BINDING = fileURLToPath(
  new URL("./src/elur/next/node-binding.ts", import.meta.url),
);
const NEXT_DOM_WRITE = fileURLToPath(
  new URL("./src/elur/next/dom-write.ts", import.meta.url),
);
const NEXT_MOUNT = fileURLToPath(
  new URL("./src/elur/next/mount.ts", import.meta.url),
);

/**
 * Corre TODA la suite del core contra el grafo reactivo experimental
 * (`src/elur/next/reactivity.ts`), redirigiendo el módulo actual.
 *
 *   npx vitest run --config vitest.next.config.ts
 *
 * Detecta divergencias semánticas con el runtime real (bindings, stores,
 * transitions, hydration…) antes de construir el kernel de componentes
 * encima. No es CI por defecto — es un gate manual del Track R.
 */
export default defineConfig({
  plugins: [
    {
      name: "elur-swap-reactivity",
      enforce: "pre",
      resolveId(source, importer) {
        // Los archivos dentro de next/ resuelven sus siblings directamente.
        if (importer && importer.includes("/elur/next/")) return null;
        // `../elur/reactivity`, `./reactivity.js`, etc. — pero NO
        // `elur/next/reactivity` (ese ya es el módulo experimental).
        if (
          /(^|\/)reactivity(\.js|\.ts)?$/.test(source) &&
          !source.includes("next/")
        ) {
          return NEXT_REACTIVITY;
        }
        // Forks next/ de los archivos de runtime que necesitan ownership/kernel.
        if (/(^|\/)keyed-diff(\.js|\.ts)?$/.test(source)) return NEXT_KEYED_DIFF;
        if (/(^|\/)hydrate(\/index)?(\.js|\.ts)?$/.test(source)) return NEXT_HYDRATE;
        if (/(^|\/)mount-helpers(\.js|\.ts)?$/.test(source)) return NEXT_MOUNT_HELPERS;
        if (/(^|\/)node-binding(\.js|\.ts)?$/.test(source)) return NEXT_NODE_BINDING;
        if (/(^|\/)dom-write(\.js|\.ts)?$/.test(source)) return NEXT_DOM_WRITE;
        // mount() público → fork que enruta por el kernel (no confundir con
        // `elur/next/component` — el kernel).
        if (
          /(^|\/)component(\.js|\.ts)?$/.test(source) &&
          !source.includes("next/")
        ) {
          return NEXT_MOUNT;
        }
        return null;
      },
    },
  ],
  test: {
    environment: "happy-dom",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "e2e/**",
      // La suite propia del módulo next corre con el módulo real, no con alias.
      "**/next-reactivity.test.ts",
      "**/reactivity-notify-buffer.test.ts",
      "**/next2-reactivity.test.ts",
      "**/next2-component.test.ts",
      // Features Track C (T1 signals, T2 derived packs, C13 hydrate compilada)
      // solo existen en el estable y next-2 — el fork next/ quedó sin ellas.
      "**/t1-signal-bindings.test.ts",
      "**/t2-derived-pack.test.ts",
      "**/c13-compiled-hydrate.test.ts",
    ],
  },
});
