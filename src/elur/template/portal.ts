import { isElurComponent } from "../lifecycle.js";
import type { ElurComponent } from "../lifecycle.js";
import { provide, inject, createInjectionKey } from "../context.js";
import type { ElurTemplate, ElurMountHandle, ElurRef, PortalOutlet } from "./types.js";
import { _mountComponent } from "./mount-helpers.js";

// =============================================================================
// --- PortalOutlet ---
// =============================================================================

/** Creates a PortalOutlet token for decoupled portal targeting. */
export function createPortalOutlet(): PortalOutlet {
    return { __isPortalOutlet: true as const, _container: null };
}

/** Declares the DOM anchor for a PortalOutlet inside a template. */
export function portalOutlet(outlet: PortalOutlet): ElurTemplate {
    return {
        __isElurTemplate: true as const,
        mount(container: Element | string): ElurMountHandle {
            const el =
                typeof container === "string"
                    ? (document.querySelector(container) ?? document.body)
                    : container;
            const cleanup = this._render(el, null);
            return { unmount: cleanup };
        },
        _render(parent: Node, before: Node | null): () => void {
            const el = document.createElement("div");
            el.setAttribute("data-elur-outlet", "");
            outlet._container = el;
            parent.insertBefore(el, before);
            return () => {
                outlet._container = null;
                el.remove();
            };
        },
    };
}

// =============================================================================
// --- portal() ---
// =============================================================================

/**
 * Renders `content` into `target` instead of the current tree position.
 * Useful for modals, tooltips, and overlays that must escape overflow clipping.
 * Returns a ElurTemplate — works inside reactive conditionals.
 *
 * @param content  Template or component to render.
 * @param target   CSS selector, Element, PortalOutlet, or ElurRef. Defaults to `document.body`.
 */
export function portal(
    content: ElurTemplate | ElurComponent,
    target: Element | string | PortalOutlet | ElurRef<Element> = document.body
): ElurTemplate {
    return {
        __isElurTemplate: true as const,

        mount(container: Element | string): ElurMountHandle {
            const el =
                typeof container === "string"
                    ? (document.querySelector(container) ?? document.body)
                    : container;
            const cleanup = this._render(el, null);
            return { unmount: cleanup };
        },

        _render(_parent: Node, _before: Node | null): () => void {
            let targetEl: Element;
            if (typeof target === "string") {
                targetEl = document.querySelector(target) ?? document.body;
            } else if (target instanceof Element) {
                targetEl = target;
            } else if ("__isPortalOutlet" in target) {
                targetEl = (target as PortalOutlet)._container ?? document.body;
            } else {
                targetEl = (target as ElurRef<Element>).el ?? document.body;
            }

            if (isElurComponent(content)) {
                return _mountComponent(content, targetEl, null);
            }

            return content._render(targetEl, null);
        },
    };
}

// =============================================================================
// --- Portal outlet via provide/inject ---
// =============================================================================

const _OUTLET_KEY = createInjectionKey<PortalOutlet>("elur:portal-outlet");

/** Provides a PortalOutlet to descendant components via dependency injection. */
export function provideOutlet(outlet: PortalOutlet): void {
    provide(_OUTLET_KEY, outlet);
}

/** Injects the nearest PortalOutlet provided by an ancestor. */
export function injectOutlet(): PortalOutlet | undefined {
    return inject(_OUTLET_KEY);
}
