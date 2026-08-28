import type { ElurTemplate } from "./template/index.js";

// --- ElurChildren ---

/** Valid child content for components. */
export type ElurChildren =
    | ElurTemplate
    | ElurComponent
    | Array<ElurTemplate | ElurComponent>
    | null
    | undefined;

// --- ElurComponent ---

/** Base class for components with lifecycle hooks. */
export abstract class ElurComponent {
    /** @internal */
    readonly __isElurComponent = true as const;

    /** Default slot — child content injected by the parent. */
    children?: ElurChildren;

    /** Optional label used by devtools. Falls back to class name. */
    _debugName?: string;

    /** @internal */
    private _slots = new Map<string, ElurChildren>();

    /** Sets the default slot content. Returns `this` for chaining. */
    setChildren(content: ElurChildren): this {
        this.children = content;
        return this;
    }

    /** Sets a named slot. Returns `this` for chaining. */
    setSlot(name: string, content: ElurChildren): this {
        this._slots.set(name, content);
        return this;
    }

    /** Returns content for a named slot. */
    slot(name: string): ElurChildren {
        return this._slots.get(name);
    }

    /** Sets an explicit devtools display name. Returns `this` for chaining. */
    setDebugName(name: string): this {
        this._debugName = name;
        return this;
    }

    /** Returns the component template. Called once on mount; updates happen via signals. */
    abstract render(): ElurTemplate;

    /** Called before `render()` — no DOM yet. Errors are caught by `onError` if present. */
    onInit?(): void;

    /** Server-only lifecycle hook. Runs during SSR after `onInit()`; never on the client. */
    onServerRender?(): void;

    /** Called after DOM insertion. May return a cleanup function. */
    onMount?(): (() => void) | void;

    /** Called before DOM removal. */
    onUnmount?(): void;

    /** Catches errors thrown in `onInit` and `onMount`. */
    onError?(err: unknown): void;
}

// --- Type guard ---

/** @internal */
export function isElurComponent(v: unknown): v is ElurComponent {
    return (
        v != null &&
        typeof v === "object" &&
        (v as Record<string, unknown>).__isElurComponent === true
    );
}

// --- Devtools component tracking (internal) ---

export interface _ComponentDebugHooks {
    onMountStart?: (inst: ElurComponent) => void;
    onMountEnd?: (inst: ElurComponent) => void;
    onUnmount?: (inst: ElurComponent) => void;
}

let _componentDebugHooks: _ComponentDebugHooks | null = null;

export function _setComponentDebugHooks(hooks: _ComponentDebugHooks | null): void {
    _componentDebugHooks = hooks;
}

export function _debugComponentMountStart(inst: ElurComponent): void {
    _componentDebugHooks?.onMountStart?.(inst);
}

export function _debugComponentMountEnd(inst: ElurComponent): void {
    _componentDebugHooks?.onMountEnd?.(inst);
}

export function _debugComponentUnmount(inst: ElurComponent): void {
    _componentDebugHooks?.onUnmount?.(inst);
}
