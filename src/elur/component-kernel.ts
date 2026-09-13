/**
 * Kernel unificado de componentes.
 *
 * Implementa A.6–A.9 del plan técnico sobre el ownership de
 * `./reactivity.ts`:
 *  - Una sola `ComponentInstance` para clases y funciones (adaptadores).
 *  - Máquina de estados (A.7): created → initializing → rendering →
 *    pending-mount → mounted → disposing → disposed (o failed).
 *  - Mount transaccional (A.9): cualquier fallo dispara rollback —
 *    cleanups registrados, owner reactivo disposed, DOM insertado removido.
 *  - `unmount()` idempotente (A.2.10).
 *  - `onMount` corre DESPUÉS del commit DOM (A.2.9).
 *  - Todo lo creado en setup/render pertenece al owner de la instancia y
 *    muere con unmount (A.2.1 — no más effects huérfanos).
 *
 * Las invocaciones implementan `ELUR_RENDER_PROTOCOL.mountDom`, así el
 * renderer existente las monta sin saber que son componentes.
 */

import {
  getOwner,
  runWithOwner,
  signal,
  Owner,
  Signal,
  type Disposable,
  type OwnerLike,
} from "./reactivity.js";
import {
  isElurComponent,
  _debugComponentMountStart,
  _debugComponentMountEnd,
  _debugComponentUnmount,
  type ElurComponent,
  type ComponentController,
} from "./lifecycle.js";
import {
  ELUR_RENDER_PROTOCOL,
  isElurTemplate,
  type DomProtocolContext,
} from "./template/types.js";
import {
  _pushComponentContext,
  _popComponentContext,
  _withComponentContext,
  _pushContextScopeResolver,
} from "./context.js";

// --- Máquina de estados (A.7) -------------------------------------------------

export type ComponentState =
  | "created"
  | "initializing"
  | "rendering"
  | "pending-mount"
  | "mounted"
  | "deactivated"
  | "disposing"
  | "disposed"
  | "failed";

// --- Hooks --------------------------------------------------------------------

// --- A.16: error boundaries ----------------------------------------------------

/** Fase del lifecycle donde ocurrió el error. */
export type ErrorPhase =
  | "setup"
  | "init"
  | "render"
  | "hydrate"
  | "mount"
  | "effect"
  | "activate"
  | "deactivate"
  | "cleanup"
  | "unmount";

/** Información estructurada del error (A.16). */
export interface ComponentErrorInfo {
  phase: ErrorPhase;
  /** Instancia donde ocurrió el error (no la boundary que lo maneja). */
  component: ComponentInstance;
  cause: unknown;
}

/** Resolución de una boundary (A.16). */
export type ErrorResolution =
  | { handled: false }
  | { handled: true; fallback?: Renderable }
  | { handled: true; retry: true };

export interface ComponentHooks {
  /** Tras el commit DOM. Puede devolver cleanup (corre en unmount). */
  onMount?: () => (() => void) | void;
  /** Antes de remover el DOM. */
  onUnmount?: () => void;
  /**
   * Boundary de errores (A.16): recibe info estructurada; el error burbujea
   * por la cadena de instancias hasta una boundary que devuelva handled.
   * `void` = manejado sin más.
   */
  onError?: (info: ComponentErrorInfo) => ErrorResolution | void;
  /** A.17: tras setup durante SSR — nunca en cliente. */
  onServerRender?: () => void;
}

/** Contexto que recibe el setup de un componente funcional. */
export interface SetupCtx {
  onMount(fn: () => (() => void) | void): void;
  onUnmount(fn: () => void): void;
  onError(fn: (info: ComponentErrorInfo) => ErrorResolution | void): void;
  /** A.17: hook server-side — corre tras setup durante SSR, nunca en cliente. */
  onServerRender(fn: () => void): void;
  /** Owner de la instancia — para runWithOwner/getOwner manual. */
  readonly owner: OwnerLike;
  /** Señal interna de una prop (A.13) — para acceso reactivo explícito. */
  propSignal<K extends string>(key: K): Signal<unknown> | undefined;
  /**
   * A.14: renderiza el contenido de un slot (lazy — corre el render del
   * slot bajo el owner del padre que lo declaró). `"default"` por defecto.
   */
  slot(name?: string): unknown;
  /** A.14: slots declarados en la invocación. */
  readonly slots: Record<string, Slot> | undefined;
}

