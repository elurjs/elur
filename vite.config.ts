import { defineConfig } from "vitest/config";

export default defineConfig({
    // History API SPA fallback:
    // - En desarrollo (`vite`):       Vite lo activa automáticamente.
    // - En producción (`vite preview`): Este bloque lo activa explícitamente.
    //
    // Si despliegas en nginx/Apache/etc., configura el servidor para que
    // responda con index.html a cualquier ruta no-archivo (ver README).
    appType: "spa",
    test: {
        environment: "happy-dom",
        // next-component.test.ts corre sólo bajo vitest.next.config.ts —
        // mezcla templates con el fork experimental `next/`.
        // reactivity-notify-buffer: white-box del motor estable (≤3.6.2) —
        // next-2 (motor por defecto desde 3.7-beta) no tiene notify buffer.
        exclude: ["e2e/**", "node_modules/**", "dist/**", "**/next-component.test.ts", "**/next2-component.test.ts", "**/reactivity-notify-buffer.test.ts"],
    },
});
