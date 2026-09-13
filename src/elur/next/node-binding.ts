// =============================================================================
// --- next/ — reactive node binding con render-queue + cola DOM tipada ---
// Fork de ../template/node-binding.ts (B.8/B.11): el binding corre en la cola
// de render effects (antes que user effects) y los writes de texto usan la cola
// tipada con last-write-wins por binding id.
// =============================================================================

import { _renderEffect } from "./reactivity.js";
import {
    ComponentInstance,
    isComponentInvocation,
    isElurSlot,
    type ComponentInvocation,
    type Slot,
} from "./component.js";
import { runWithOwner } from "./reactivity.js";
import { isElurComponent } from "../lifecycle.js";
import { _captureContextSnapshot } from "../context.js";
import type { KEntry } from "../template/types.js";
import type { RepeatKey } from "../template/keyed.js";
import { isElurTemplate, isKeyedList, ELUR_RENDER_PROTOCOL } from "../template/types.js";
import {
    _mountComponent,
    _mountComponentWithCtx,
    _mountComponentDeferred,
    _deferOnMount,
} from "./mount-helpers.js";
import { createKeyedMount, reconcileKeyedList } from "./keyed-diff.js";
import { queueDomWrite } from "./dom-write.js";

// =============================================================================
// --- Reactive node binding ---
// =============================================================================

/**
 * Activates a reactive node binding at `anchor`.
 * Handles: text, ElurTemplate, ElurComponent, KeyedList, Array, and static values.
 * Pushes dispose functions into `disposes`.
 */
