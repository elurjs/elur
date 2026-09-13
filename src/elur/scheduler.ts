// =============================================================================
// --- F5: Scheduler de 3 niveles (Anexo §4.5) ----------------------------------
// =============================================================================
//
//   1. sync/microtask — consistencia del grafo y DOM writes: no pasa por aquí
//      (flushEffects/queueDOMWrite ya lo hacen).
//   2. `scheduler.postTask(priority)` — trabajo diferible: prefetch, islas,
//      efectos no visuales. Fallback: MessageChannel → setTimeout(0).
//   3. `scheduler.yield()` — partir trabajo largo cediendo a input/paint con
//      continuación prioritaria (al frente de la cola, no al fondo).
//
// `postTask`/`isInputPending` son Chromium-only → TODOS los entrypoints llevan
// fallback cross-browser. `requestIdleCallback` no se usa para nada urgente
// (puede no disparar bajo carga — Anexo §4.5).
// =============================================================================

export type TaskPriority = "user-blocking" | "user-visible" | "background";

interface SchedulerLike {
  postTask?(task: () => void, options?: { priority?: string }): unknown;
  yield?(): Promise<void>;
}

/**
 * `globalThis.scheduler` — lectura lazy: el objeto puede aparecer después
 * del module load (polyfills, tests) y una property read cuesta ~nada en
 * paths que ya van a una macrotask.
 */
function getScheduler(): SchedulerLike | undefined {
  return typeof globalThis === "object"
    ? (globalThis as { scheduler?: SchedulerLike }).scheduler
    : undefined;
}

/**
 * ¿Hay input del usuario esperando ser procesado? (Chromium —
 * `navigator.scheduling.isInputPending`; `false` en otros engines y fuera
 * del navegador). Discrete events only — el default correcto para decidir
 * si conviene ceder el hilo antes de seguir procesando efectos.
 */
export function inputPending(): boolean {
  const nav =
    typeof navigator === "object"
      ? (navigator as { scheduling?: { isInputPending?: () => boolean } })
      : undefined;
  return nav?.scheduling?.isInputPending?.() ?? false;
}

// --- Macrotask fiable: MessageChannel (setTimeout tiene clamping en tabs
// ocultos y tras llamadas anidadas — Anexo §4.13) -----------------------------

const _macroQueue: Array<() => void> = [];
let _macroScheduled = false;
let _channel: MessageChannel | null = null;

function enqueueMacrotask(task: () => void): void {
  _macroQueue.push(task);
  if (_macroScheduled) return;
  _macroScheduled = true;
  const drain = (): void => {
    // Flag fuera antes de correr: un push durante el drain re-agenda.
    _macroScheduled = false;
    const q = _macroQueue.splice(0);
    for (const t of q) t();
  };
  if (typeof MessageChannel === "function") {
    if (!_channel) {
      _channel = new MessageChannel();
      _channel.port1.onmessage = drain;
    }
    _channel.port2.postMessage(null);
  } else {
    setTimeout(drain, 0);
  }
}

/**
 * Cede el hilo retomando con prioridad: `scheduler.yield()` (Chrome 129+)
 * reencola la continuación AL FRENTE de la cola de tareas — mejor que
 * setTimeout(0), que va al fondo. Fallback: MessageChannel → setTimeout.
 */
export function yieldControl(): Promise<void> {
  const y = getScheduler()?.yield;
  if (y) return y.call(getScheduler());
  return new Promise<void>((resolve) => enqueueMacrotask(resolve));
}

/**
 * Agenda una tarea con prioridad real del navegador cuando existe
 * (`scheduler.postTask`); si no, mapea a la mejor primitiva disponible:
 *   - "user-blocking" → microtask (no puede esperar).
 *   - "user-visible"  → microtask (mantiene el turno, orden estable).
 *   - "background"    → macrotask (MessageChannel; no rIC — puede morir de
 *     hambre bajo carga).
 */
export function scheduleTask(
  task: () => void,
  priority: TaskPriority = "user-visible",
): void {
  const scheduler = getScheduler();
  if (scheduler?.postTask) {
    // En Chromium: prioridades reales para trabajo visible/deferible.
    scheduler.postTask(task, { priority });
    return;
  }
  if (priority === "background") enqueueMacrotask(task);
  else queueMicrotask(task);
}
