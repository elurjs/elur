/**
 * Grafo reactivo push-pull versionado — motor de Elur.
 *
 * Modelo:
 *  - PUSH: signal.set() → version++ → invalida consumidores (DIRTY directos,
 *    CHECK transitivos) y encola effects una sola vez. No recalcula nada.
 *  - PULL: antes de ejecutar un effect se estabilizan sus fuentes — los
 *    computeds DIRTY/CHECK se refrescan recursivamente y sólo propagan si el
 *    resultado realmente cambió (early cutoff por versión).
 *  - Liveness: un computed sin consumidores vivos no se suscribe a sus
 *    fuentes; se refresca por sondeo de versiones al leerse (O(1) si el
 *    epoch global no cambió).
 *  - Edges: `Link` doble-enlazado compartido entre la lista de sources del
 *    consumidor y la de consumers del productor — subscribe/remove O(1),
 *    reutilizados entre evaluaciones (mark & sweep por `evalMark`).
 */

import { inputPending, yieldControl } from "./scheduler.js";

// --- Estado reactivo compartido (contrato del engine estable) ----------------
//
// El engine clásico creaba eager `globalThis[Symbol.for("@elurjs/core/
// reactivity-state")]` y otros módulos (`lifecycle.ts` debug hooks) y paquetes
// externos (elur-kit escribe `ssr` para `isSSR()`) cuelgan campos de ese
// objeto. el motor mantiene sus internals en module-local (cada copia del paquete
// es un motor independiente), pero el objeto compartido debe existir al cargar
// el módulo — si falta, writes externos como `setSSR(true)` se pierden.

const _reactivityStateKey = Symbol.for("@elurjs/core/reactivity-state");

interface _SharedReactivityState {
  /** Modo SSR — lo escribe el consumidor (kit `renderToString`), lo lee `isSSR()`. */
  ssr?: boolean;
  [key: string]: unknown;
}

function _sharedStateDefaults(): _SharedReactivityState {
  return { ssr: false };
}

{
  const g = globalThis as Record<PropertyKey, unknown>;
  const existing = g[_reactivityStateKey] as _SharedReactivityState | undefined;
  if (existing) {
    const defaults = _sharedStateDefaults();
    for (const k of Object.keys(defaults)) {
      if (!(k in existing)) existing[k] = defaults[k];
    }
  } else {
    g[_reactivityStateKey] = _sharedStateDefaults();
  }
}

// --- Estados del grafo (B.4) ------------------------------------------------

const CLEAN = 0;
const CHECK = 1 << 0;
const DIRTY = 1 << 1;
const RUNNING = 1 << 2;
const ENQUEUED = 1 << 3;
const DISPOSED = 1 << 4;
/** B.12.1: nodo en el stack del DFS de refresh — detecta back-edges (ciclos). */
const PROBING = 1 << 5;

// --- Estado global del grafo -------------------------------------------------

let globalEpoch = 0;
let batchLevel = 0;
let activeConsumer: ConsumerNode | null = null;
/** Owner activo: los consumidores creados aquí dentro le pertenecen (B.10). */
let activeOwner: OwnerLike | null = null;
/** Flags de shape: booleans colapsados en un int (anexo §1.12 bitflags). */
const F_HAS_VALUE = 1 << 0;
const F_EVALUATED = 1 << 1;
const F_RENDER = 1 << 2;
const F_DEAD = 1 << 3;

/** Cualquier consumidor no-computed encolable al flush (effects, bindings). */
interface Flushable extends ConsumerNode {
  /** Bitflags: F_RENDER → cola de render; F_DEAD → dispuesto. */
  flags: number;
  /** B.9: gen*1024 + corridas en el flush (epoch → sin reset loop). */
  _flush: number;
  run(): void;
}

/** B.8: colas separadas — render effects (bindings DOM) antes que user effects. */
const renderQueue: Flushable[] = [];
const effectQueue: Flushable[] = [];

// --- Ownership (B.10 / A.11) --------------------------------------------------

/** Cualquier cosa que pueda poseer consumidores: Owner raíz, Effect, Computed. */
export interface OwnerLike {
  /**
   * Cabeza de la lista doblemente enlazada de hijos poseídos (effects,
   * computeds, sub-owners). Lista intrusiva — el unregistro de un hijo es
   * O(1) (antes: array con indexOf+splice O(n), que hacía el clear de
   * listas grandes O(n²) — el gap de `09_clear1k` en Krausest).
   */
  childrenHead: (Disposable & OwnerLike) | null;
  /** Número de hijos vivos — `childCount` para diagnóstico/tests. */
  childCount: number;
  /** Cleanups registrados con onCleanup() durante la última evaluación. */
  cleanups: (() => void)[] | null;
  /** Owner que era activo cuando este nodo fue creado (árbol de owners). */
  parent: OwnerLike | null;
  /** Links intrusivos al sibling anterior/siguiente en la lista del padre. */
  nextOwned: (Disposable & OwnerLike) | null;
  prevOwned: (Disposable & OwnerLike) | null;
  /**
   * A.16: boundary por owner — un consumidor sin handler propio burbujea
   * el error por la cadena de owners hasta que uno lo maneja (true).
   */
  onOwnerError?: (err: unknown) => boolean;
}

export interface Disposable {
  dispose(): void;
}

/** Raíz de ownership explícita (un mount, un test, un sub-árbol). */
export class Owner implements OwnerLike, Disposable {
  childrenHead: (Disposable & OwnerLike) | null = null;
  childCount = 0;
  cleanups: (() => void)[] | null = null;
  parent: OwnerLike | null = null;
  nextOwned: (Disposable & OwnerLike) | null = null;
  prevOwned: (Disposable & OwnerLike) | null = null;
  onOwnerError?: (err: unknown) => boolean;
  private _disposed = false;

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    disposeOwnerChildren(this);
    unown(this);
  }
}

function disposeOwnerChildren(o: OwnerLike): void {
  if (o.cleanups) {
    for (const fn of o.cleanups) fn();
    o.cleanups = null;
  }
  // Detach-first: se camina la lista con los punteros del hijo ya
  // limpiados, así unown() dentro de dispose() del hijo es no-op y no
  // muta la cadena que se está recorriendo.
  let child = o.childrenHead;
  o.childrenHead = null;
  o.childCount = 0;
  while (child) {
    const next = child.nextOwned;
    child.nextOwned = null;
    child.prevOwned = null;
    child.parent = null;
    child.dispose();
    child = next;
  }
}

