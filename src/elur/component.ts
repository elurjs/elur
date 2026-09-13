/**
 * mount() público sobre el kernel de componentes.
 *
 *  - Componentes (clase o invocación funcional) montan via ComponentInstance:
 *    máquina de estados, owner propio, mount transaccional, onMount
 *    post-commit, unmount idempotente.
 *  - `options.router` se inyecta via `provides` en el frame de contexto de la
 *    instancia (A.12) en vez de un stack global.
 *  - Templates raíz montan bajo un Owner raíz — así los componentes internos
 *    tienen cadena de owners y provide/inject resuelve por instancias.
 */
import type { ElurTemplate, ElurMountHandle } from "./template/index.js";
import {
    isElurComponent,
    _debugComponentMountStart,
    _debugComponentMountEnd,
    _debugComponentUnmount,
    type ElurComponent,
} from "./lifecycle.js";
import { RouterKey, _debugRegisterRouter, _debugUnregisterRouter } from "./router-registry.js";
import type { Router } from "./router.js";
import { Owner, getOwner, runWithOwner } from "./reactivity.js";
import {
    ComponentInstance,
    isComponentInvocation,
    _registerContextOwner,
    type ComponentInvocation,
} from "./component-kernel.js";

export {
    defineComponent,
    slot,
    mountComponent,
    isElurSlot,
    isComponentInvocation,
    ComponentInstance,
} from "./component-kernel.js";
export type {
    ComponentDefinition,
    ComponentInvocation,
    SetupCtx,
    Slot,
    Renderable,
    ComponentState,
    ErrorPhase,
    ComponentErrorInfo,
    ErrorResolution,
    ComponentHooks,
} from "./component-kernel.js";

export interface MountOptions {
    router?: Router;
}

function _resolveContainer(container: Element | string): Element {
    const el =
        typeof container === "string"
            ? (document.querySelector(container) as Element)
            : container;
    if (!el) {
        throw new Error(`[elur] mount: container not found: ${container}`);
    }
    return el;
}

/**
 * Mounts a ElurTemplate, ElurComponent o ComponentInvocation en el DOM.
 *
 *   mount(Counter({ initial: 10 }), "#app");  // componente funcional
 *   mount(new Timer(), "#app");               // clase con lifecycle
 *   mount(html`…`, "#app");                   // template
 *
 * @returns { unmount() } — mata el árbol reactivo completo y remueve el DOM.
 */
export function mount(
    component: ElurTemplate | ElurComponent | ComponentInvocation<any>,
    container: Element | string,
    options?: MountOptions,
): ElurMountHandle {
    if (isElurComponent(component) || isComponentInvocation(component)) {
        const el = _resolveContainer(container);
        const inst = new ComponentInstance(component);

        _debugComponentMountStart(component as ElurComponent);
        try {
            inst.mount(el, null, {
                provides: options?.router
                    ? [[RouterKey, options.router] as const]
                    : undefined,
            });
        } finally {
            _debugComponentMountEnd(component as ElurComponent);
        }
        if (options?.router) _debugRegisterRouter(options.router);

        return {
            unmount() {
                inst.unmount();
                if (options?.router) _debugUnregisterRouter(options.router);
                _debugComponentUnmount(component as ElurComponent);
            },
        };
    }

    const el = _resolveContainer(container);
    // Owner raíz para el template: ancla la cadena de owners (los componentes
    // internos resuelven parent/contexto por ella) y puede portar el frame
    // de contexto del router.
    const root = new Owner();
    root.parent = getOwner();
    if (options?.router) {
        _registerContextOwner(root, new Map([[RouterKey, options.router]]));
        _debugRegisterRouter(options.router);
    }
    const cleanup = runWithOwner(root, () =>
        (component as ElurTemplate)._render(el, null),
    );
    return {
        unmount() {
            root.dispose();
            cleanup();
            if (options?.router) _debugUnregisterRouter(options.router);
        },
    };
}
