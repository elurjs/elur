import { batch, createRoot, signal, type Signal } from "./reactivity.js";
import { isElurComponent } from "../lifecycle.js";
import { ComponentInstance, isComponentInvocation } from "./component.js";
import { _mountComponentWithCtx } from "../template/mount-helpers.js";
import { isElurTemplate, type KEntry, type KeyedList } from "../template/types.js";
import { getSequence, type RepeatKey } from "../template/keyed.js";

// =============================================================================
// --- next/ — keyed list reconciliation con ownership por item ---
// Fork de ../template/keyed-diff.ts: igual que el actual, pero cada item monta
// bajo su propio root owner (createRoot del grafo next). Sus effects internos
// pertenecen al item y no al effect del repeat — así sobreviven a re-orders
// y se destruyen con entry.cleanup() al removerse (A.11/B.10 del plan).
// =============================================================================

/**
 * C.16.1: lista keyed "live" — renderItem recibe accessors (`getItem`,
 * `getIndex`) en vez del item capturado. Misma key + objeto nuevo → las
 * señales del item se actualizan y los bindings re-corren sin remount,
 * preservando identidad de DOM y estado del item.
 */
export interface LiveKeyedList<T = unknown> {
    readonly __isKeyedList: true;
    readonly live: true;
    readonly items: T[];
    readonly keyFn: (item: T, index: number) => string | number;
    readonly renderItem: (getItem: () => T, getIndex: () => number) => unknown;
}

export function repeatLive<T>(
    items: T[],
    keyFn: (item: T, index: number) => string | number,
    renderItem: (getItem: () => T, getIndex: () => number) => unknown,
): LiveKeyedList<T> {
    return { __isKeyedList: true as const, live: true as const, items, keyFn, renderItem };
}

/**
 * Mounts a single keyed item's rendered value before `endMarker` inside `parent`.
 * Used by the DOM renderer and the hydration renderer so both engines share the
 * exact same reconciliation semantics.
 */
export function createKeyedMount(
    ctxSnapshot: Map<unknown, unknown>[],
): (rendered: unknown, parent: Node, endMarker: Node) => () => void {
    return (rendered: unknown, parent: Node, endMarker: Node): (() => void) => {
        let inner: (() => void) | void;
        const disposeOwner = createRoot((dispose) => {
            if (isElurComponent(rendered)) {
                inner = _mountComponentWithCtx(rendered, parent, endMarker, ctxSnapshot);
            } else if (isComponentInvocation(rendered)) {
                // Invocación funcional: montar por el kernel — setup una vez,
                // owner propio dentro del root del item.
                const inst = new ComponentInstance(rendered);
                inst.mount(parent, endMarker, { ctxSnapshot });
                inner = () => inst.unmount();
            } else if (isElurTemplate(rendered)) {
                inner = rendered._render(parent, endMarker);
            } else if (rendered != null && rendered !== false) {
                const node = document.createTextNode(String(rendered));
                parent.insertBefore(node, endMarker);
                inner = () => node.parentNode?.removeChild(node);
            }
            return dispose;
        });
        return () => {
            inner?.();
            disposeOwner();
        };
    };
}

/**
 * C.16.1: entry con el item que la originó — detecta el caso
 * "misma key, objeto nuevo" (el renderFn capturó el item viejo).
 */
interface KeyedItemEntry extends KEntry {
    item: unknown;
    /** C.16.1 live: señal por item (sólo en repeatLive). */
    itemSig?: import("./reactivity.js").Signal<unknown>;
    indexSig?: import("./reactivity.js").Signal<number>;
}

export interface KeyedDiffOptions {
    /** Node marking the start of the keyed zone. */
    zoneStart: Node;
    /** End boundary; new content is inserted before this node. */
    anchor: Node;
    /** Live map of key → entry (start/end markers + cleanup). */
    state: Map<RepeatKey, KEntry>;
    /** Key order from the previous reconciliation pass. */
    prevOrder: RepeatKey[];
    /** The current keyed list value (clásica o live). */
    list: KeyedList | LiveKeyedList;
    /** Mounts a freshly rendered item into the DOM. */
    mount: (rendered: unknown, parent: Node, endMarker: Node) => () => void;
    /** Context snapshot for component mounts inside the effect. */
    ctxSnapshot?: Map<unknown, unknown>[];
    /** Called when a duplicate key is encountered. */
    onDuplicateKey?: (key: RepeatKey) => void;
}