// --- Renderable ---------------------------------------------------------------

interface RenderableValue {
  _render(parent: Node, before: Node | null): () => void;
}

function asRenderable(v: unknown): RenderableValue | null {
  if (isElurTemplate(v)) return v as unknown as RenderableValue;
  return null;
}

// --- A.14: Slots (lazy, marcados) --------------------------------------------------

/** Renderable común: cualquier cosa montable en un binding. */
export type Renderable =
  | ElurComponent
  | ComponentInvocation<unknown>
  | Slot
  | { _render(parent: Node, before: Node | null): () => void }
  | string
  | number
  | bigint
  | false
  | null
  | undefined
  | Renderable[];

/**
 * Slot lazy y marcado (A.14): el contenido se renderiza bajo el owner del
 * padre que LO DECLARÓ (contexto léxico), aunque se monte dentro del
 * componente consumidor.
 */
export interface Slot {
  readonly __isElurSlot: true;
  /** Owner capturado en el punto de declaración (contexto léxico). */
  readonly owner: OwnerLike | null;
  render(): unknown;
}

export function slot(render: () => unknown): Slot {
  return { __isElurSlot: true, owner: getOwner(), render };
}

export function isElurSlot(v: unknown): v is Slot {
  return (
    v != null &&
    typeof v === "object" &&
    (v as { __isElurSlot?: boolean }).__isElurSlot === true
  );
}

// --- ComponentInstance ----------------------------------------------------------

let nextInstanceId = 1;

export class ComponentInstance implements Disposable {
  readonly id = nextInstanceId++;
  readonly kind: "class" | "function";
  state: ComponentState = "created";
  /** Owner reactivo de la instancia — todo lo creado dentro muere con él. */
  readonly owner = new Owner();
  /** Instancia padre (owner activo cuando se creó esta instancia). */
  parent: ComponentInstance | null = null;
  hooks: ComponentHooks = {};
  renderable: RenderableValue | null = null;
  /** A.12: frame de provide/inject propio de la instancia — permanente. */
  readonly context = new Map<unknown, unknown>();

  private _inst: ElurComponent | null = null;
  private _invocation: ComponentInvocation<any> | null = null;
  private _renderCleanup: (() => void) | null = null;
  private _mountCleanups: (() => void)[] | null = null;
  /** A.13: señales internas por prop + objeto live pasado al setup. */
  private _propSignals: Map<string, Signal<unknown>> | null = null;
  private _liveProps: Record<string, unknown> | null = null;
  /** A.16: fase actual del lifecycle — para el ComponentErrorInfo. */
  private _phase: ErrorPhase = "setup";
  /** A.16: posición de montaje — para renderizar fallback de boundary. */
  private _mountParent: Node | null = null;
  private _mountBefore: Node | null = null;
  /** A.3.8: nodos DOM de la instancia — para detach/attach. */
  private _domNodes: Node[] | null = null;
  /** A.21: controllers de ciclo de vida (Lit-style). */
  private _controllers: ComponentController[] | null = null;

  constructor(source: ElurComponent | ComponentInvocation<any>) {
    if (isElurComponent(source)) {
      this.kind = "class";
      this._inst = source;
    } else {
      this.kind = "function";
      this._invocation = source;
    }
    // A.16: errores de effects/computeds de la instancia burbujean aquí.
    this.owner.onOwnerError = (err) =>
      reportError(this, { phase: "effect", component: this, cause: err })
        .handled;
  }

