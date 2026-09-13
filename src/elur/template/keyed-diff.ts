import { batch, createRoot, signal, type Signal } from "../reactivity.js";
import { isElurComponent } from "../lifecycle.js";
import { ComponentInstance, isComponentInvocation } from "../component-kernel.js";
import { _mountComponentWithCtx } from "./mount-helpers.js";
import { isElurTemplate, type KEntry, type KeyedList } from "./types.js";
import { getSequence, _keyedItemsEqual, type RepeatKey } from "./keyed.js";
import { _captureContextSnapshot } from "../context.js";

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
 * Entry con contenido single-node: los markers start/end se eliminan y el
 * nodo mismo actúa como ambos bounds — 2 nodos menos por entry y menos
 * trabajo en remove/move/clear. Multi-nodo/vacío conserva los markers.
 */
function createKeyedEntry(
    rendered: unknown,
    frag: DocumentFragment,
    mount: (rendered: unknown, parent: Node, endMarker: Node) => () => void,
): { start: Comment; end: Comment; cleanup: () => void } {
    const start = document.createTextNode("") as unknown as Comment;
    const end = document.createTextNode("") as unknown as Comment;
    frag.appendChild(start);
    frag.appendChild(end);
    const cleanup = mount(rendered, frag, end);
    const first = start.nextSibling;
    if (first !== null && first !== end && first === end.previousSibling) {
        frag.removeChild(start);
        frag.removeChild(end);
        return { start: first as unknown as Comment, end: first as unknown as Comment, cleanup };
    }
    return { start, end, cleanup };
}

/**
 * `moveBefore` (Chrome 133+) mueve un nodo sin desconectarlo — preserva
 * iframes, focus y animaciones en reorders. Fallback a insertBefore.
 */
const moveNode: (parent: Node, node: Node, before: Node | null) => void =
    typeof Element !== "undefined" && "moveBefore" in Element.prototype
        ? (parent, node, before) => (parent as Element).moveBefore(node, before)
        : (parent, node, before) => parent.insertBefore(node, before);

/**
 * C.16.1: entry con el item que la originó — detecta el caso
 * "misma key, objeto nuevo" (el renderFn capturó el item viejo).
 */
interface KeyedItemEntry extends KEntry {
    item: unknown;
    /** C.16.1 live: señal por item (sólo en repeatLive). */
    itemSig?: import("../reactivity.js").Signal<unknown>;
    indexSig?: import("../reactivity.js").Signal<number>;
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

