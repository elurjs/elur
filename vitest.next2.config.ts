import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const NEXT_REACTIVITY = fileURLToPath(
  new URL("./src/elur/next-2/reactivity.ts", import.meta.url),
);
const NEXT_KEYED_DIFF = fileURLToPath(
  new URL("./src/elur/next-2/keyed-diff.ts", import.meta.url),
);
const NEXT_HYDRATE = fileURLToPath(
  new URL("./src/elur/next-2/hydrate.ts", import.meta.url),
);
const NEXT_MOUNT_HELPERS = fileURLToPath(
  new URL("./src/elur/next-2/mount-helpers.ts", import.meta.url),
);
const NEXT_NODE_BINDING = fileURLToPath(
  new URL("./src/elur/next-2/node-binding.ts", import.meta.url),
);
const NEXT_DOM_WRITE = fileURLToPath(
  new URL("./src/elur/next-2/dom-write.ts", import.meta.url),
);
const NEXT_MOUNT = fileURLToPath(
  new URL("./src/elur/next-2/mount.ts", import.meta.url),
);

/**
 * Corre TODA la suite del core contra el grafo reactivo experimental
 * (`src/elur/next-2/reactivity.ts`), redirigiendo el módulo actual.
 *
 *   npx vitest run --config vitest.next2.config.ts
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
        if (importer && importer.includes("/elur/next-2/")) return null;
        // `../elur/reactivity`, `./reactivity.js`, etc. — pero NO
        // `elur/next/reactivity` (ese ya es el módulo experimental).
        if (
          /(^|\/)reactivity(\.js|\.ts)?$/.test(source) &&
          !source.includes("next/") && !source.includes("next-2/")
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
          !source.includes("next/") && !source.includes("next-2/")
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
      "**/next2-reactivity.test.ts",
      // White-box del runtime estable — next-2 no tiene notify buffer.
      "**/reactivity-notify-buffer.test.ts",
      // Los tests dedicados de next/ corren contra next/, no contra next-2/.
      "**/next-component.test.ts",
    ],
  },
});