  /**
   * Mount transaccional (A.9). Cualquier fase que falle → rollback completo:
   * owner disposed, cleanups corridos, DOM insertado removido, state=failed.
   *
   * Opciones:
   *  - `ctxSnapshot`: contexto capturado en el punto de declaración
   *    (mounts dentro de effects dinámicos heredan provide/inject).
   *  - `deferOnMount`: recibe una función `fire()` que corre onMount; el
   *    caller decide cuándo invocarla (fragments aún no insertados).
   */
  mount(
    parent: Node,
    before: Node | null,
    opts?: {
      ctxSnapshot?: Map<unknown, unknown>[];
      deferOnMount?: (fire: () => void) => void;
      /** Valores a proveer en el frame de contexto de la instancia (A.12). */
      provides?: Iterable<readonly [unknown, unknown]>;
      /**
       * A.14: owner del declarante — para contenido de slots, el owner padre
       * es el del padre que declaró el contenido, no el del punto de montaje.
       */
      declOwner?: OwnerLike | null;
    },
  ): void {
    if (this.state !== "created") {
      throw new Error(
        `[elur] ComponentInstance.mount(): estado inválido "${this.state}" (una instancia montada no puede montarse otra vez).`,
      );
    }
    ownerToInstance.set(this.owner, this);
    ownerToContext.set(this.owner, this.context);
    this._resolveParent();
    // A.12: el owner de la instancia se cuelga del owner activo en el punto
    // de declaración — así la cadena de owners reproduce el árbol de
    // componentes y provide/inject resuelven por instancias.
    this.owner.parent = opts?.declOwner !== undefined ? opts.declOwner : getOwner();
    if (opts?.provides) {
      for (const [k, v] of opts.provides) this.context.set(k, v);
    }
    this._mountParent = parent;
    this._mountBefore = before;

    // A.2.4: debug events sólo para funcionales — las clases ya emiten por
    // mount-helpers; emitir aquí duplicaría. El payload es la
    // ComponentInstance (id/kind/state/parent en el árbol).
    const isFunctional = !isElurComponent(this._inst);
    const dbg = this as unknown as ElurComponent;
    if (isFunctional) _debugComponentMountStart(dbg);

    // A.3.8: índice donde empieza el DOM de la instancia — para capturar el
    // rango de nodos tras _render y poder detach/attach después.
    const startIndex = before
      ? Array.prototype.indexOf.call(parent.childNodes, before)
      : parent.childNodes.length;

    try {
      // --- initializing + rendering + pending-mount, TODO bajo el mismo
      // frame de contexto: los hijos montados durante _render heredan el
      // provide de esta instancia (como en la impl actual).
      this.state = "initializing";
      runWithOwner(this.owner, () =>
        this._withScope(opts?.ctxSnapshot, () => {
          this._initBody();
          // A.21: controllers de la clase + programáticos — hostInit dentro
          // del frame para que lo que creen quede poseído por la instancia.
          if (this._inst?._controllers) {
            for (const c of this._inst._controllers) this.addController(c);
          }
          if (this._controllers) {
            for (const c of this._controllers) c.hostInit?.();
          }
          // pending-mount: activar bindings + insertar DOM, aún dentro del
          // frame de contexto para que los hijos hereden provide/inject.
          this._phase = "mount";
          this.state = "pending-mount";
          this._renderCleanup = this.renderable!._render(parent, before);
          // A.3.8: capturar los nodos insertados entre startIndex y `before`.
          const endIndex = before
            ? Array.prototype.indexOf.call(parent.childNodes, before)
            : parent.childNodes.length;
          this._domNodes = Array.prototype.slice.call(
            parent.childNodes,
            startIndex,
            endIndex,
          ) as Node[];
        }),
      );

      // --- commit ---
      this.state = "mounted";

      // onMount DESPUÉS del commit DOM (A.2.9) — inmediato o diferido por
      // el caller (fragments que aún no están en el documento).
      const fire = () => this._runOnMount();
      if (opts?.deferOnMount) opts.deferOnMount(fire);
      else fire();
    } catch (err) {
      this._rollback();
      const res = reportError(this, {
        phase: this._phase,
        component: this,
        cause: err,
      });
      if (!res.handled) throw err;
      if ("retry" in res && res.retry) {
        // Una sola reintento — instancia fresca (el owner viejo está
        // disposed); un segundo fallo se propaga igual.
        new ComponentInstance(this._inst ?? this._invocation!).mount(
          parent,
          before,
          opts,
        );
      } else if ("fallback" in res && res.fallback !== undefined) {
        this._renderFallback(res.fallback, parent, before);
      }
    } finally {
      // A.3.3/A.2.4: mountEnd balanceado — se emite haya éxito, rollback,
      // retry o fallback, para que el tooling pueda emparejar start/end.
      if (isFunctional) _debugComponentMountEnd(dbg);
    }
  }

