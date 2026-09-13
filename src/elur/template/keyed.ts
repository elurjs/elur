import type { ElurTemplate, KeyedList, KEntry } from "./types.js";
import type { ElurComponent } from "../lifecycle.js";

// =============================================================================
// --- repeat() ---
// =============================================================================

/**
 * Creates a keyed list for efficient DOM reconciliation.
 * Use instead of `.map()` when the list changes frequently.
 */
export function repeat<T>(
    items: T[],
    keyFn: (item: T, index: number) => string | number,
    renderFn: (item: T, index: number) => ElurTemplate | ElurComponent
): KeyedList<T> {
    return { __isKeyedList: true as const, items, keyFn, renderFn };
}

// =============================================================================
// --- Key serialization for SSR/hydration markers ---
// =============================================================================

export type RepeatKey = string | number;

/**
 * Normalizes a repeat() key to a serializable form. Keys must be strings or
 * numbers to preserve identity across SSR/hydration. Anything else produces a
 * diagnostic warning and a deterministic positional fallback so that server
 * and client agree without silent `String(key)` collisions.
 */
export function normalizeRepeatKey(key: unknown, index: number): RepeatKey {
    if (typeof key === "string" || typeof key === "number") return key;
    console.warn(
        `[elur] repeat(): key at index ${index} is not a string or number (got ${typeof key}); ` +
        `using positional fallback. Non-serializable keys cannot preserve identity across SSR/hydration.`,
    );
    return `__elur-key:${index}`;
}

function utf8ToBase64(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function utf8FromBase64(value: string): string {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

/** Serializes a repeat() key for the SSR keyed marker (base64 JSON, safe for HTML comments). */
export function serializeRepeatKey(key: RepeatKey): string {
    return utf8ToBase64(JSON.stringify(key));
}

/** Decodes a repeat() key from a keyed hydration marker. */
export function deserializeRepeatKey(serialized: string): RepeatKey {
    try {
        const parsed: unknown = JSON.parse(utf8FromBase64(serialized));
        if (typeof parsed === "string" || typeof parsed === "number") return parsed;
    } catch {
        // fall through
    }
    return serialized;
}

// =============================================================================
// --- Longest Increasing Subsequence (LIS) ---
// =============================================================================

/**
 * Returns the indices of the Longest Increasing Subsequence.
 * Used to minimize DOM operations during list diffing.
 */
export function getSequence(arr: Int32Array | number[]): number[] {
    const p = arr.slice();
    const result = [0];
    let i, j, u, v, c;
    const len = arr.length;
    for (i = 0; i < len; i++) {
        const arrI = arr[i];
        if (arrI !== 0) {
            j = result[result.length - 1];
            if (arr[j] < arrI) {
                p[i] = j;
                result.push(i);
                continue;
            }
            u = 0;
            v = result.length - 1;
            while (u < v) {
                c = (u + v) >> 1;
                if (arr[result[c]] < arrI) {
                    u = c + 1;
                } else {
                    v = c;
                }
            }
            if (arrI < arr[result[u]]) {
                if (u > 0) {
                    p[i] = result[u - 1];
                }
                result[u] = i;
            }
        }
    }
    u = result.length;
    v = result[u - 1];
    while (u-- > 0) {
        result[u] = v;
        v = p[v];
    }
    return result;
}

/**
 * C.16.4: igualdad shallow de items de lista — misma key + objeto nuevo con
 * campos idénticos → el row se conserva (DOM, estado, bindings). Cualquier
 * campo distinto → re-mount in-place (los bindings capturaron el objeto
 * viejo por valor y no hay accessors que actualizar). Identidad `===`
 * primero (fast path para el caso común: mismos objetos reordenados).
 *
 * @internal — usado por keyed-diff (estable y next-2) y el runtime compilado.
 */
export function _keyedItemsEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
        return false;
    }
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
        const k = ka[i];
        if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) {
            return false;
        }
    }
    return true;
}

export type { KEntry };