    /**
     * C.16.4 (clásico): entry cuya key sobrevivió pero cuyo item fue
     * reemplazado por otro objeto → remount in-place (los bindings
     * capturaron el item viejo). Las live no pasan por aquí: sus
     * bindings leen itemSig y se actualizan por señal.
     */
    const remountItem = (key: RepeatKey, i: number, ref: Node | null): void => {
        const entry = state.get(key)!;
        entry.cleanup();
        let node: Node | null = entry.start;
        while (node) {
            const next: ChildNode | null = node === entry.end ? null : node.nextSibling;
            node.parentNode?.removeChild(node);
            if (!next) break;
            node = next;
        }
        const frag = document.createDocumentFragment();
        const { rendered } = renderItem(i);
        const ne = createKeyedEntry(rendered, frag, mount);
        state.set(key, { ...ne, item: list.items[i] });
        parent.insertBefore(frag, ref);
    };
    const remountIfReplaced = (key: RepeatKey, i: number): void => {
        const entry = state.get(key);
        if (entry && !entry.itemSig && !_keyedItemsEqual(entry.item, list.items[i])) {
            remountItem(key, i, entry.end.nextSibling);
        }
    };

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
                    const { rendered, itemSig, indexSig } = renderItem(i);
                    const entry = createKeyedEntry(rendered, frag, mount);
                    if (state.has(key)) opts.onDuplicateKey?.(key);
                    state.set(key, { ...entry, item, itemSig, indexSig });
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
            const sameItem = _keyedItemsEqual(e.item, it);
            e.item = it;
            if (!sameItem || e.indexSig!.peek() !== i) {
                batch(() => {
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
            // C.16.4: mismos checks para listas clásicas (remount in-place).
            for (let m = 0; m < pi; m++) remountIfReplaced(newKeyOrder[m], m);
            for (let m = nk + 1; m < newKeyOrder.length; m++) {
                remountIfReplaced(newKeyOrder[m], m);
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
                        const { rendered, itemSig, indexSig } = renderItem(m);
                        const entry = createKeyedEntry(rendered, frag, mount);
                        if (state.has(key)) opts.onDuplicateKey?.(key);
                        state.set(key, { ...entry, item: list.items[m], itemSig, indexSig });
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
            const frag = document.createDocumentFragment();
            const { rendered, itemSig, indexSig } = renderItem(i);
            const entry = createKeyedEntry(rendered, frag, mount);
            if (state.has(key)) opts.onDuplicateKey?.(key);
            state.set(key, { ...entry, item: it, itemSig, indexSig });
            parent.insertBefore(frag, insertionPoint);
            insertionPoint = entry.start;
        } else {
            let entry = state.get(key)!;
            // C.16.1 (live): misma key + objeto nuevo → actualizar las
            // señales del item — bindings re-corren, DOM preservado.
            if (entry.itemSig) {
                const newItem = list.items[i];
                const sameItem = _keyedItemsEqual(entry.item, newItem);
                entry.item = newItem;
                if (!sameItem || entry.indexSig!.peek() !== i) {
                    batch(() => {
                        entry.itemSig!.value = newItem;
                        entry.indexSig!.value = i;
                    });
                }
            } else if (!_keyedItemsEqual(entry.item, list.items[i])) {
                // C.16.4 (clásico): mismo caso sin accessors → remount.
                // Insertar antes de insertionPoint equivale a su posición
                // final en el walk reverso; se conserva el bookkeeping LIS.
                remountItem(key, i, insertionPoint);
                entry = state.get(key)!;
                if (moved && j >= 0 && i === increasingNewIndexSequence[j]) j--;
                insertionPoint = entry.start;
                continue;
            }
            if (moved) {
                if (j < 0 || i !== increasingNewIndexSequence[j]) {
                    let node: Node | null = entry.start;
                    while (node) {
                        const next: ChildNode | null = node === entry.end ? null : node.nextSibling;
                        moveNode(parent, node, insertionPoint);
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

// =============================================================================
// B.12.7 — liveList(): lista con mutación incremental (deltas, estilo DBSP)
// =============================================================================

interface DeltaEntry<T> {
    key: RepeatKey;
    item: T;
    itemSig: Signal<T>;
    indexSig: Signal<number>;
    start: Node;
    end: Node;
    cleanup: () => void;
}

/**
 * B.12.7: lista keyed mutable — los mutadores aplican deltas directos al DOM
 * (insert/remove/set/move) sin re-correr la reconciliación. La renderFn recibe
 * accessors como `repeatLive` — set() actualiza la señal del item sin remount.
 *
 * ```ts
 * const list = liveList({ key: u => u.id, render: (getItem) => html`<li>${() => getItem().name}</li>` });
 * html`<ul>${list}</ul>`          // monta la zona vacía
 * list.push({id:1,name:"a"});      // inserta sin diff
 * list.set(1, {id:1,name:"b"});    // actualiza in-place
 * list.remove(1);
 * ```
 */
export interface DeltaList<T, K = string | number> {
    readonly __isKeyedList: true;
    readonly delta: true;
    readonly items: readonly T[];
    readonly length: number;
    /** @internal — monta la zona (markers + entries) antes de `anchor`. */
    _mount(parent: Node, anchor: Node): void;
    push(item: T): number;
    insert(index: number, item: T): void;
    remove(key: K): boolean;
    set(key: K, item: T): boolean;
    move(key: K, toIndex: number): void;
    clear(): void;
    /** @internal — dispone todo el subárbol. */
    _dispose(): void;
}

export function liveList<T, K extends string | number>(opts: {
    key: (item: T) => K;
    render: (getItem: () => T, getIndex: () => number) => unknown;
}): DeltaList<T, K> {
    const entries: DeltaEntry<T>[] = [];
    const byKey = new Map<K, DeltaEntry<T>>();
    let parent: Node | null = null;
    let zoneEnd: Node | null = null;
    let mountFn: ((r: unknown, p: Node, e: Node) => () => void) | null = null;

    const api: DeltaList<T, K> = {
        __isKeyedList: true as const,
        delta: true as const,
        get items() { return entries.map((e) => e.item); },
        get length() { return entries.length; },

        _mount(p: Node, anchor: Node): void {
            if (parent) return; // ya montada — idempotente
            parent = p;
            zoneEnd = anchor;
            mountFn = createKeyedMount(_captureContextSnapshot());
        },

        push(item: T): number {
            api.insert(entries.length, item);
            return entries.length - 1;
        },

        insert(index: number, item: T): void {
            if (!parent || !zoneEnd || !mountFn) {
                throw new Error("[elur-next2] liveList: la lista no está montada (úsala en un binding primero).");
            }
            const key = opts.key(item);
            if (byKey.has(key)) {
                console.warn(`[elur] liveList: duplicate key "${key}".`);
                return;
            }
            index = Math.max(0, Math.min(index, entries.length));
            const sMarker = document.createTextNode("");
            const eMarker = document.createTextNode("");
            const ref = index < entries.length ? entries[index].start : zoneEnd;
            parent.insertBefore(sMarker, ref);
            parent.insertBefore(eMarker, ref);
            const itemSig = signal(item);
            const indexSig = signal(index);
            const rendered = opts.render(() => itemSig.value, () => indexSig.value);
            const cleanup = mountFn(rendered, parent, eMarker);
            const entry: DeltaEntry<T> = { key, item, itemSig, indexSig, start: sMarker, end: eMarker, cleanup };
            entries.splice(index, 0, entry);
            byKey.set(key, entry);
            // Deltas de índice para los desplazados.
            for (let i = index + 1; i < entries.length; i++) entries[i].indexSig.value = i;
        },

        remove(key: K): boolean {
            const entry = byKey.get(key);
            if (!entry || !parent) return false;
            const i = entries.indexOf(entry);
            entry.cleanup();
            let node: Node | null = entry.start;
            while (node) {
                const next: ChildNode | null = node === entry.end ? null : node.nextSibling;
                parent.removeChild(node);
                if (!next) break;
                node = next;
            }
            entries.splice(i, 1);
            byKey.delete(key);
            for (let j = i; j < entries.length; j++) entries[j].indexSig.value = j;
            return true;
        },

        set(key: K, item: T): boolean {
            const entry = byKey.get(key);
            if (!entry) return false;
            entry.item = item;
            entry.itemSig.value = item;
            return true;
        },

        move(key: K, toIndex: number): void {
            const entry = byKey.get(key);
            if (!entry || !parent) return;
            const from = entries.indexOf(entry);
            toIndex = Math.max(0, Math.min(toIndex, entries.length - 1));
            if (from === toIndex) return;
            const ref = toIndex > from ? entries[toIndex].end.nextSibling : entries[toIndex].start;
            let node: Node | null = entry.start;
            while (node) {
                const next: ChildNode | null = node === entry.end ? null : node.nextSibling;
                moveNode(parent, node, ref);
                if (!next) break;
                node = next;
            }
            entries.splice(from, 1);
            entries.splice(toIndex, 0, entry);
            const lo = Math.min(from, toIndex), hi = Math.max(from, toIndex);
            for (let i = lo; i <= hi; i++) entries[i].indexSig.value = i;
        },

        clear(): void {
            // Bulk: las entries son contiguas en el DOM entre
            // entries[0].start y zoneEnd — sibling walk por nodos (O(n);
            // Range.deleteContents es patológico en happy-dom y el walk
            // evita indexOf+splice+deltas por fila = O(n²)).
            if (parent && zoneEnd && entries.length > 0) {
                let node: Node | null = entries[0].start;
                while (node && node !== zoneEnd) {
                    const nextNode: Node | null = node.nextSibling;
                    node.parentNode?.removeChild(node);
                    node = nextNode;
                }
            }
            for (const e of entries) e.cleanup();
            entries.length = 0;
            byKey.clear();
        },

        _dispose(): void {
            api.clear();
            parent = null;
            zoneEnd = null;
        },
    };
    return api;
}
