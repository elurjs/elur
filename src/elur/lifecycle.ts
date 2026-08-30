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

/**
 * The registry lives in the shared reactivity global state
 * (`Symbol.for("@elurjs/core/reactivity-state")`) rather than in module-local
 * state, so hooks work even when the package ends up duplicated in a bundle.
 */
interface _ComponentHookState {
    componentDebugHooks?: _ComponentDebugHooks | null;
    componentDebugHookSet?: Set<_ComponentDebugHooks>;
}

const _reactivityStateKey = Symbol.for("@elurjs/core/reactivity-state");

function _hookState(): _ComponentHookState {
    const g = globalThis as Record<PropertyKey, unknown>;
    let state = g[_reactivityStateKey] as _ComponentHookState | undefined;
    if (!state) {
        // reactivity.ts merges its defaults into this object when it loads.
        state = {};
        g[_reactivityStateKey] = state;
    }
    return state;
}

/** Single dispatcher on the hot path; the set is only for bookkeeping. */
function _syncComponentDebugHooks(state: _ComponentHookState): void {
    const set = state.componentDebugHookSet;
    if (!set || set.size === 0) {
        state.componentDebugHooks = null;
        return;
    }
    if (set.size === 1) {
        state.componentDebugHooks = set.values().next().value ?? null;
        return;
    }
    state.componentDebugHooks = {
        onMountStart(inst) {
            for (const hooks of set) hooks.onMountStart?.(inst);
        },
        onMountEnd(inst) {
            for (const hooks of set) hooks.onMountEnd?.(inst);
        },
        onUnmount(inst) {
            for (const hooks of set) hooks.onUnmount?.(inst);
        },
    };
}

export function _setComponentDebugHooks(hooks: _ComponentDebugHooks | null): void {
    const state = _hookState();
    const set = new Set<_ComponentDebugHooks>();
    if (hooks) set.add(hooks);
    state.componentDebugHookSet = set;
    _syncComponentDebugHooks(state);
}

/**
 * @internal — Adds a component debug hook subscriber WITHOUT replacing
 * existing ones (unlike `_setComponentDebugHooks`). Returns an unsubscribe
 * function. Zero cost when no subscribers are registered.
 */
export function _addComponentDebugHooks(hooks: _ComponentDebugHooks): () => void {
    const state = _hookState();
    let set = state.componentDebugHookSet;
    if (!set) {
        set = new Set<_ComponentDebugHooks>();
        if (state.componentDebugHooks) set.add(state.componentDebugHooks);
        state.componentDebugHookSet = set;
    }
    set.add(hooks);
    _syncComponentDebugHooks(state);
    return () => {
        set.delete(hooks);
        _syncComponentDebugHooks(state);
    };
}

export function _debugComponentMountStart(inst: ElurComponent): void {
    _hookState().componentDebugHooks?.onMountStart?.(inst);
}

export function _debugComponentMountEnd(inst: ElurComponent): void {
    _hookState().componentDebugHooks?.onMountEnd?.(inst);
}

export function _debugComponentUnmount(inst: ElurComponent): void {
    _hookState().componentDebugHooks?.onUnmount?.(inst);
}