function own(d: Disposable & OwnerLike): void {
  if (!activeOwner) return;
  d.parent = activeOwner;
  const head = activeOwner.childrenHead;
  d.nextOwned = head;
  d.prevOwned = null;
  if (head) head.prevOwned = d;
  activeOwner.childrenHead = d;
  activeOwner.childCount++;
}

/** Des-registrar del padre — O(1) por links intrusivos. */
function unown(d: Disposable & OwnerLike): void {
  const p = d.parent;
  d.parent = null;
  if (d.prevOwned) d.prevOwned.nextOwned = d.nextOwned;
  else if (p) p.childrenHead = d.nextOwned;
  if (d.nextOwned) d.nextOwned.prevOwned = d.prevOwned;
  d.nextOwned = null;
  d.prevOwned = null;
  if (p) p.childCount--;
}

/** Owner actual — para diagnóstico e integración con el kernel de mounts. */
export function getOwner(): OwnerLike | null {
  return activeOwner;
}

/**
 * Ejecuta fn con `owner` como dueño activo. Todo effect/computed creado
 * dentro queda poseído por él y se destruye con él.
 */
export function runWithOwner<T>(owner: OwnerLike | null, fn: () => T): T {
  const prevOwner = activeOwner;
  const prevConsumer = activeConsumer;
  activeOwner = owner;
  activeConsumer = null;
  try {
    return fn();
  } finally {
    activeOwner = prevOwner;
    activeConsumer = prevConsumer;
  }
}

/**
 * Raíz reactiva: `const dispose = createRoot(d => {...})`. Todo lo creado
 * dentro muere con `dispose()` — elimina la clase de leaks de B.2.5.
 */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const root = new Owner();
  root.parent = activeOwner;
  return runWithOwner(root, () => fn(() => root.dispose()));
}

/** Registra una limpieza en el owner activo (effect, computed o root). */
export function onCleanup(fn: () => void): void {
  if (activeOwner) (activeOwner.cleanups ??= []).push(fn);
}

/** Cap de seguridad para writes re-entrantes en effects (B.9). */
const MAX_FLUSH_STEPS = 10_000;
/** B.9: máximo de corridas de UN efecto dentro de un mismo flush. */
const MAX_RUNS_PER_FLUSH = 100;

/**
 * B.9: ciclo de efectos — un write dentro de un effect re-encola trabajo; si
 * un nodo corre más de MAX_RUNS_PER_FLUSH en el mismo flush, es un bucle.
 * El mensaje incluye el camino de dependencias del efecto (sus fuentes y,
 * si son computeds, las suyas) para localizar el ciclo.
 */
export class ReactiveCycleError extends Error {
  constructor(effect: ConsumerNode, runs: number) {
    const path: string[] = [];
    for (let l = effect.sourcesHead; l; l = l.nextSource) {
      const p = l.source;
      path.push(p instanceof Computed ? `computed(v${p.version})` : `signal(v${p.version})`);
      if (path.length >= 8) { path.push("…"); break; }
    }
    super(
      `[elur] Maximum effect re-execution depth exceeded (possible infinite loop). ` +
      `Ciclo de efectos: un effect corrió ${runs} veces en un solo flush ` +
      `(límite por nodo ${MAX_RUNS_PER_FLUSH}). Fuentes del effect: ` +
      `[${path.join(", ")}]. Probable write-inside-effect que se re-encola a sí mismo.`,
    );
    this.name = "ReactiveCycleError";
  }
}

// --- Superficie interna (paridad con reactivity.ts para el swap de tests) -----

interface ErrorHandler {
  (err: unknown): void;
}
const errorHandlerStack: ErrorHandler[] = [];
let activeErrorHandler: ErrorHandler | null = null;

/** @internal */
export function _pushErrorHandler(h: ErrorHandler): void {
  errorHandlerStack.push(activeErrorHandler as ErrorHandler);
  activeErrorHandler = h;
}

/** @internal */
export function _popErrorHandler(): void {
  activeErrorHandler = errorHandlerStack.pop() ?? null;
}

export interface _SignalDebugHooks {
  onCreate?: (signal: Signal<any>, initialValue: unknown) => void;
  onWrite?: (signal: Signal<any>, value: unknown) => void;
}

let signalDebugHooks: _SignalDebugHooks | null = null;
let signalDebugHookSet: Set<_SignalDebugHooks> | null = null;

function _syncSignalDebugHooks(): void {
  const set = signalDebugHookSet;
  if (!set || set.size === 0) {
    signalDebugHooks = null;
    return;
  }
  if (set.size === 1) {
    signalDebugHooks = set.values().next().value ?? null;
    return;
  }
  signalDebugHooks = {
    onCreate(signal, initialValue) {
      for (const hooks of set) hooks.onCreate?.(signal, initialValue);
    },
    onWrite(signal, value) {
      for (const hooks of set) hooks.onWrite?.(signal, value);
    },
  };
}

/** @internal */
export function _setSignalDebugHooks(hooks: _SignalDebugHooks | null): void {
  const set = new Set<_SignalDebugHooks>();
  if (hooks) set.add(hooks);
  signalDebugHookSet = set;
  _syncSignalDebugHooks();
}

/** @internal — añade suscriptor sin reemplazar; devuelve unsubscribe. */
export function _addSignalDebugHooks(hooks: _SignalDebugHooks): () => void {
  let set = signalDebugHookSet;
  if (!set) {
    set = new Set<_SignalDebugHooks>();
    if (signalDebugHooks) set.add(signalDebugHooks);
    signalDebugHookSet = set;
  }
  set.add(hooks);
  _syncSignalDebugHooks();
  return () => {
    set.delete(hooks);
    _syncSignalDebugHooks();
  };
}

/** @internal — la nueva impl no tiene notify buffer; se expone para paridad. */
export function _getNotifyBufSize(): number {
  return 0;
}

interface ProducerNode {
  /** Incrementa en cada cambio real de valor. */
  version: number;
  /**
   * B.12.4 (durabilidad, Salsa): producer estático — nunca cambia.
   * `link()` no crea edge: cero bookkeeping para deps estáticas.
   */
  durable?: boolean;
  /** Nº de links vivos en `consumersHead` (liveness del productor). */
  liveCount: number;
  consumersHead: Link | null;
}