  /** A.21: registra un controller — sus hooks corren bajo este owner. */
  addController(c: ComponentController): void {
    (this._controllers ??= []).push(c);
  }

  /**
   * A.3.8: saca el DOM de la instancia SIN disponer nada — effects, signals
   * y contexto siguen vivos (página cached, Suspense, transición). No-op si
   * no está montado.
   */
  detach(): void {
    if (this.state !== "mounted" || !this._domNodes) return;
    const frag = document.createDocumentFragment();
    for (const n of this._domNodes) frag.appendChild(n);
    this.state = "deactivated";
    // A.21: hostDeactivate — signals/effects del controller siguen vivos.
    if (this._controllers) {
      runWithOwner(this.owner, () => {
        for (const c of this._controllers!) c.hostDeactivate?.();
      });
    }
  }

  /**
   * A.3.8: reinserta el DOM de una instancia detached en la posición original
   * (o en parent/before dados). No-op si no está deactivated.
   */
  attach(parent?: Node, before?: Node | null): void {
    if (this.state !== "deactivated" || !this._domNodes) return;
    const p = parent ?? this._mountParent;
    const b = before !== undefined ? before : this._mountBefore;
    if (!p) return;
    for (const n of this._domNodes) p.insertBefore(n, b);
    this.state = "mounted";
    // A.21: hostActivate — la instancia volvió al DOM.
    if (this._controllers) {
      runWithOwner(this.owner, () => {
        for (const c of this._controllers!) c.hostActivate?.();
      });
    }
  }

  /** Idempotente (A.2.10): disponer dos veces es seguro. */
  unmount(): void {
    if (this.state === "created") return; // nunca montado
    if (this.state === "disposing" || this.state === "disposed") return;
    if (this.state === "failed") {
      this.state = "disposed";
      return;
    }
    // A.3.8: unmount de una instancia detached dispone igual — el cleanup
    // del renderable remueve los nodos de su padre actual (el fragment).
    if (this.state === "deactivated") this._domNodes = null;
    this.state = "disposing";
    // A.2.4: mismo criterio — sólo funcionales (las clases emiten por
    // mount-helpers).
    if (!isElurComponent(this._inst)) {
      _debugComponentUnmount(this as unknown as ElurComponent);
    }
    try {
      // A.12: bajo el owner → inject() resuelve dentro de onUnmount también.
      runWithOwner(this.owner, () => {
        this.hooks.onUnmount?.call(this._inst ?? undefined);
        this._inst?.onUnmount?.();
        // A.21: hostUnmount antes del disposal del owner.
        if (this._controllers) {
          for (const c of this._controllers) c.hostUnmount?.();
        }
      });
    } catch (err) {
      // A.16: errores de unmount no abortan el disposal pero se reportan.
      this._reportSwallowed(err, "unmount");
    }
    if (this._mountCleanups) {
      for (const fn of this._mountCleanups) {
        try {
          fn();
        } catch (err) {
          // A.3.4/A.16: cleanup errors continúan el teardown, pero se reportan.
          this._reportSwallowed(err, "cleanup");
        }
      }
      this._mountCleanups = null;
    }
    // Owner primero (mata effects/computeds/cleanups de la instancia),
    // luego el cleanup del renderable (remueve DOM + cleanup propio).
    this.owner.dispose();
    try {
      this._renderCleanup?.();
    } finally {
      this._renderCleanup = null;
      this.state = "disposed";
    }
  }

  dispose(): void {
    this.unmount();
  }

