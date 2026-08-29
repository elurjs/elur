// =============================================================================
// --- Public types ---
// =============================================================================

export type TemplateBindingContext =
    | { type: "node" }
    | { type: "event"; eventName: string; modifiers: string[]; hadOpenQuote: boolean }
    | { type: "attr"; attrName: string; hadOpenQuote: boolean; url?: boolean; executable?: boolean };

export interface TemplateDescriptor {
    readonly version: 1;
    readonly strings: readonly string[];
    readonly values: readonly unknown[];
    readonly contexts: readonly TemplateBindingContext[];
}

export interface ServerRenderProtocolContext {
    readonly markers: boolean;
    readonly signal?: AbortSignal;
    readonly context?: unknown;
    render(value: unknown, options?: { markers?: boolean }): Promise<string>;
}

/** Context passed to a custom value's `mountDom` protocol during client-side mount. */
export interface DomProtocolContext {
    readonly parent: Node;
    readonly before: Node | null;
    readonly context?: unknown;
}

/** Context passed to a custom value's `hydrateDom` protocol during hydration. */
export interface HydrationProtocolContext {
    readonly parent: Node;
    readonly bounds: { start: Comment; end: Comment } | null;
    readonly context?: unknown;
    /** Remounts a value inside the current bounds (used as fallback). */
    render(value: unknown): unknown;
}

export interface ElurRenderProtocol {
    renderServer?(context: ServerRenderProtocolContext): string | Promise<string>;
    mountDom?(context: DomProtocolContext): (() => void) | void;
    hydrateDom?(context: HydrationProtocolContext): (() => void) | void;
}

export const ELUR_TEMPLATE_DESCRIPTOR = Symbol.for("@elurjs/core/template-descriptor");
export const ELUR_RENDER_PROTOCOL = Symbol.for("@elurjs/core/render-protocol");

/**
 * Runtime feature capabilities, for tooling to detect support without
 * inferring it from version strings.
 *
 * NOTE: Partial attribute interpolation is now handled at compile time by
 * @elurjs/vite-plugin-elur. The core runtime does not support it natively.
 * Use the Vite plugin for partial interpolation support.
 */
export const templateFeatures = {
    /** Partial attribute interpolation (`class="btn ${size}"`) is supported. */
    partialAttributeInterpolation: false,
} as const;

export interface ElurTemplate {
    readonly __isElurTemplate: true;
    readonly [ELUR_TEMPLATE_DESCRIPTOR]?: TemplateDescriptor;
    readonly [ELUR_RENDER_PROTOCOL]?: ElurRenderProtocol;
    /** Mounts the template into a container element (public / root API). */
    mount(container: Element | string): ElurMountHandle;
    /** @internal Renders before `before` node (or appends to `parent`). Returns cleanup. */
    _render(parent: Node, before: Node | null): () => void;
}

export interface ElurMountHandle {
    unmount(): void;
}

/** Direct reference to a DOM element, assigned on mount and cleared on unmount. */
export interface ElurRef<T extends Element = Element> {
    el: T | null;
}

/** Creates an empty `ElurRef`. Use as `ref` attribute value in templates. */
export function ref<T extends Element = Element>(): ElurRef<T> {
    return { el: null };
}

/** Keyed list result for efficient DOM diffing via `repeat()`. */
export interface KeyedList<T = unknown> {
    readonly __isKeyedList: true;
    readonly items: T[];
    readonly keyFn: (item: T, index: number) => string | number;
    readonly renderFn: (item: T, index: number) => ElurTemplate | import("../lifecycle.js").ElurComponent;
}

export interface KEntry {
    start: Comment;
    end: Comment;
    cleanup: () => void;
}

/** Opaque token for a named portal target. */
export interface PortalOutlet {
    readonly __isPortalOutlet: true;
    /** @internal */
    _container: Element | null;
}

/** Fallback: a static template/component, or a factory receiving the error. */
export type ErrorFallback =
    | ElurTemplate
    | import("../lifecycle.js").ElurComponent
    | ((err: unknown) => ElurTemplate | import("../lifecycle.js").ElurComponent);

/** Content that can be wrapped with `transition()`. */
export type TransitionContent =
    | ElurTemplate
    | import("../lifecycle.js").ElurComponent
    | (() => ElurTemplate | import("../lifecycle.js").ElurComponent | null);

export const COMMENT = {
    SCOPE: "elur-scope",
    ERROR_BOUNDARY: "elur-eb",
    TRANSITION: "elur-t",
    KEYED_START: "elur-ks",
    KEYED_END: "elur-ke",
    KEYED_ZONE: "elur-kz",
} as const;

// =============================================================================
// --- DOM inspection helpers ---
// =============================================================================

export function isElurTemplate(v: unknown): v is ElurTemplate {
    return (
        v != null &&
        typeof v === "object" &&
        (v as Record<string, unknown>).__isElurTemplate === true
    );
}

export function isKeyedList(v: unknown): v is KeyedList {
    return (
        v != null &&
        typeof v === "object" &&
        (v as Record<string, unknown>).__isKeyedList === true
    );
}