/**
 * Edge compartido: vive en dos listas a la vez — la de sources del consumer
 * (`nextSource/prevSource`) y la de consumers del producer
 * (`nextTarget/prevTarget`). `mark` lo usa el consumer para decidir qué
 * links sobrevivieron a la última evaluación; `linked` indica si está
 * insertado en la lista del producer (los computeds fríos no lo están).
 */
interface Link {
  source: ProducerNode;
  target: ConsumerNode;
  seenVersion: number;
  mark: number;
  linked: boolean;
  nextSource: Link | null;
  prevSource: Link | null;
  nextTarget: Link | null;
  prevTarget: Link | null;
}

interface ConsumerNode {
  state: number;
  sourcesHead: Link | null;
  /** Contador de evaluación — marca los links usados en esta pasada. */
  evalMark: number;
  live(): boolean;
}

// --- Gestión de links ---------------------------------------------------------

// B.12.1: colas de liveness — un computed que gana/pierde su última
// suscripción se encola; el drenado ocurre en puntos seguros (link/sweep),
// nunca recursivamente (las cadenas profundas no comen call stack).
const acquireQueue: Computed<unknown>[] = [];
const releaseQueue: Computed<unknown>[] = [];

// F3: freelist de Links — las edges de bindings/effects se allocan y mueren
// en masa al montar/clear listas; reciclarlas evita el churn de GC. Un link
// sólo entra al pool cuando está muerto de verdad (fuera de AMBAS listas);
// los que quedan colgados en `sourcesHead` de un consumidor vivo (muerte del
// producer) los barre `sweep` después — nunca se poolan referencias vivas.
// `nextSource` hace de puntero de freelist. Cap: evita retener picos.
let linkPool: Link | null = null;
let linkPoolSize = 0;
const LINK_POOL_MAX = 8192;

function allocLink(
  source: ProducerNode,
  target: ConsumerNode,
  seenVersion: number,
  mark: number,
): Link {
  const l = linkPool;
  if (l) {
    linkPool = l.nextSource;
    linkPoolSize--;
    l.source = source;
    l.target = target;
    l.seenVersion = seenVersion;
    l.mark = mark;
    l.linked = false;
    l.prevSource = null;
    l.nextTarget = null;
    l.prevTarget = null;
    // `nextSource` lo fija el caller (o queda null en bindings de 1 dep).
    return l;
  }
  return {
    source, target, seenVersion, mark,
    linked: false,
    nextSource: null, prevSource: null, nextTarget: null, prevTarget: null,
  };
}

function freeLink(l: Link): void {
  if (linkPoolSize >= LINK_POOL_MAX) return;
  // Soltar refs: un link pooled no debe retener productor ni consumidor.
  l.source = null as unknown as ProducerNode;
  l.target = null as unknown as ConsumerNode;
  l.nextTarget = null;
  l.prevTarget = null;
  l.prevSource = null;
  l.nextSource = linkPool;
  linkPool = l;
  linkPoolSize++;
}

function producerAddLink(p: ProducerNode, l: Link): void {
  l.nextTarget = p.consumersHead;
  l.prevTarget = null;
  if (p.consumersHead) p.consumersHead.prevTarget = l;
  p.consumersHead = l;
  l.linked = true;
  p.liveCount++;
  // Si el producer es un computed que acaba de ganar su primer consumidor,
  // hay que suscribirlo a SUS fuentes (podía estar frío) — encolado.
  if (p.liveCount === 1 && p instanceof Computed) acquireQueue.push(p);
}

function producerRemoveLink(p: ProducerNode, l: Link): void {
  if (!l.linked) return;
  if (l.prevTarget) l.prevTarget.nextTarget = l.nextTarget;
  else p.consumersHead = l.nextTarget;
  if (l.nextTarget) l.nextTarget.prevTarget = l.prevTarget;
  l.linked = false;
  p.liveCount--;
  if (p.liveCount === 0 && p instanceof Computed) releaseQueue.push(p);
}

/** Drena adquisiciones: cada computed vivo se suscribe a sus fuentes. */
function drainAcquireQueue(): void {
  while (acquireQueue.length) {
    const cur = acquireQueue.pop()!;
    for (let l = cur.sourcesHead; l; l = l.nextSource) {
      if (!l.linked) producerAddLink(l.source, l);
    }
  }
}

/** Drena liberaciones: cada computed frío se des-suscribe de sus fuentes. */
function drainReleaseQueue(): void {
  while (releaseQueue.length) {
    const cur = releaseQueue.pop()!;
    for (let l = cur.sourcesHead; l; l = l.nextSource) {
      producerRemoveLink(l.source, l);
    }
  }
}

function link(producer: ProducerNode, consumer: ConsumerNode): void {
  // B.12.4: producers estáticos nunca invalidan — no registramos la edge.
  if (producer.durable) return;
  // Reutilizar el Link si ya existe (scan lineal — n de fuentes es típicamente
  // pequeño; el orden de deps suele ser estable entre evaluaciones).
  for (let l = consumer.sourcesHead; l; l = l.nextSource) {
    if (l.source === producer) {
      l.seenVersion = producer.version;
      l.mark = consumer.evalMark;
      return;
    }
  }
  const l = allocLink(producer, consumer, producer.version, consumer.evalMark);
  l.nextSource = consumer.sourcesHead;
  if (consumer.sourcesHead) consumer.sourcesHead.prevSource = l;
  consumer.sourcesHead = l;
  if (consumer.live()) {
    producerAddLink(producer, l);
    if (acquireQueue.length) drainAcquireQueue();
  }
}

/** Elimina los links no re-usados en la última evaluación del consumidor. */
function sweep(consumer: ConsumerNode): void {
  let l = consumer.sourcesHead;
  while (l) {
    const next = l.nextSource;
    if (l.mark !== consumer.evalMark) {
      if (l.prevSource) l.prevSource.nextSource = l.nextSource;
      else consumer.sourcesHead = l.nextSource;
      if (l.nextSource) l.nextSource.prevSource = l.prevSource;
      producerRemoveLink(l.source, l);
      freeLink(l);
    }
    l = next;
  }
  if (releaseQueue.length) drainReleaseQueue();
}

// --- Invalidación (fase push) ------------------------------------------------

/**
 * B.12.1: worklist compartida para la cascada CHECK — marcado iterativo
 * sin call stack (anexo: DFS iterativo alien-signals). Segura porque el
 * marcado no corre código de usuario: se vacía antes de retornar.
 */
const checkWorklist: Link[] = [];

