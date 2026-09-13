// Elur 3.7-beta: `mount` corre sobre el kernel de componentes next-2 —
// la implementación vive en `./next-2/mount.ts` (el kernel es
// `./next-2/component.ts`). Re-export para conservar la ruta canónica.

export * from "./next-2/mount.js";
