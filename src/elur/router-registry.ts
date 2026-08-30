// Router registry — tiny shared module holding the router injection key and
// the debug registry of mounted routers.
//
// It exists so that `component.ts` (the `mount()` entry) does NOT import
// `router.ts`: importing the full router module from `mount()` dragged the
// entire router (~1k lines) into consumer bundles, defeating tree-shaking
// for apps that only use signals + template + component.
//
// `router.ts` re-exports everything defined here, so the public API of the
// "./router" subpath is unchanged.

import { createInjectionKey } from "./context.js";
import type { Router } from "./router.js";

/** Injection key used to provide/resolve the active router. */
export const RouterKey = createInjectionKey<Router>("elur:router");

/**
 * Routers injected via mount({ router }) are not the global singleton. DevTools
 * tracks them separately so it can inspect the router actually active in the UI.
 *
 * @internal
 */
export const _mountedRouters: Router[] = [];

/** @internal Register a router that was injected via mount({ router }). */
export function _debugRegisterRouter(router: Router): void {
    const idx = _mountedRouters.indexOf(router);
    if (idx >= 0) _mountedRouters.splice(idx, 1);
    _mountedRouters.push(router);
}

/** @internal Unregister a router when its mount point is unmounted. */
export function _debugUnregisterRouter(router: Router): void {
    const idx = _mountedRouters.indexOf(router);
    if (idx >= 0) _mountedRouters.splice(idx, 1);
}