function markDirty(c: ConsumerNode): void {
  if (c.state & (DIRTY | DISPOSED)) return;
  // Un computed RUNNING es un ciclo → se ignora aquí y revienta en refresh.
  // Un effect RUNNING es write-inside-effect → se re-encola (cap de flush).
  if (c instanceof Computed && c.state & RUNNING) return;
  c.state = DIRTY;
  if (c instanceof Computed) {
    // Cascada CHECK iterativa sobre el subgrafo de consumidores.
    for (let l = c.consumersHead; l; l = l.nextTarget) {
      const t = l.target;
      if (t.state === CLEAN) {
        t.state = CHECK;
        if (t instanceof Computed) checkWorklist.push(l);
        else enqueue(t as Flushable);
      }
    }
    while (checkWorklist.length) {
      const l = checkWorklist.pop()!;
      // l.target es el computed ya marcado CHECK — seguir a SUS consumidores.
      for (let u = (l.target as Computed<unknown>).consumersHead; u; u = u.nextTarget) {
        const t = u.target;
        if (t.state === CLEAN) {
          t.state = CHECK;
          if (t instanceof Computed) checkWorklist.push(u);
          else enqueue(t as Flushable);
        }
      }
    }
  } else {
    enqueue(c as Flushable);
  }
}

function invalidate(producer: ProducerNode): void {
  for (let l = producer.consumersHead; l; l = l.nextTarget) markDirty(l.target);
  if (batchLevel === 0) flushEffects();
}

// --- Estabilización (fase pull) ----------------------------------------------

/** Re-evalúa un computed: corre fn() bajo sí mismo como consumer+owner. */
function evalComputed(c: Computed<any>): void {
  // Los hijos poseídos por la pasada anterior mueren antes de re-evaluar.
  if (c.childrenHead !== null || c.cleanups !== null) disposeOwnerChildren(c);
  c.evalMark++;
  const prevConsumer = activeConsumer;
  const prevOwner = activeOwner;
  activeConsumer = c;
  activeOwner = c;
  c.state = RUNNING;
  let result: unknown;
  let threw = true;
  try {
    result = c.fn();
    threw = false;
  } finally {
    activeConsumer = prevConsumer;
    activeOwner = prevOwner;
    if (threw && c.state & RUNNING) c.state = DIRTY; // guard recuperable
  }
  sweep(c);
  c.state = CLEAN;
  c.lastCleanEpoch = globalEpoch;
  if (!(c.flags & F_HAS_VALUE) || !c.equals(result, c._value)) {
    c._value = result;
    c.flags |= F_HAS_VALUE;
    c.version++;
  }
}

// B.12.1: estado transiente del DFS vive EN el nodo (anexo: DFS manual,
// cero frames/alloc) — flags empaquetados + cursores.
// Bits extra en `state` durante el DFS (transientes — se limpian al salir).
const _P_STARTED = 1 << 6;
const _P_DIRTY = 1 << 7;
const _P_CHANGED = 1 << 8;
const _P_MASK = _P_STARTED | _P_DIRTY | _P_CHANGED;

/**
 * B.12.1: worklist del DFS de refresh — compartida sólo en llamadas no
 * anidadas; una lectura de computed dentro de una evaluación (fn() puede leer
 * otros computeds) usa un array propio para no mezclar estados.
 */
const sharedProbeStack: Computed<any>[] = [];
let probeDepth = 0;

/**
 * B.12.1: refresco iterativo (anexo: DFS manual sin call stack).
 * Post-order: las fuentes se resuelven antes que el nodo. El bit PROBING
 * marca nodos en el stack — un back-edge es un ciclo en el DAG.
 */
function refreshComputed(root: Computed<any>): void {
  // Fast path en UNA pasada: necesita DFS si alguna fuente computed no está
  // resuelta; cambio si alguna versión difiere. El orden importa: un computed
  // sin resolver puede tener versión vieja — hay que resolverlo antes de
  // comparar.
  const phase = root.state & (CHECK | DIRTY | RUNNING);
  if (root.state & DISPOSED) return;
  if (phase === RUNNING) {
    throw new Error("[elur] Ciclo reactivo detectado en computed().");
  }
  if (phase === 0 && (root.flags & F_HAS_VALUE) && (root.live() || root.lastCleanEpoch === globalEpoch)) {
    return;
  }
  let changed = phase === DIRTY || !(root.flags & F_HAS_VALUE);
  let deep = false;
  for (let l = root.sourcesHead; l; l = l.nextSource) {
    const src = l.source;
    if (
      src instanceof Computed &&
      (!(src.flags & F_HAS_VALUE) || src.state !== CLEAN ||
        (!src.live() && src.lastCleanEpoch !== globalEpoch))
    ) {
      deep = true;
      break;
    }
    if (!changed && src.version !== l.seenVersion) changed = true;
  }
  if (!deep) {
    if (changed) evalComputed(root);
    else {
      root.state = CLEAN;
      root.lastCleanEpoch = globalEpoch;
      for (let l = root.sourcesHead; l; l = l.nextSource) {
        l.seenVersion = l.source.version;
      }
    }
    return;
  }
  const stack: Computed<any>[] = probeDepth++ === 0 ? sharedProbeStack : [];
  try {
    let cur: Computed<any> | undefined = root;
    while (cur) {
      if (!(cur.state & _P_STARTED)) {
        // Primera visita: decidir según la fase baja del estado.
        cur.state |= _P_STARTED;
        cur._pCursor = null;
        cur._pLink = null;
        const phase = cur.state & (CHECK | DIRTY | RUNNING);
        if (cur.state & DISPOSED) { cur.state &= ~PROBING; cur.state &= ~_P_MASK; cur = stack.pop(); continue; }
        if (phase === RUNNING) failCycle(stack, cur);
        if (
          phase === 0 &&
          (cur.flags & F_HAS_VALUE) &&
          (cur.live() || cur.lastCleanEpoch === globalEpoch)
        ) {
          // CLEAN, fresco y con valor — nada que hacer.
          cur.state &= ~_P_MASK;
          cur = stack.pop();
          continue;
        }
        // CHECK/DIRTY, o CLEAN frío con epoch vieja: SIEMPRE descender por las
        // fuentes primero — si evaluáramos un DIRTY directo, su fn() leería
        // el getter de la fuente sin resolver y la recursión volvería por la
        // puerta de atrás (el bug de las cadenas profundas).
        cur.state |= PROBING;
        if (phase === DIRTY) cur.state |= _P_DIRTY;
        cur._pCursor = cur.sourcesHead;
      }
      // Resume tras un descend: chequear el link cuya fuente se resolvió.
      if (cur._pLink) {
        const l = cur._pLink;
        cur._pLink = null;
        if (l.source.version !== l.seenVersion) cur.state |= _P_CHANGED;
      }
      // Avanzar el cursor de fuentes.
      let descended = false;
      while (cur._pCursor) {
        const l = cur._pCursor;
        cur._pCursor = l.nextSource;
        const src = l.source;
        if (
          src instanceof Computed &&
          (!(src.flags & F_HAS_VALUE) || src.state !== CLEAN ||
            (!src.live() && src.lastCleanEpoch !== globalEpoch))
        ) {
          if (src.state & PROBING) failCycle(stack, cur); // back-edge = ciclo
          cur._pLink = l;
          stack.push(cur);
          src.state |= PROBING;
          cur = src;
          descended = true;
          break;
        }
        if (src.version !== l.seenVersion) cur.state |= _P_CHANGED;
      }
      if (descended) continue;
      // Fuentes resueltas.
      cur.state &= ~PROBING;
      if (cur.state & (_P_DIRTY | _P_CHANGED) || !(cur.flags & F_HAS_VALUE)) {
        evalComputed(cur);
      } else {
        cur.state = CLEAN;
        cur.lastCleanEpoch = globalEpoch;
        // Baselines frescas para futuros sondeos (pollCold).
        for (let l = cur.sourcesHead; l; l = l.nextSource) {
          l.seenVersion = l.source.version;
        }
      }
      cur.state &= ~_P_MASK;
      cur._pCursor = null;
      cur._pLink = null;
      cur = stack.pop();
    }
  } finally {
    probeDepth--;
  }
}