/**
 * Reconciles a keyed list between `zoneStart` and `anchor` using the same LIS
 * algorithm used by the DOM renderer. Total replacement (O(1)) when no key
 * survives; otherwise remove/insert/move with minimal DOM operations.
 */
export function reconcileKeyedList(opts: KeyedDiffOptions): void {
    const { zoneStart, anchor, prevOrder, list, mount } = opts;
    const state = opts.state as Map<RepeatKey, KeyedItemEntry>;
    const live = (list as LiveKeyedList).live === true;
    // Render del item i-ésimo: live → accessors + señales; clásico → valor.
    const renderItem = (i: number): { rendered: unknown; itemSig?: Signal<unknown>; indexSig?: Signal<number> } => {
        const item = list.items[i];
        if (!live) return { rendered: (list as KeyedList).renderFn(item as never, i) };
        const itemSig = signal<unknown>(item);
        const indexSig = signal<number>(i);
        const rendered = (list as LiveKeyedList).renderItem(
            () => itemSig.value as never,
            () => indexSig.value,
        );
        return { rendered, itemSig, indexSig };
    };
    const parent = anchor.parentNode;
    if (!parent) return;

    const newKeyOrder: RepeatKey[] = list.items.map((item, idx) => list.keyFn(item as never, idx));
    const newKeySet = new Set(newKeyOrder);

    let anyKeysSurvive = false;
    if (state.size > 0) {
        for (const k of state.keys()) {
            if (newKeySet.has(k)) {
                anyKeysSurvive = true;
                break;
            }
        }
    }

    // 1. Initial render or total replacement (O(1) path)
    if (!anyKeysSurvive) {
        if (state.size > 0) {
            // Sibling walk — Range.deleteContents es patológico en
            // happy-dom sobre zonas de miles de nodos.
            let node: Node | null = zoneStart.nextSibling;
            while (node && node !== anchor) {
                const next = node.nextSibling;
                node.parentNode?.removeChild(node);
                node = next;
            }
            for (const entry of state.values()) entry.cleanup();
            state.clear();
        }

        if (newKeyOrder.length > 0) {
            const frag = document.createDocumentFragment();
            batch(() => {
                for (let i = 0; i < newKeyOrder.length; i++) {
                    const key = newKeyOrder[i];
                    const item = list.items[i];
                    const start = document.createTextNode("") as unknown as Comment;
                    const end = document.createTextNode("") as unknown as Comment;

                    frag.appendChild(start);
                    frag.appendChild(end);

                    const { rendered, itemSig, indexSig } = renderItem(i);
                    const cleanup = mount(rendered, frag, end);

                    if (state.has(key)) opts.onDuplicateKey?.(key);
                    state.set(key, { start, end, cleanup, item, itemSig, indexSig });
                }
            });
            parent.insertBefore(frag, anchor);
        }
        prevOrder.length = 0;
        prevOrder.push(...newKeyOrder);
        return;
    }

    // C.16.2: fast paths — prefix/suffix comunes sin Map/LIS. Si cubren el
    // diff completo (append, prepend, truncate, insert/remove en el medio)
    // terminamos aquí; si el medio tiene moves, cae al camino LIS completo.
    const updateLiveEntry = (key: RepeatKey, i: number) => {
        const e = state.get(key);
        if (e?.itemSig) {
            const it = list.items[i];
            if (e.item !== it || e.indexSig!.peek() !== i) {
                batch(() => {
                    e.item = it;
                    e.itemSig!.value = it;
                    e.indexSig!.value = i;
                });
            }
        }
    };
    {
        let pi = 0;
        const minLen = Math.min(prevOrder.length, newKeyOrder.length);
        while (pi < minLen && prevOrder[pi] === newKeyOrder[pi]) pi++;
        let pj = prevOrder.length - 1;
        let nk = newKeyOrder.length - 1;
        while (pj >= pi && nk >= pi && prevOrder[pj] === newKeyOrder[nk]) {
            pj--;
            nk--;
        }
        if (pi > pj || pi > nk) {
            // Cubierto por prefix+suffix: el medio es sólo insertar o borrar.
            for (let m = 0; m < pi; m++) updateLiveEntry(newKeyOrder[m], m);
            for (let m = nk + 1; m < newKeyOrder.length; m++) {
                updateLiveEntry(newKeyOrder[m], m);
            }
            if (pi <= pj) {
                // Borrar prev[pi..pj]
                for (let m = pi; m <= pj; m++) {
                    const key = prevOrder[m];
                    const entry = state.get(key)!;
                    entry.cleanup();
                    let node: Node | null = entry.start;
                    while (node) {
                        const next: ChildNode | null = node === entry.end ? null : node.nextSibling;
                        node.parentNode?.removeChild(node);
                        if (!next) break;
                        node = next;
                    }
                    state.delete(key);
                }
            }
            if (pi <= nk) {
                // Insertar new[pi..nk] antes del primer item del suffix
                // (prevOrder[pi] sobrevivió — si no hay suffix, anchor).
                const refNode = pi < prevOrder.length
                    ? state.get(prevOrder[pi])!.start
                    : anchor;
                const frag = document.createDocumentFragment();
                batch(() => {
                    for (let m = pi; m <= nk; m++) {
                        const key = newKeyOrder[m];
                        const sMarker = document.createTextNode("") as unknown as Comment;
                        const eMarker = document.createTextNode("") as unknown as Comment;
                        frag.appendChild(sMarker);
                        frag.appendChild(eMarker);
                        const { rendered, itemSig, indexSig } = renderItem(m);
                        const cleanup = mount(rendered, frag, eMarker);
                        if (state.has(key)) opts.onDuplicateKey?.(key);
                        state.set(key, { start: sMarker, end: eMarker, cleanup, item: list.items[m], itemSig, indexSig });
                    }
                });
                parent.insertBefore(frag, refNode);
            }
            prevOrder.length = 0;
            prevOrder.push(...newKeyOrder);
            return;
        }
    }

    // 2. Reconciliation with LIS
    const keyToNewIndex = new Map<RepeatKey, number>();
    for (let i = 0; i < newKeyOrder.length; i++) {
        keyToNewIndex.set(newKeyOrder[i], i);
    }

    const newIndexToOldIndexMap = new Int32Array(newKeyOrder.length);
    let moved = false;
    let maxNewIndexSoFar = 0;

    for (let i = 0; i < prevOrder.length; i++) {
        const key = prevOrder[i];
        const newIndex = keyToNewIndex.get(key);

        if (newIndex === undefined) {
            const entry = state.get(key)!;
            entry.cleanup();
            let node: Node | null = entry.start;
            while (node) {
                const next: ChildNode | null = node === entry.end ? null : node.nextSibling;
                node.parentNode?.removeChild(node);
                if (!next) break;
                node = next;
            }
            state.delete(key);
        } else {
            newIndexToOldIndexMap[newIndex] = i + 1;
            if (newIndex >= maxNewIndexSoFar) {
                maxNewIndexSoFar = newIndex;
            } else {
                moved = true;
            }
        }
    }

    const increasingNewIndexSequence = moved ? getSequence(newIndexToOldIndexMap) : [];
    let j = increasingNewIndexSequence.length - 1;
    let insertionPoint: Node = anchor;

    for (let i = newKeyOrder.length - 1; i >= 0; i--) {
        const key = newKeyOrder[i];
        const isNew = newIndexToOldIndexMap[i] === 0;

        if (isNew) {
            const it = list.items[i];
            const sMarker = document.createTextNode("") as unknown as Comment;
            const eMarker = document.createTextNode("") as unknown as Comment;
            const frag = document.createDocumentFragment();

            frag.appendChild(sMarker);
            frag.appendChild(eMarker);

            const { rendered, itemSig, indexSig } = renderItem(i);
            const cleanup = mount(rendered, frag, eMarker);

            if (state.has(key)) opts.onDuplicateKey?.(key);
            state.set(key, { start: sMarker, end: eMarker, cleanup, item: it, itemSig, indexSig });
            parent.insertBefore(frag, insertionPoint);
            insertionPoint = sMarker;
        } else {
            const entry = state.get(key)!;
            // C.16.1 (live): misma key + objeto nuevo → actualizar las
            // señales del item — bindings re-corren, DOM preservado.
            if (entry.itemSig) {
                const newItem = list.items[i];
                if (entry.item !== newItem || entry.indexSig!.peek() !== i) {
                    batch(() => {
                        entry.item = newItem;
                        entry.itemSig!.value = newItem;
                        entry.indexSig!.value = i;
                    });
                }
            }
            if (moved) {
                if (j < 0 || i !== increasingNewIndexSequence[j]) {
                    let node: Node | null = entry.start;
                    while (node) {
                        const next: ChildNode | null = node === entry.end ? null : node.nextSibling;
                        parent.insertBefore(node, insertionPoint);
                        if (!next) break;
                        node = next;
                    }
                } else {
                    j--;
                }
            }
            insertionPoint = entry.start;
        }
    }

    prevOrder.length = 0;
    prevOrder.push(...newKeyOrder);
}