  /** @internal — corre onMount una vez; no-op si ya no está montado. */
  _runOnMount(): void {
    if (this.state !== "mounted") return;
    try {
      // A.12: bajo el owner → inject() dentro de onMount resuelve por la
      // cadena de instancias (contexto permanente, no sólo durante render).
      const mountRet = runWithOwner(this.owner, () => {
        const r =
          this.kind === "class" ? this._inst!.onMount?.() : this.hooks.onMount?.();
        // A.21
        if (this._controllers) {
          for (const c of this._controllers) c.hostMounted?.();
        }
        return r;
      });
      if (typeof mountRet === "function") {
        (this._mountCleanups ??= []).push(mountRet);
      }
    } catch (err) {
      // A.16: onMount falla → rollback completo + boundary (+fallback).
      this._rollback();
      const res = reportError(this, {
        phase: "mount",
        component: this,
        cause: err,
      });
      if (!res.handled) throw err;
      if ("fallback" in res && res.fallback !== undefined) {
        this._renderFallback(res.fallback, this._mountParent!, this._mountBefore);
      }
    }
  }

  /**
   * @internal A.16: intenta manejar el error con el boundary propio.
   * `null` = este nodo no tiene boundary — seguir subiendo.
   */
  _handleError(info: ComponentErrorInfo): ErrorResolution | null {
    if (this.kind === "function" && this.hooks.onError) {
      const r = this.hooks.onError(info);
      if (r === undefined) return { handled: true };
      return r;
    }
    if (this.kind === "class" && this._inst?.onError) {
      this._inst.onError(info.cause);
      return { handled: true };
    }
    return null;
  }

  /** A.16: errores de teardown — se reportan a la cadena; si nadie los maneja quedan registrados. */
  private _reportSwallowed(err: unknown, phase: ErrorPhase): void {
    const res = reportError(this, { phase, component: this, cause: err });
    if (!res.handled) console.error("[elur] error en " + phase + ":", err);
  }

  /** A.16: renderiza el fallback de una boundary en la posición del componente. */
  private _renderFallback(
    fallback: Renderable,
    parent: Node,
    before: Node | null,
  ): void {
    const r = asRenderable(fallback);
    if (r) r._render(parent, before);
    else if (typeof fallback === "string" || typeof fallback === "number") {
      parent.insertBefore(document.createTextNode(String(fallback)), before);
    } else if (Array.isArray(fallback)) {
      for (const f of fallback) this._renderFallback(f, parent, before);
    }
    // ComponentInvocation / ElurComponent se montan por el camino normal.
    else if (fallback) {
      new ComponentInstance(fallback as ComponentInvocation<unknown>).mount(
        parent,
        before,
      );
    }
  }

  /** Camina la cadena de owners hasta la instancia registrada más cercana. */
  private _resolveParent(): void {
    let o = getOwner();
    while (o) {
      const inst = ownerToInstance.get(o);
      if (inst) {
        this.parent = inst;
        return;
      }
      o = o.parent;
    }
  }

  private _rollback(): void {
    // Cancelar hooks pendientes + cleanups + owner + hijos + DOM insertado.
    this.owner.dispose();
    try {
      this._renderCleanup?.();
    } finally {
      this._renderCleanup = null;
      this.state = "failed";
    }
  }

  private _makeSetupCtx(): SetupCtx {
    const inst = this;
    return {
      owner: this.owner,
      onMount(fn) {
        inst.hooks.onMount = fn;
      },
      onUnmount(fn) {
        inst.hooks.onUnmount = fn;
      },
      onError(fn) {
        inst.hooks.onError = fn;
      },
      onServerRender(fn) {
        inst.hooks.onServerRender = fn;
      },
      propSignal(key) {
        return inst._propSignals?.get(key);
      },
      slots: this._invocation?.slots,
      // Devuelve el Slot marcado — el renderer lo desenvuelve bajo el owner
      // del declarante (contexto léxico, A.14).
      slot(name = "default") {
        return inst._invocation?.slots?.[name];
      },
    };
  }

  /** Fases initializing+rendering: setup/onInit + render → this.renderable. */
  private _initBody(): void {
    if (this.kind === "class") {
      const inst = this._inst!;
      this._phase = "init";
      inst.onInit?.();
      this._phase = "render";
      this.state = "rendering";
      this.renderable = asRenderable(inst.render());
    } else {
      const inv = this._invocation!;
      const ctx = this._makeSetupCtx();
      this._phase = "setup";
      this.state = "rendering";
      // A.13: LiveProps — getters readonly sobre signals internas.
      // Leer props.x dentro de un binding/effect registra dependencia.
      this.renderable = asRenderable(
        inv.definition.setup(this._initProps(inv.props), ctx),
      );
    }
    if (!this.renderable) {
      throw new Error(
        `[elur] El componente #${this.id} no produjo un template renderizable.`,
      );
    }
  }

