import {
    _debugComponentMountStart,
    _debugComponentMountEnd,
    _debugComponentUnmount,
    type ElurComponent,
} from "../lifecycle.js";
import { type _captureContextSnapshot } from "../context.js";
import { adaptClassComponent } from "../component-kernel.js";

// =============================================================================
// --- next/ — component mounting sobre el kernel unificado (A.6–A.9) ---
// Fork de ../template/mount-helpers.ts: misma superficie, pero cada mount pasa
// por ComponentInstance — owner propio, máquina de estados, mount transaccional
// con rollback, onMount post-commit, unmount idempotente.
// =============================================================================

// --- Post-commit onMount queue (misma superficie que el estable) -------------
// El kernel ya difiere onMount por instancia via `deferOnMount`; esta cola
// cubre los callers que NO pasan por el kernel (p.ej. error-boundary llama
// `content.onMount` directamente sobre ElurComponent).
let pendingOnMount: Array<() => void> | null = null;

export function _postMountScope<T>(fn: () => T): T {
    if (pendingOnMount !== null) return fn();
    pendingOnMount = [];
    let ok = false;
    try {
        const r = fn();
        ok = true;
        return r;
    } finally {
        const q = pendingOnMount;
        pendingOnMount = null;
        if (ok) for (const h of q) h();
    }
}

export function _postMountScopeSub<T>(fn: () => T): T {
    const outer = pendingOnMount;
    pendingOnMount = [];
    let ok = false;
    try {
        const r = fn();
        ok = true;
        return r;
    } finally {
        const q = pendingOnMount!;
        pendingOnMount = outer;
        if (ok) {
            if (outer) outer.push(...q);
            else for (const h of q) h();
        }
    }
}

export function _deferOnMount(fn: () => void): void {
    if (pendingOnMount) pendingOnMount.push(fn);
    else fn();
}

/**
 * Monta un ElurComponent via kernel: onInit → render → _render → onMount
 * (post-commit). Errores van por onError o re-lanzan. Cleanup = unmount().
 */
export function _mountComponent(
    inst: ElurComponent,
    parent: Node,
    before: Node | null,
): () => void {
    _debugComponentMountStart(inst);
    const ci = adaptClassComponent(inst);
    try {
        ci.mount(parent, before, {
            deferOnMount: (fire) => _deferOnMount(fire),
        });
    } finally {
        _debugComponentMountEnd(inst);
    }
    return () => {
        ci.unmount();
        _debugComponentUnmount(inst);
    };
}

/**
 * Igual que `_mountComponent` pero traga todos los errores de lifecycle —
 * para contenido de transitions y fallbacks de error boundaries.
 */
export function _mountComponentSilent(
    inst: ElurComponent,
    parent: Node,
    before: Node | null,
): () => void {
    _debugComponentMountStart(inst);
    const ci = adaptClassComponent(inst);
    // Errores silenciados: onError ausente → el kernel re-lanza → se traga aquí.
    try {
        ci.mount(parent, before, {
            deferOnMount: (fire) => _deferOnMount(fire),
        });
    } catch {
        /* silent */
    } finally {
        _debugComponentMountEnd(inst);
    }
    return () => {
        ci.unmount();
        _debugComponentUnmount(inst);
    };
}

/**
 * Monta con contexto capturado — para render dinámico/keyed dentro de
 * effects, donde provide/inject hereda del punto de declaración.
 */
export function _mountComponentWithCtx(
    inst: ElurComponent,
    parent: Node,
    before: Node | null,
    ctxSnapshot: ReturnType<typeof _captureContextSnapshot>,
): () => void {
    _debugComponentMountStart(inst);
    const ci = adaptClassComponent(inst);
    try {
        ci.mount(parent, before, {
            ctxSnapshot,
            deferOnMount: (fire) => _deferOnMount(fire),
        });
    } finally {
        _debugComponentMountEnd(inst);
    }
    return () => {
        ci.unmount();
        _debugComponentUnmount(inst);
    };
}

/**
 * Mount con onMount diferido — dentro de fragments de `html` donde el DOM
 * aún no está insertado: el hook corre cuando el fragment hace commit.
 */
export function _mountComponentDeferred(
    inst: ElurComponent,
    parent: Node,
    before: Node | null,
    postMountHooks: Array<() => void>,
    disposes: Array<() => void>,
): void {
    _debugComponentMountStart(inst);
    const ci = adaptClassComponent(inst);
    try {
        ci.mount(parent, before, {
            deferOnMount: (fire) => postMountHooks.push(fire),
        });
    } finally {
        _debugComponentMountEnd(inst);
    }
    disposes.push(() => {
        ci.unmount();
        _debugComponentUnmount(inst);
    });
}