function failCycle(stack: Computed<any>[], cur: Computed<any>): never {
  // Limpiar PROBING + transientes en todos los nodos vivos antes de lanzar.
  for (const n of stack) {
    n.state &= ~(PROBING | _P_MASK);
    n._pCursor = null;
    n._pLink = null;
  }
  cur.state &= ~(PROBING | _P_MASK);
  stack.length = 0;
  throw new Error("[elur] Ciclo reactivo detectado en computed().");
}

/** Asegura que un computed esté fresco: pull si dirty, sondeo si frío. */
function ensureFreshComputed(c: Computed<any>): void {
  if (c.state !== CLEAN || (!c.live() && c.lastCleanEpoch !== globalEpoch)) {
    refreshComputed(c);
  }
}

/** Estabiliza las fuentes de un consumidor; true si algo cambió de verdad. */
function stabilize(consumer: ConsumerNode): boolean {
  let changed = false;
  for (let l = consumer.sourcesHead; l; l = l.nextSource) {
    if (l.source instanceof Computed) ensureFreshComputed(l.source);
    if (l.source.version !== l.seenVersion) changed = true;
  }
  return changed;
}

// --- Effects ------------------------------------------------------------------

function enqueue(e: Flushable): void {
  if (e.state & (ENQUEUED | DISPOSED)) return;
  e.state |= ENQUEUED;
  ((e.flags & F_RENDER) ? renderQueue : effectQueue).push(e);
}

let flushing = false;
/** B.9: id del flush en curso — los contadores por nodo expiran por epoch. */
let flushGeneration = 0;

// F5: cursores/steps a nivel módulo — el flush puede ceder el hilo cuando hay
// input pendiente y la continuación retoma las colas en el mismo orden.
let renderCursor = 0;
let effectCursor = 0;
let flushSteps = 0;
/** Pasos desde el último yield — cada continuación trabaja un tramo completo
 * antes de volver a ceder (si no, con input sostenido el flush haría
 * yield→continue→yield sin avanzar hasta el cap de pasos). */
let stepsSinceYield = 0;
let flushContinuationScheduled = false;
/** Pasos de user-queue antes de considerar ceder el hilo a input pendiente. */
const FLUSH_YIELD_STEPS = 256;

const clearQueues = (): void => {
  renderQueue.length = 0;
  effectQueue.length = 0;
  renderCursor = 0;
  effectCursor = 0;
};

/** Cierra el epoch del flush exactamente una vez (sync o tras el último yield). */
function finishFlush(): void {
  flushGeneration++; // los stamps viejos expiran solos — sin reset
  flushing = false;
}

function flushLoop(): void {
  while (renderCursor < renderQueue.length || effectCursor < effectQueue.length) {
    if (++flushSteps > MAX_FLUSH_STEPS) {
      clearQueues();
      throw new Error(
        "[elur] Maximum effect re-execution depth exceeded (possible infinite loop)."
      );
    }
    // F5: una vez drenada la cola de render, si quedan muchos USER effects y
    // hay input del usuario esperando, cedemos el hilo — la continuación
    // retoma la cola en orden (scheduler.yield → al frente, no al fondo).
    // Los render writes NUNCA ceden: feedback visual en el mismo turno (INP).
    stepsSinceYield++;
    if (
      renderCursor >= renderQueue.length &&
      effectCursor < effectQueue.length &&
      stepsSinceYield > FLUSH_YIELD_STEPS &&
      inputPending()
    ) {
      scheduleFlushContinuation();
      return;
    }
    // Orden B.8: render effects primero, luego user effects.
    const e = renderCursor < renderQueue.length
      ? renderQueue[renderCursor++]
      : effectQueue[effectCursor++];
    e.state &= ~ENQUEUED;
    if (e.state & DISPOSED) continue;
    // Fast-path DIRTY: una fuente directa escribió → el cambio es real por
    // construcción; los computeds CHECK se refrescan lazy en el getter.
    // Sólo los effects CHECK (invalidados vía computed) necesitan stabilize()
    // para el early-cutoff de falsas alarmas.
    if (e.state !== DIRTY && !stabilize(e)) {
      e.state = CLEAN;
      continue;
    }
    // B.9: contador por nodo por flush (epoch stamp — sin reset loop) —
    // identifica el efecto exacto del ciclo.
    const gen = Math.floor(e._flush / 1024);
    const runs = (gen === flushGeneration ? e._flush - gen * 1024 : 0) + 1;
    e._flush = flushGeneration * 1024 + runs;
    if (runs > MAX_RUNS_PER_FLUSH) {
      clearQueues();
      throw new ReactiveCycleError(e, runs);
    }
    e.run();
  }
  clearQueues();
}