  /** Corre `body` dentro del frame de contexto (snapshot o frame nuevo). */
  private _withScope(
    ctxSnapshot: Map<unknown, unknown>[] | undefined,
    body: () => void,
  ): void {
    if (ctxSnapshot) {
      _withComponentContext(ctxSnapshot, body);
    } else {
      _pushComponentContext();
      try {
        body();
      } finally {
        _popComponentContext();
      }
    }
  }

  /**
   * A.18 — hidratación: setup/onInit + render una sola vez, luego adopta el
   * DOM SSR via ctx.render (que activa bindings dentro del owner de la
   * instancia). En mismatch: rollback de la activación + remount por el mismo
   * kernel REUSANDO el renderable — setup/onInit no se duplica.
   */
  _hydrate(ctx: {
    parent: Node;
    bounds: { start: Comment; end: Comment } | null;
    render(value: unknown): unknown;
    /** "throw" propaga el mismatch en vez de remontar (HydrateOptions). */
    mismatch?: "throw" | "warn-remount" | "remount";
  }): void {
    if (this.state !== "created") {
      throw new Error(`[elur] _hydrate(): estado inválido "${this.state}".`);
    }
    ownerToInstance.set(this.owner, this);
    ownerToContext.set(this.owner, this.context);
    this._resolveParent();
    this.owner.parent = getOwner();
    try {
      this.state = "initializing";
      let hydrateCleanup: unknown;
      runWithOwner(this.owner, () =>
        this._withScope(undefined, () => {
          this._initBody();
          this.state = "pending-mount";
          hydrateCleanup = ctx.render(this.renderable);
        }),
      );
      this._renderCleanup =
        typeof hydrateCleanup === "function" ? (hydrateCleanup as () => void) : null;
      this.state = "mounted";
      this._runOnMount();
    } catch (error) {
      if (ctx.mismatch === "throw") throw error;
      if (ctx.mismatch !== "remount") {
        console.warn("[elur] Hydration mismatch en componente; remounting:", error);
      }
      // Mismatch SSR → rollback de la activación y remount por el kernel,
      // reutilizando this.renderable (onInit/setup ya corrieron — A.18).
      this.owner.dispose();
      const retry = this.renderable;
      this.state = "initializing";
      runWithOwner(this.owner, () =>
        this._withScope(undefined, () => {
          if (!retry) this._initBody();
          this.state = "pending-mount";
          this._renderCleanup = this.renderable!._render(
            ctx.parent,
            ctx.bounds?.end ?? null,
          );
        }),
      );
      this.state = "mounted";
      this._runOnMount();
    }
  }

  /**
   * A.17 — SSR: setup/onInit + onServerRender + serializar el renderable.
   * NO corre onMount/onUnmount; el owner server-side se dispone al final
   * (mata effects/computeds creados en setup).
   */
  async _renderServer(sctx: {
    markers?: boolean;
    render(value: unknown, options?: { markers?: boolean }): string | Promise<string>;
  }): Promise<string> {
    this.state = "initializing";
    ownerToInstance.set(this.owner, this);
    ownerToContext.set(this.owner, this.context);
    this._resolveParent();
    this.owner.parent = getOwner();
    runWithOwner(this.owner, () =>
      this._withScope(undefined, () => {
        this._initBody();
        if (this.kind === "class") this._inst!.onServerRender?.();
        else this.hooks.onServerRender?.();
      }),
    );
    try {
      return await sctx.render(this.renderable, { markers: sctx.markers });
    } finally {
      // Disposal server-side: cleanups + hijos reactivos, sin lifecycle DOM.
      this.owner.dispose();
      this.state = "disposed";
    }
  }

