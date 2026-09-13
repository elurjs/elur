// =============================================================================
// Elur 3.7-beta: el motor reactivo por defecto ES el grafo next-2 (push-pull
// versionado, computeds lazy, owners, glitch-free). La implementación vive en
// `./next-2/reactivity.ts` — este archivo la re-exporta para conservar las
// rutas canónicas (`./reactivity.js`, `@elurjs/core/signals`).
// La implementación clásica queda en el historial de git (≤3.6.2).
// =============================================================================

export * from "./next-2/reactivity.js";