function scheduleFlushContinuation(): void {
  if (flushContinuationScheduled) return;
  flushContinuationScheduled = true;
  void yieldControl().then(() => {
    flushContinuationScheduled = false;
    stepsSinceYield = 0; // nuevo tramo — trabaja antes de volver a ceder
    try {
      flushLoop();
    } catch (err) {
      finishFlush();
      // El error ya no puede lanzar sync al caller — misma visibilidad que
      // una excepción de efecto async: uncaught error.
      queueMicrotask(() => {
        throw err;
      });
      return;
    }
    if (!flushContinuationScheduled) finishFlush();
  });
}

function flushEffects(): void {
  // Re-entrante: si un write dentro de un effect encola más trabajo, lo
  // procesa el MISMO bucle (o la continuación ya agendada tras un yield) —
  // así el cap MAX_FLUSH_STEPS sí protege contra bucles de writes (antes
  // cada flush anidado tenía su propio contador y el bucle reventaba por
  // stack overflow en vez de por el guard).
  if (flushing) return;
  flushing = true;
  flushSteps = 0;
  stepsSinceYield = 0;
  try {
    flushLoop();
  } catch (err) {
    finishFlush();
    throw err;
  }
  // Si el loop cedió, `flushing` sigue true durante el gap — writes reentrantes
  // encolan sin arrancar otro flush y la continuación los drena en orden.
  if (!flushContinuationScheduled) finishFlush();
}

// --- API -----------------------------------------------------------------------

export class Signal<T> implements ProducerNode {
  version = 0;
  liveCount = 0;
  durable = false;
  consumersHead: Link | null = null;
  private _v: T;

  constructor(initialValue: T) {
    this._v = initialValue;
    signalDebugHooks?.onCreate?.(this, initialValue);
  }

  get value(): T {
    if (activeConsumer) link(this, activeConsumer);
    return this._v;
  }

  set value(newValue: T) {
    if (this.durable) {
      console.warn("[elur] constSignal: write ignorada — el producer es estático (B.12.4).");
      return;
    }
    if (Object.is(this._v, newValue)) return;
    this._v = newValue;
    signalDebugHooks?.onWrite?.(this, newValue);
    this.version++;
    globalEpoch++;
    invalidate(this);
  }

  update(fn: (current: T) => T): void {
    this.value = fn(this._v);
  }

  peek(): T {
    return this._v;
  }

  dispose(): void {
    while (this.consumersHead) {
      const l = this.consumersHead;
      producerRemoveLink(this, l);
      // También quitar el link de la lista de sources del consumidor.
      if (l.prevSource) l.prevSource.nextSource = l.nextSource;
      else l.target.sourcesHead = l.nextSource;
      if (l.nextSource) l.nextSource.prevSource = l.prevSource;
      freeLink(l); // muerto de verdad: fuera de las dos listas
    }
    drainReleaseQueue();
  }
}

// Computed extiende Signal por paridad con la impl actual: el resto del
// runtime (store, watch, templates) hace `x instanceof Signal`.
export class Computed<T> extends Signal<T> implements ConsumerNode, OwnerLike {
  state: number = CLEAN;
  sourcesHead: Link | null = null;
  evalMark = 0;
  /** Último epoch en que se verificó fresco — sondeo O(1) para fríos. */
  lastCleanEpoch = -1;
  childrenHead: (Disposable & OwnerLike) | null = null;
  childCount = 0;
  nextOwned: (Disposable & OwnerLike) | null = null;
  prevOwned: (Disposable & OwnerLike) | null = null;
  cleanups: (() => void)[] | null = null;
  parent: OwnerLike | null = null;
  _value: T | undefined;
  fn: () => T;
  equals: (a: T, b: T) => boolean;
  flags = 0;
  /** B.12.1: transientes del DFS de refresh (null entre refreshes). */
  _pCursor: Link | null = null;
  _pLink: Link | null = null;

  constructor(fn: () => T, equals: (a: T, b: T) => boolean = Object.is) {
    super(undefined as T); // el valor real lo gestiona _value/_evaluated
    this.fn = fn;
    this.equals = equals;
    own(this);
  }

  live(): boolean {
    return this.consumersHead !== null;
  }

  get value(): T {
    // Refrescar antes de linkear: el consumidor debe registrar la versión
    // post-refresh, no la vieja (si no, stabilize() vería un falso cambio).
    if (!(this.flags & F_EVALUATED)) {
      this.flags |= F_EVALUATED;
      this.state = DIRTY;
    }
    ensureFreshComputed(this);
    if (activeConsumer) link(this, activeConsumer);
    return this._value as T;
  }

  peek(): T {
    return this._value as T;
  }

  dispose(): void {
    this.state = DISPOSED;
    disposeOwnerChildren(this);
    this.evalMark++; // primero: sweep quita TODOS los links (mark !== evalMark)
    sweep(this);
    let l = this.consumersHead;
    while (l) {
      const next = l.nextTarget;
      producerRemoveLink(this, l);
      // El link también sale de la lista de fuentes del consumidor — así
      // muere completo y puede reciclarse (antes quedaba colgado hasta el
      // próximo sweep del consumidor).
      if (l.prevSource) l.prevSource.nextSource = l.nextSource;
      else l.target.sourcesHead = l.nextSource;
      if (l.nextSource) l.nextSource.prevSource = l.prevSource;
      freeLink(l);
      l = next;
    }
    this.sourcesHead = null;
    drainReleaseQueue();
    unown(this);
  }
}

class EffectNode implements ConsumerNode, OwnerLike {
  state: number = CLEAN;
  sourcesHead: Link | null = null;
  evalMark = 0;
  childrenHead: (Disposable & OwnerLike) | null = null;
  childCount = 0;
  nextOwned: (Disposable & OwnerLike) | null = null;
  prevOwned: (Disposable & OwnerLike) | null = null;
  cleanups: (() => void)[] | null = null;
  parent: OwnerLike | null = null;
  flags = 0;
  _flush = 0;
  private _fn: () => void | (() => void);
  private _cleanup: (() => void) | void = undefined;
  private _errorHandler: ErrorHandler | null;

  constructor(fn: () => void | (() => void), render = false) {
    this._fn = fn;
    if (render) this.flags |= F_RENDER;
    this._errorHandler = activeErrorHandler;
    own(this);
  }

  live(): boolean {
    return true;
  }

