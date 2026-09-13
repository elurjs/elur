// =============================================================================
// --- next/ — cola DOM tipada (B.11) ---
// Fork de ../template/dom-write.ts: misma superficie (`queueDOMWrite`), pero la
// cola es tipada y hace last-write-wins por binding id — varios writes al mismo
// binding en un microtask sólo ejecutan el último. La API tipada
// `queueDomWrite(id, kind, write)` es la que el compiler usará para writers
// directos (C.17); `queueDOMWrite(task)` queda como compat (id = identidad del
// closure, misma deduplicación que la impl actual).
// =============================================================================

export type DomWriteKind = "text" | "attr" | "prop" | "class" | "style" | "custom";

export interface DomWrite {
  /** Identidad del binding — dos writes con el mismo id colapsan (último gana). */
  id: unknown;
  kind: DomWriteKind;
  write: () => void;
}

const _domWriteQueue = new Map<unknown, DomWrite>();
let _isDomWriteScheduled = false;

/**
 * Cola tipada: `id` identifica el binding. Si el mismo binding escribe varias
 * veces antes del flush, sólo corre la última escritura — Map.set reemplaza el
 * valor conservando la posición de inserción.
 */
export function queueDomWrite(id: unknown, kind: DomWriteKind, write: () => void): void {
  _domWriteQueue.set(id, { id, kind, write });
  _schedule();
}

/**
 * Compat con la API actual: deduplica por identidad del closure
 * (comportamiento idéntico a la impl estable).
 */
export function queueDOMWrite(task: () => void): void {
  _domWriteQueue.set(task, { id: task, kind: "custom", write: task });
  _schedule();
}

function _schedule(): void {
  if (_isDomWriteScheduled) return;
  _isDomWriteScheduled = true;
  queueMicrotask(() => {
    const items = [..._domWriteQueue.values()];
    _domWriteQueue.clear();
    _isDomWriteScheduled = false;
    for (const item of items) {
      try {
        item.write();
      } catch (e) {
        // Evitamos que un error rompa el hilo entero
        console.error(`[Elur] Error in DOM write task (${item.kind}):`, e);
      }
    }
  });
}