export function activateNodeBinding(
    anchor: Text,
    value: unknown,
    disposes: Array<() => void>,
    postMountHooks: Array<() => void>,
): void {
    if (typeof value !== "function") {
        // A.14: slot declarado directamente — render bajo el owner del declarante
        if (isElurSlot(value)) {
            value = runWithOwner(value.owner, () => (value as Slot).render());
        }
        if (value != null && typeof value === "object" && (value as Record<PropertyKey, unknown>)[ELUR_RENDER_PROTOCOL] != null) {
            const proto = (value as Record<PropertyKey, unknown>)[ELUR_RENDER_PROTOCOL] as { mountDom?: (ctx: import("../template/types.js").DomProtocolContext) => (() => void) | void };
            if (proto.mountDom) {
                const cleanup = proto.mountDom({
                    parent: anchor.parentNode!,
                    before: anchor,
                });
                if (cleanup) disposes.push(cleanup);
                return;
            }
        }
        if (isElurComponent(value)) {
            _mountComponentDeferred(value, anchor.parentNode!, anchor, postMountHooks, disposes);
        } else if (isComponentInvocation(value)) {
            // Invocación directa (sin getter): montar por el kernel una vez.
            const inst = new ComponentInstance(value);
            inst.mount(anchor.parentNode!, anchor, {
                ctxSnapshot: _captureContextSnapshot(),
                deferOnMount: (fire) => _deferOnMount(fire),
            });
            disposes.push(() => inst.unmount());
        } else if (isElurTemplate(value)) {
            disposes.push(value._render(anchor.parentNode!, anchor));
        } else if (isKeyedList(value)) {
            // Static keyed list (`repeat(...)` directly, without a getter):
            // mirror the reactive path so a direct keyed value never falls
            // through to `String(value)`.
            const ctxSnapshot = _captureContextSnapshot();
            const keyedState = new Map<RepeatKey, KEntry>();
            const keyedZoneStart = document.createTextNode("");
            anchor.parentNode!.insertBefore(keyedZoneStart, anchor);
            reconcileKeyedList({
                zoneStart: keyedZoneStart,
                anchor,
                state: keyedState,
                prevOrder: [],
                list: value,
                mount: createKeyedMount(ctxSnapshot),
                ctxSnapshot,
                onDuplicateKey: (key) => {
                    console.warn(`[elur] repeat(): duplicate key "${key}". Keys must be unique; the previous entry leaks (orphaned nodes + live effects).`);
                },
            });
            disposes.push(() => {
                for (const entry of keyedState.values()) {
                    entry.cleanup();
                }
                keyedState.clear();
            });
        } else if (Array.isArray(value)) {
            for (const item of value) {
                if (isElurComponent(item)) {
                    _mountComponentDeferred(item, anchor.parentNode!, anchor, postMountHooks, disposes);
                } else if (isElurTemplate(item)) {
                    item._render(anchor.parentNode!, anchor);
                } else if (item != null && item !== false) {
                    anchor.parentNode!.insertBefore(
                        document.createTextNode(String(item)),
                        anchor
                    );
                }
            }
        } else if (value != null && value !== false) {
            anchor.parentNode!.insertBefore(
                document.createTextNode(String(value)),
                anchor
            );
        }
        return;
    }

    // Reactive function path
    let textNode: Text | null = null;
    let innerCleanup: (() => void) | null = null;
    // A.15: instancia montada en este binding — para reconciliación de
    // invocaciones (misma definición+key → updateProps, no remount).
    let mountedInstance: ComponentInstance | null = null;
    // A.14: owner del declarante del slot desenvuelto en la pasada actual —
    // mounts de su contenido se cuelgan de él (contexto léxico).
    let declOwner: import("./reactivity.js").OwnerLike | null = null;

    type Key = RepeatKey;
    let keyedState: Map<Key, KEntry> | null = null;
    let prevKeyOrder: Key[] = [];
    let keyedZoneStart: Node | null = null;

    const ctxSnapshot = _captureContextSnapshot();
    const keyedMount = createKeyedMount(ctxSnapshot);

    let _textQueued = false;
    let _pendingText = "";
    let _isFirstText = true;

    const dispose = _renderEffect(() => {
        let v = (value as () => unknown)();

        if (typeof v === "string" || typeof v === "number") {
            _pendingText = String(v);

            const update = () => {
                _textQueued = false;
                if (innerCleanup) {
                    innerCleanup();
                    innerCleanup = null;
                }
                if (!textNode) {
                    textNode = document.createTextNode(_pendingText);
                    anchor.parentNode!.insertBefore(textNode, anchor);
                } else {
                    textNode.nodeValue = _pendingText;
                }
            };

            if (_isFirstText) {
                _isFirstText = false;
                update();
            } else if (!_textQueued) {
                _textQueued = true;
                queueDomWrite(anchor, "text", update);
            }
            return;
        }

        _textQueued = false;
        _isFirstText = false;

        if (textNode) {
            textNode.parentNode?.removeChild(textNode);
            textNode = null;
        }
        // A.15: reconciliación de invocaciones — si el nuevo valor es la misma
        // definición+key que la instancia montada, se actualizan props y NO se
        // desmonta (el cleanup genérico de abajo la mataría).
        const isReconciled = isComponentInvocation(v) && (mountedInstance?.matches(v) ?? false);
        if (!isReconciled && innerCleanup) {
            innerCleanup();
            innerCleanup = null;
        }

        // A.14: slot lazy — desenvolver bajo el owner del declarante y
        // montar su contenido colgado de ese owner (contexto léxico).
        declOwner = null;
        if (isElurSlot(v)) {
            declOwner = v.owner;
            v = runWithOwner(v.owner, () => (v as Slot).render());
        }

        if (v == null || v === false) {
            // Empty
        } else if (isElurComponent(v) || isComponentInvocation(v)) {
            // A.15: invocaciones van por la rama reconciliadora — el proto
            // mountDom remontaría en cada write.
            if (isReconciled) {
                // misma definición+key → actualizar props, no recrear setup
                mountedInstance!.updateProps((v as ComponentInvocation<any>).props);
            } else {
                const inst = new ComponentInstance(v);
                inst.mount(anchor.parentNode!, anchor, {
                    ctxSnapshot,
                    declOwner,
                    deferOnMount: (fire) => _deferOnMount(fire),
                });
                mountedInstance = inst;
                innerCleanup = () => { inst.unmount(); mountedInstance = null; };
            }
        } else if (v != null && typeof v === "object" && (v as Record<PropertyKey, unknown>)[ELUR_RENDER_PROTOCOL] != null) {
            const proto = (v as Record<PropertyKey, unknown>)[ELUR_RENDER_PROTOCOL] as { mountDom?: (ctx: import("../template/types.js").DomProtocolContext) => (() => void) | void };
            if (proto.mountDom) {
                innerCleanup = proto.mountDom({ parent: anchor.parentNode!, before: anchor }) ?? null;
            } else {
                textNode = document.createTextNode(String(v));
                anchor.parentNode!.insertBefore(textNode, anchor);
            }
        } else if (isElurTemplate(v)) {
            innerCleanup = v._render(anchor.parentNode!, anchor);
        } else if (isKeyedList(v)) {

            if (!keyedState) {
                keyedState = new Map();
                keyedZoneStart = document.createTextNode("");
                anchor.parentNode!.insertBefore(keyedZoneStart, anchor);
            }

            reconcileKeyedList({
                zoneStart: keyedZoneStart!,
                anchor,
                state: keyedState,
                prevOrder: prevKeyOrder,
                list: v,
                mount: keyedMount,
                onDuplicateKey: (key) => {
                    console.warn(`[elur] repeat(): duplicate key "${key}". Keys must be unique; the previous entry leaks (orphaned nodes + live effects).`);
                },
            });
        } else if (Array.isArray(v)) {
            const cleanups: Array<() => void> = [];
            for (const item of v) {
                if (isElurComponent(item)) {
                    cleanups.push(_mountComponent(item, anchor.parentNode!, anchor));
                } else if (isElurTemplate(item)) {
                    cleanups.push(item._render(anchor.parentNode!, anchor));
                } else if (item != null && item !== false) {
                    const t = document.createTextNode(String(item));
                    anchor.parentNode!.insertBefore(t, anchor);
                    cleanups.push(() => t.parentNode?.removeChild(t));
                }
            }
            innerCleanup = () => cleanups.forEach((c) => c());
        } else {
            textNode = document.createTextNode(String(v));
            anchor.parentNode!.insertBefore(textNode, anchor);
        }
    });

    disposes.push(() => {
        dispose();
        if (innerCleanup) {
            innerCleanup();
            innerCleanup = null;
        }
        if (textNode) {
            textNode.parentNode?.removeChild(textNode);
            textNode = null;
        }
        if (keyedState) {
            for (const entry of keyedState.values()) {
                entry.cleanup();
            }
            keyedState = null;
            keyedZoneStart = null;
        }
    });
}