  run(): void {
    if (this.flags & F_DEAD) return;
    if (this.state & RUNNING) {
      throw new Error("[elur] Effect re-entrante detectado.");
    }
    if (typeof this._cleanup === "function") this._cleanup();
    // Los hijos (effects/computeds/cleanups creados en la pasada anterior)
    // mueren antes de re-evaluar — evita leaks de computations anidadas.
    // Guard inline: la mayoría de los effects no posee nada — salta la llamada.
    if (this.childrenHead !== null || this.cleanups !== null) disposeOwnerChildren(this);
    this.evalMark++;
    const prevConsumer = activeConsumer;
    const prevOwner = activeOwner;
    activeConsumer = this;
    activeOwner = this;
    this.state = RUNNING;
    let threw = true;
    try {
      this._cleanup = this._fn();
      threw = false;
    } catch (err) {
      if (this._errorHandler) {
        this._errorHandler(err);
        threw = false;
      } else {
        // A.16: burbujear por la cadena de owners hasta una boundary.
        let handled = false;
        for (let o: OwnerLike | null = this.parent; o; o = o.parent) {
          if (o.onOwnerError?.(err)) { handled = true; break; }
        }
        if (handled) threw = false;
        else throw err;
      }
    } finally {
      activeConsumer = prevConsumer;
      activeOwner = prevOwner;
      if (threw && this.state & RUNNING) this.state = DIRTY; // guard recuperable
    }
    sweep(this);
    this.state = CLEAN;
  }

  dispose(): void {
    if (this.flags & F_DEAD) return;
    this.flags |= F_DEAD;
    this.state = DISPOSED;
    if (typeof this._cleanup === "function") this._cleanup();
    disposeOwnerChildren(this);
    this.evalMark++;
    sweep(this);
    unown(this);
  }
}

// --- Factories ------------------------------------------------------------------

export function signal<T>(initialValue: T): Signal<T> {
  return new Signal(initialValue);
}

/**
 * B.12.4 (durabilidad): signal estática — `link()` no crea edges sobre ella,
 * así que dependencias estáticas no cuestan bookkeeping ni checks de refresh.
 * Escribirla rompe el contrato (warn en dev); el valor no se propaga.
 */
export function constSignal<T>(value: T): Signal<T> {
  const s = new Signal(value);
  s.durable = true;
  return s;
}

export function computed<T>(
  fn: () => T,
  equals: (a: T, b: T) => boolean = Object.is,
): Computed<T> {
  return new Computed(fn, equals);
}

/** Corre una vez al crear; re-corre sólo si una fuente cambió de verdad. */
export function effect(fn: () => void | (() => void)): () => void {
  const node = new EffectNode(fn);
  node.run();
  return () => node.dispose();
}

/**
 * @internal — effect de render (bindings DOM internos): se encola en la
 * cola de render, que se drena ANTES que la de user effects (B.8). La API
 * pública `effect()` sigue siendo la de usuario.
 */
export function _renderEffect(fn: () => void | (() => void)): () => void {
  const node = new EffectNode(fn, true);
  node.run();
  return () => node.dispose();
}

export function batch<T>(fn: () => T): T {
  batchLevel++;
  try {
    return fn();
  } finally {
    batchLevel--;
    if (batchLevel === 0) flushEffects();
  }
}

export function untrack<T>(fn: () => T): T {
  const prev = activeConsumer;
  activeConsumer = null;
  try {
    return fn();
  } finally {
    activeConsumer = prev;
  }
}

export interface WatchOptions {
  immediate?: boolean;
  once?: boolean;
}

export function watch<T>(
  source: Signal<T> | (() => T),
  cb: (value: T, oldValue: T | undefined) => void,
  options: WatchOptions = {},
): () => void {
  const { immediate = false, once = false } = options;
  const getter: () => T =
    source instanceof Signal ? () => source.value : source;
  let first = true;
  let old: T | undefined;
  let stop: () => void = () => { };
  stop = effect(() => {
    const v = getter();
    if (first) {
      first = false;
      if (!immediate) {
        old = v;
        return;
      }
    }
    cb(v, old);
    old = v;
    if (once) stop();
  });
  return stop;
}

export function nextTick(fn?: () => void): Promise<void> {
  return Promise.resolve().then(fn as () => void | Promise<void>);
}

// --- C.6/C.17: binding especializado signal→texto ----------------------------

/**
 * Consumidor mínimo para bindings de texto (lo que el compiler emite para
 * `${expr}` cuando sabe que produce texto). Salta toda la maquinaria de
 * EffectNode: no hay cleanup-fn, ni innerCleanup, ni dispatch por tipo de
 * valor — re-corre el getter y escribe `nodeValue` directamente, en la cola
 * de render (B.8). Escribir es síncrono: el writer directo ES el punto.
 */
class TextBindingNode implements ConsumerNode, OwnerLike, Disposable {
  state = CLEAN;
  flags = F_RENDER;
  _flush = 0;
  sourcesHead: Link | null = null;
  evalMark = 0;
  childrenHead: (Disposable & OwnerLike) | null = null;
  childCount = 0;
  nextOwned: (Disposable & OwnerLike) | null = null;
  prevOwned: (Disposable & OwnerLike) | null = null;
  cleanups: (() => void)[] | null = null;
  parent: OwnerLike | null = null;
  private _fn: () => unknown;
  private _node: { nodeValue: string | null };

  constructor(fn: () => unknown, node: { nodeValue: string | null }) {
    this._fn = fn;
    this._node = node;
    own(this);
  }

  live(): boolean {
    return true;
  }

  run(): void {
    if (this.flags & F_DEAD || this.state & RUNNING) return;
    if (this.childrenHead !== null || this.cleanups !== null) disposeOwnerChildren(this);
    this.evalMark++;
    const prevConsumer = activeConsumer;
    const prevOwner = activeOwner;
    activeConsumer = this;
    activeOwner = this;
    this.state = RUNNING;
    try {
      const v = this._fn();
      this._node.nodeValue = v == null || v === false ? "" : String(v);
    } finally {
      activeConsumer = prevConsumer;
      activeOwner = prevOwner;
    }
    sweep(this);
    this.state = CLEAN;
  }

  dispose(): void {
    if (this.flags & F_DEAD) return;
    this.flags |= F_DEAD;
    this.state = DISPOSED;
    disposeOwnerChildren(this);
    this.evalMark++;
    sweep(this);
    unown(this);
  }
}

