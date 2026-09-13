// Elur 3.7-beta: la cola DOM tipada vive en `../next-2/dom-write.ts`
// (superset: `queueDOMWrite` + `queueDomWrite(id, kind, write)` con
// dedup last-write-wins). Re-export para conservar la ruta canónica.

export * from "../next-2/dom-write.js";
