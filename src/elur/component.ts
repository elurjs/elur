import type { ElurTemplate, ElurMountHandle } from "./template/index.js";
import {
    isElurComponent,
    _debugComponentMountStart,
    _debugComponentMountEnd,
    _debugComponentUnmount,
    type ElurComponent,
} from "./lifecycle.js";
import { _pushComponentContext, _popComponentContext, provide } from "./context.js";
import { RouterKey, type Router, _debugRegisterRouter, _debugUnregisterRouter } from "./router.js";

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
 * Mounts a ElurTemplate or ElurComponent into the DOM.
 *
 *   mount(Counter(), "#app");   // ElurTemplate (function component)
 *   mount(new Timer(), "#app"); // ElurComponent (class with lifecycle)
 *
 * @param component ElurTemplate (result of html``) or a ElurComponent instance.
 * @param container CSS selector or HTMLElement to mount into.
 * @returns         { unmount() } — disposes effects and removes DOM.
 */
export function mount(
    component: ElurTemplate | ElurComponent,
    container: Element | string,
    options?: MountOptions
): ElurMountHandle {
    if (isElurComponent(component)) {
        const el = _resolveContainer(container);

        _debugComponentMountStart(component);
        _pushComponentContext();
        let cleanup: () => void = () => { };
        let renderFailed = false;
        try {
            if (options?.router) {
                provide(RouterKey, options.router);
                _debugRegisterRouter(options.router);
            }
            try { component.onInit?.(); } catch (e) { if (component.onError) component.onError(e); else throw e; }
            try {
                cleanup = component.render()._render(el, null);
            } catch (e) {
                if (component.onError) {
                    component.onError(e);
                    cleanup = () => { };
                    renderFailed = true;
                } else {
                    throw e;
                }
            }
        } finally {
            _debugComponentMountEnd(component);
            _popComponentContext();
        }

        let mountCleanup: (() => void) | undefined;
        if (!renderFailed) {
            try {
                const ret = component.onMount?.();
                if (typeof ret === "function") mountCleanup = ret;
            } catch (e) {
                if (component.onError) component.onError(e);
                else throw e;
            }
        }

        return {
            unmount() {
                try { component.onUnmount?.(); } catch { /* ignore */ }
                try { mountCleanup?.(); } catch { /* ignore */ }
                cleanup();
                if (options?.router) _debugUnregisterRouter(options.router);
                _debugComponentUnmount(component);
            },
        };
    }

    if (!options?.router) {
        // ElurTemplate: delegar al método .mount() interno
        return (component as ElurTemplate).mount(container);
    }

    // For template roots, create a context frame so elurRouter()/inject() can resolve.
    const el = _resolveContainer(container);
    _pushComponentContext();
    let cleanup: () => void;
    try {
        provide(RouterKey, options.router);
        _debugRegisterRouter(options.router);
        cleanup = (component as ElurTemplate)._render(el, null);
    } finally {
        _popComponentContext();
    }

    return {
        unmount() {
            cleanup();
            _debugUnregisterRouter(options.router!);
        },
    };
}