/**
 * @internal — binding de texto especializado (C.6): `node.nodeValue` sigue
 * `fn()` con el mínimo consumer posible. `null`/`false`/`undefined` → "".
 * Devuelve disposer (mata la suscripción; el caller remueve el nodo).
 */
export function _bindText(
  node: { nodeValue: string | null },
  fn: () => unknown,
): () => void {
  const b = new TextBindingNode(fn, node);
  b.run();
  return () => b.dispose();
}

// --- C.6 tier T1: binding directo signal→writer --------------------------------

/**
 * C.6/C.8 tier T1: el compiler emite esto cuando la expresión es una lectura
 * directa de señal (`() => <path>.value`) — la SEÑAL viaja como arg y el
 * binding es una edge permanente: sin getter de usuario, sin tracking
 * dinámico, sin sweep — `run()` escribe y punto.
 *
 * La edge no se re-evalúa nunca (la fuente es fija por construcción), así que
 * el nodo no necesita `sourcesHead` real: el Link sólo vive en la lista de
 * consumers del producer. `seenVersion` se mantiene al día en run() para que
 * el early-cutoff de stabilize() siga funcionando si la fuente es un Computed
 * (un T1 sobre computed recibe CHECK, no DIRTY).
 */
class SignalBinding implements ConsumerNode, OwnerLike, Disposable {
  state = CLEAN;
  flags = F_RENDER;
  _flush = 0;
  sourcesHead: Link | null = null;
  evalMark = 0;
  childrenHead: (Disposable & OwnerLike) | null = null;
  childCount = 0;
  nextOwned: (Disposable & OwnerLike) | null = null;
  prevOwned: (Disposable & OwnerLike) | null = null;
  cleanups: (() => void)[] | null = null;
  parent: OwnerLike | null = null;
  private _source: ProducerNode;
  private _link: Link | null = null;
  private _write: (v: unknown) => void;
  private _prev: unknown;

  constructor(source: Signal<unknown>, write: (v: unknown) => void) {
    this._source = source;
    this._write = write;
    // `.value` (no peek) sólo para computeds: fuerza la evaluación lazy de
    // los fríos — peek() devolvería _value crudo (stale). Signals planos van
    // por peek: evita el closure + save/restore de untrack en el path caliente
    // (un binding por fila en listas grandes).
    this._prev = source instanceof Computed
      ? untrack(() => source.value)
      : (source as Signal<unknown>).peek();
    write(this._prev);
    own(this);
    if (!source.durable) {
      const l = allocLink(source, this, source.version, 0);
      l.nextSource = null;
      this._link = l;
      this.sourcesHead = l;
      producerAddLink(source, l);
      // La edge puede despertar un computed frío — drenar adquisiciones.
      if (acquireQueue.length) drainAcquireQueue();
    }
  }

  live(): boolean {
    return true;
  }

  run(): void {
    const v = (this._source as Signal<unknown>).peek();
    if (this._link) this._link.seenVersion = this._source.version;
    if (v !== this._prev) {
      this._prev = v;
      this._write(v);
    }
    this.state = CLEAN;
  }

  dispose(): void {
    if (this.flags & F_DEAD) return;
    this.flags |= F_DEAD;
    this.state = DISPOSED;
    if (this._link) {
      producerRemoveLink(this._source, this._link);
      freeLink(this._link);
      this._link = null;
      this.sourcesHead = null;
    }
    unown(this);
  }
}

/**
 * @internal — C.6 T1: suscripción directa señal→writer. El writer corre una
 * vez al montar (valor inicial) y por cada cambio real de la señal, en la
 * cola de render. Devuelve disposer.
 */
export function _bindSignal<T>(
  source: Signal<T>,
  write: (v: T) => void,
): () => void {
  const b = new SignalBinding(source, write as (v: unknown) => void);
  return () => b.dispose();
}

/**
 * C.7 T2: binding derivado — una edge permanente a la señal dep; run()
 * re-evalúa `get` untracked (las deps ya están conectadas por la edge —
 * evaluar tracked contaminaría al consumidor activo, ver bug de select1k),
 * compara el resultado y sólo escribe si cambió.
 */
class DerivedBinding implements ConsumerNode, OwnerLike, Disposable {
  state = CLEAN;
  flags = F_RENDER;
  _flush = 0;
  sourcesHead: Link | null = null;
  evalMark = 0;
  childrenHead: (Disposable & OwnerLike) | null = null;
  childCount = 0;
  nextOwned: (Disposable & OwnerLike) | null = null;
  prevOwned: (Disposable & OwnerLike) | null = null;
  cleanups: (() => void)[] | null = null;
  parent: OwnerLike | null = null;
  private _source: ProducerNode;
  private _link: Link | null = null;
  private _get: () => unknown;
  private _write: (v: unknown) => void;
  private _prev: unknown;

  constructor(
    source: Signal<unknown>,
    get: () => unknown,
    write: (v: unknown) => void,
  ) {
    this._source = source;
    this._get = get;
    this._write = write;
    this._prev = untrack(get);
    write(this._prev);
    own(this);
    if (!source.durable) {
      const l = allocLink(source, this, source.version, 0);
      l.nextSource = null;
      this._link = l;
      this.sourcesHead = l;
      producerAddLink(source, l);
      if (acquireQueue.length) drainAcquireQueue();
    }
  }

  live(): boolean {
    return true;
  }

  run(): void {
    const v = untrack(this._get);
    if (this._link) this._link.seenVersion = this._source.version;
    if (v !== this._prev) {
      this._prev = v;
      this._write(v);
    }
    this.state = CLEAN;
  }

  dispose(): void {
    if (this.flags & F_DEAD) return;
    this.flags |= F_DEAD;
    this.state = DISPOSED;
    if (this._link) {
      producerRemoveLink(this._source, this._link);
      freeLink(this._link);
      this._link = null;
      this.sourcesHead = null;
    }
    unown(this);
  }
}

/**
 * @internal — C.7 T2: suscripción directa señal→(getter derivado)→writer.
 * Equivale a `_bindSignal(dep, () => write(get()))` con compare incluido,
 * pero sin el closure intermedio ni el double-compare: un solo binding.
 * Devuelve disposer.
 */
export function _bindDerived<T>(
  source: Signal<unknown>,
  get: () => T,
  write: (v: T) => void,
): () => void {
  const b = new DerivedBinding(source, get as () => unknown, write as (v: unknown) => void);
  return () => b.dispose();
}