  /**
   * A.13 — crea el objeto LiveProps: propiedades readonly respaldadas por
   * signals. OJO: destructurar props en setup crea snapshots no reactivos.
   */
  private _initProps(props: unknown): Record<string, unknown> {
    this._propSignals = new Map();
    this._liveProps = {};
    if (props != null && typeof props === "object") {
      for (const [key, value] of Object.entries(props)) {
        if (key === "key") continue; // la key es identidad, no prop reactiva
        const sig = signal(value);
        this._propSignals.set(key, sig);
        Object.defineProperty(this._liveProps, key, {
          enumerable: true,
          get: () => sig.value,
        });
      }
    }
    return this._liveProps;
  }

  /**
   * A.13/A.15 — true si `inv` es la misma definición con la misma key:
   * entonces el runtime debe actualizar props, no recrear el setup.
   */
  matches(inv: ComponentInvocation<any>): boolean {
    if (this.kind !== "function" || !this._invocation) return false;
    const keyOf = (p: unknown) =>
      p != null && typeof p === "object"
        ? (p as Record<string, unknown>).key
        : undefined;
    return (
      inv.definition === this._invocation.definition &&
      keyOf(inv.props) === keyOf(this._invocation.props)
    );
  }

  /**
   * A.13 — actualiza props sin recrear setup: escribe cada signal de prop.
   * Props nuevas se añaden; props desaparecidas quedan en undefined.
   */
  updateProps(props: unknown): void {
    if (!this._propSignals || !this._liveProps) return;
    const seen = new Set<string>();
    if (props != null && typeof props === "object") {
      for (const [key, value] of Object.entries(props)) {
        if (key === "key") continue;
        seen.add(key);
        const sig = this._propSignals.get(key);
        if (sig) {
          sig.value = value;
        } else {
          const s = signal(value);
          this._propSignals.set(key, s);
          Object.defineProperty(this._liveProps, key, {
            enumerable: true,
            get: () => s.value,
          });
        }
      }
    }
    for (const key of this._propSignals.keys()) {
      if (!seen.has(key)) this._propSignals.get(key)!.value = undefined;
    }
  }
}

/**
 * A.16: burbujeo de errores por la cadena de instancias (padres reales del
 * árbol de componentes). Devuelve la primera resolución manejada; si nadie
 * maneja el error, `{ handled: false }` y el caller decide (re-lanzar o
 * registrar).
 */
export function reportError(
  from: ComponentInstance,
  info: ComponentErrorInfo,
): ErrorResolution {
  let cur: ComponentInstance | null = from;
  while (cur) {
    const r = cur._handleError(info);
    if (r !== null) return r;
    cur = cur.parent;
  }
  return { handled: false };
}

// --- Adaptador de clase ---------------------------------------------------------

/** Envuelve un ElurComponent de clase en el kernel unificado. */
export function adaptClassComponent(inst: ElurComponent): ComponentInstance {
  const ci = new ComponentInstance(inst);
  // Los hooks de clase se leen de la instancia en mount/unmount directamente
  // (onInit/onMount/onUnmount/onError) — no necesitan registro por ctx.
  return ci;
}

// --- Componentes funcionales (A.5) ------------------------------------------------

export interface ComponentDefinition<P> {
  (props?: P, slots?: Record<string, Slot>): ComponentInvocation<P>;
  readonly setup: (props: P | undefined, ctx: SetupCtx) => unknown;
  readonly _isComponentDefinition: true;
}

/** Invocación marcada: `Counter({ initial: 10 })` NO ejecuta setup — monta después. */
export class ComponentInvocation<P> {
  readonly [ELUR_RENDER_PROTOCOL] = {
    mountDom: (ctx: DomProtocolContext): (() => void) => {
      const inst = new ComponentInstance(this as ComponentInvocation<any>);
      // mount() resuelve `parent` caminando la cadena de owners — bajo el
      // swap, el caller corre dentro del owner del componente padre.
      inst.mount(ctx.parent, ctx.before);
      return () => inst.unmount();
    },
    // A.17 — SSR: setup + onServerRender + serialización; sin lifecycle DOM.
    renderServer: (sctx: {
      markers?: boolean;
      render(value: unknown, options?: { markers?: boolean }): string | Promise<string>;
    }): Promise<string> => {
      const inst = new ComponentInstance(this as ComponentInvocation<any>);
      return inst._renderServer(sctx);
    },
    // A.18 — hidratación: setup una vez + adopta DOM SSR; mismatch → remount
    // por el kernel reusando el renderable.
    hydrateDom: (ctx: {
      parent: Node;
      bounds: { start: Comment; end: Comment } | null;
      render(value: unknown): unknown;
    }): (() => void) => {
      const inst = new ComponentInstance(this as ComponentInvocation<any>);
      inst._hydrate(ctx);
      return () => inst.unmount();
    },
  };

  readonly definition: ComponentDefinition<P>;
  readonly props: P | undefined;
  /** A.14: slots declarados en la llamada — `Card(props, { default: slot(...) })`. */
  readonly slots: Record<string, Slot> | undefined;

  constructor(
    definition: ComponentDefinition<P>,
    props: P | undefined,
    slots?: Record<string, Slot>,
  ) {
    this.definition = definition;
    this.props = props;
    this.slots = slots;
  }
}

export function isComponentInvocation(v: unknown): v is ComponentInvocation<any> {
  return v instanceof ComponentInvocation;
}

/** Owner → instancia, para localizar el padre al montar una invocación. */
const ownerToInstance = new WeakMap<OwnerLike, ComponentInstance>();
/** Owner → frame de contexto (instancias o roots de mount con provides). */
const ownerToContext = new WeakMap<OwnerLike, Map<unknown, unknown>>();

/**
 * @internal — registra un frame de contexto para un owner raíz (mount de
 * template con router, roots de app, etc).
 */
export function _registerContextOwner(
  owner: OwnerLike,
  context: Map<unknown, unknown>,
): void {
  ownerToContext.set(owner, context);
}

// --- A.12: contexto permanente por instancia -----------------------------------
//
// El modelo actual usa un stack global empujado durante init/render — por eso
// provide/inject fallan fuera de esas fases (A.3.6). Aquí el contexto ES de la
// instancia: un Map propio por ComponentInstance, resuelto caminando la cadena
// de owners activa. inject() funciona en setup, effects, onMount y callbacks —
// el árbol de owners reproduce el árbol de componentes permanentemente.
// Si no hay instancia en la cadena → undefined → el resolver cae al stack
// global (misma semántica: provide fuera de componente lanza error).

// Resolver secundario: el primario (server/index, ALS) gana durante SSR;
// éste se consulta cuando aquél devuelve undefined (lado cliente).
_pushContextScopeResolver(() => {
  const frames: Map<unknown, unknown>[] = [];
  let o: OwnerLike | null = getOwner();
  while (o) {
    const ctx = ownerToContext.get(o);
    if (ctx) frames.push(ctx);
    o = o.parent;
  }
  if (frames.length === 0) return undefined;
  frames.reverse(); // cadena innermost→outermost → stack outermost→innermost
  return frames;
});

/**
 * Define un componente funcional de primera clase (A.5):
 * `Counter(props)` retorna una invocación marcada; el runtime ejecuta el
 * setup cuando monta la invocación.
 */
export function defineComponent<P = Record<string, never>>(
  setup: (props: P | undefined, ctx: SetupCtx) => unknown,
): ComponentDefinition<P> {
  const def = ((props?: P, slots?: Record<string, Slot>) =>
    new ComponentInvocation<P>(
      def as ComponentDefinition<P>,
      props,
      slots,
    )) as ComponentDefinition<P>;
  (def as { setup: unknown }).setup = setup;
  (def as { _isComponentDefinition: boolean })._isComponentDefinition = true;
  return def;
}

// --- Mount de alto nivel ------------------------------------------------------------

/**
 * Monta un componente (clase o invocación funcional) en `container` y
 * devuelve el handle con `unmount()`. Todo el árbol reactivo muere con el
 * unmount — sin fugas de effects/computeds.
 */
export function mountComponent(
  value: ElurComponent | ComponentInvocation<any>,
  container: Element,
): { unmount(): void; instance: ComponentInstance } {
  const inst = new ComponentInstance(value);
  inst.mount(container, null);
  return { unmount: () => inst.unmount(), instance: inst };
}
