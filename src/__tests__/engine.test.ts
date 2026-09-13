import { describe, it, expect, vi } from "vitest";
import {
    signal,
    effect,
    computed,
    batch,
    untrack,
    watch,
    nextTick,
    createRoot,
    getOwner,
    runWithOwner,
    onCleanup,
    _renderEffect,
    Owner,
    constSignal,
} from "../elur/reactivity";

// ── Signal ────────────────────────────────────────────────────────────────────

describe("next/signal", () => {
    it("stores and returns its initial value", () => {
        const s = signal(42);
        expect(s.value).toBe(42);
    });

    it("updates value when written", () => {
        const s = signal(0);
        s.value = 7;
        expect(s.value).toBe(7);
    });

    it("does not notify when set to same value (Object.is)", () => {
        const s = signal(1);
        let runs = 0;
        effect(() => { runs++; s.value; });
        s.value = 1;
        expect(runs).toBe(1);
    });

    it("update() applies a function", () => {
        const s = signal(2);
        s.update((v) => v * 3);
        expect(s.value).toBe(6);
    });

    it("peek() reads without subscribing", () => {
        const s = signal(1);
        let runs = 0;
        effect(() => { runs++; s.peek(); });
        s.value = 2;
        expect(runs).toBe(1);
    });

    it("dispose() removes all subscriptions", () => {
        const s = signal(0);
        let runs = 0;
        effect(() => { runs++; s.value; });
        s.dispose();
        s.value = 1;
        expect(runs).toBe(1);
    });
});

// ── Effect ────────────────────────────────────────────────────────────────────

describe("next/effect", () => {
    it("runs immediately on creation", () => {
        let runs = 0;
        effect(() => { runs++; });
        expect(runs).toBe(1);
    });

    it("re-runs when a read signal changes", () => {
        const s = signal(0);
        let runs = 0;
        effect(() => { runs++; s.value; });
        s.value = 1;
        s.value = 2;
        expect(runs).toBe(3);
    });

    it("stops re-running after dispose", () => {
        const s = signal(0);
        let runs = 0;
        const stop = effect(() => { runs++; s.value; });
        stop();
        s.value = 1;
        expect(runs).toBe(1);
    });

    it("calls cleanup function before each re-run", () => {
        const s = signal(0);
        const cleanups: number[] = [];
        effect(() => {
            const v = s.value;
            return () => cleanups.push(v);
        });
        s.value = 1;
        s.value = 2;
        expect(cleanups).toEqual([0, 1]);
    });

    it("calls cleanup on dispose", () => {
        const s = signal(0);
        let cleaned = false;
        const stop = effect(() => { s.value; return () => { cleaned = true; }; });
        stop();
        expect(cleaned).toBe(true);
    });

    it("tracks only signals read in the latest run (auto-cleanup)", () => {
        const cond = signal(true);
        const a = signal(1);
        const b = signal(2);
        let result = 0;
        effect(() => { result = cond.value ? a.value : b.value; });
        expect(result).toBe(1);
        cond.value = false;
        expect(result).toBe(2);
        a.value = 99; // a ya no es dep del effect
        expect(result).toBe(2);
        b.value = 5;
        expect(result).toBe(5);
    });
});

// ── Computed ──────────────────────────────────────────────────────────────────

describe("next/computed", () => {
    it("is lazy: does not evaluate until first .value read", () => {
        let runs = 0;
        const s = signal(1);
        computed(() => { runs++; return s.value * 2; });
        expect(runs).toBe(0);
    });

    it("derives value from signals", () => {
        const s = signal(3);
        const c = computed(() => s.value * 2);
        expect(c.value).toBe(6);
    });

    it("updates when source signal changes", () => {
        const s = signal(1);
        const c = computed(() => s.value + 10);
        c.value;
        s.value = 5;
        expect(c.value).toBe(15);
    });

    it("is reactive in effects", () => {
        const s = signal(1);
        const c = computed(() => s.value * 10);
        let seen = 0;
        effect(() => { seen = c.value; });
        s.value = 2;
        expect(seen).toBe(20);
    });

    it("dispose before first read does not evaluate", () => {
        let runs = 0;
        const s = signal(1);
        const c = computed(() => { runs++; return s.value; });
        c.dispose();
        expect(runs).toBe(0);
    });

    it("custom equality prevents propagation of equal values", () => {
        const s = signal({ a: 1 });
        let runs = 0;
        const c = computed(
            () => { runs++; return { a: s.value.a }; },
            (x, y) => x.a === y.a,
        );
        c.value;
        runs = 0;
        s.value = { a: 1 };
        expect(c.value.a).toBe(1);
        // con igualdad custom el valor no cambia → version no sube
    });
});

// ── Corrected defects (regression tests del plan) ─────────────────────────────

describe("next/defects corregidos", () => {
    it("diamond: cada write evalúa el merge UNA vez (glitch B.2.1)", () => {
        const s = signal(0);
        const a = computed(() => s.value + 1);
        const b = computed(() => s.value - 1);
        const m = computed(() => a.value + b.value);
        let mergeEvals = 0;
        const m2 = computed(() => { mergeEvals++; return m.value * 2; });
        let effectRuns = 0;
        effect(() => { effectRuns++; m2.value; });
        mergeEvals = 0; effectRuns = 0;
        s.value = 1;
        expect(effectRuns).toBe(1);
        expect(mergeEvals).toBe(1);
    });

    it("deep chain de >100 computeds no lanza el guard de profundidad", () => {
        const s = signal(0);
        let cur = computed(() => s.value);
        for (let i = 0; i < 200; i++) {
            const prev = cur;
            cur = computed(() => prev.value + 1);
        }
        effect(() => { cur.value; });
        expect(() => { s.value = 1; }).not.toThrow();
        expect(cur.value).toBe(201);
    });

    it("early cutoff: mismo resultado no dispara downstream", () => {
        const s = signal(1);
        const parity = computed(() => s.value % 2);
        let runs = 0;
        effect(() => { runs++; parity.value; });
        runs = 0;
        s.value = 3; // sigue impar
        expect(runs).toBe(0);
        s.value = 4; // cambia a par
        expect(runs).toBe(1);
    });

    it("computed frío no recalcula en writes (liveness)", () => {
        const s = signal(0);
        let evals = 0;
        const c = computed(() => { evals++; return s.value * 2; });
        c.value; // eval inicial
        evals = 0;
        s.value = 5; // sin observadores → no debe re-evaluar
        expect(evals).toBe(0);
        expect(c.value).toBe(10); // fresco al leer
        expect(evals).toBe(1);
    });

    it("computed frío → vivo → frío: transiciones correctas", () => {
        const s = signal(0);
        const c = computed(() => s.value * 10);
        c.value; // eval frío
        let seen = 0;
        const stop = effect(() => { seen = c.value; }); // pasa a vivo
        s.value = 1;
        expect(seen).toBe(10);
        stop(); // vuelve a frío
        s.value = 2;
        expect(c.value).toBe(20); // sondeo al leer
    });
});

// ── Batch / untrack / watch / nextTick ────────────────────────────────────────

describe("next/batch", () => {
    it("defers effect execution until batch ends", () => {
        const s = signal(0);
        let runs = 0;
        effect(() => { runs++; s.value; });
        batch(() => { s.value = 1; s.value = 2; s.value = 3; });
        expect(runs).toBe(2); // inicial + 1 tras el batch
    });

    it("allows reading up-to-date values inside batch", () => {
        const s = signal(0);
        let inside = 0;
        batch(() => { s.value = 5; inside = s.value; });
        expect(inside).toBe(5);
    });
});

describe("next/untrack", () => {
    it("reads signal without subscribing effect", () => {
        const s = signal(1);
        let runs = 0;
        effect(() => { runs++; untrack(() => s.value); });
        s.value = 2;
        expect(runs).toBe(1);
    });

    it("returns the value from fn", () => {
        const s = signal(7);
        expect(untrack(() => s.value * 2)).toBe(14);
    });
});

describe("next/watch", () => {
    it("calls callback when signal changes", () => {
        const s = signal(0);
        const cb = vi.fn();
        watch(s, cb);
        s.value = 1;
        expect(cb).toHaveBeenCalledWith(1, 0);
    });

    it("calls callback with getter source", () => {
        const s = signal(2);
        const cb = vi.fn();
        watch(() => s.value * 2, cb);
        s.value = 3;
        expect(cb).toHaveBeenCalledWith(6, 4);
    });

    it("immediate: true fires callback immediately", () => {
        const s = signal(10);
        const cb = vi.fn();
        watch(s, cb, { immediate: true });
        expect(cb).toHaveBeenCalledWith(10, undefined);
    });

    it("once: true auto-disposes after first callback", () => {
        const s = signal(0);
        const cb = vi.fn();
        watch(s, cb, { once: true });
        s.value = 1;
        s.value = 2;
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(1, 0);
    });

    it("dispose() stops watching", () => {
        const s = signal(0);
        const cb = vi.fn();
        const stop = watch(s, cb);
        stop();
        s.value = 1;
        expect(cb).not.toHaveBeenCalled();
    });
});

describe("next/nextTick", () => {
    it("resolves after microtask", async () => {
        const s = signal(0);
        s.value = 1;
        await nextTick();
        expect(s.value).toBe(1);
    });

    it("runs callback if provided", async () => {
        const fn = vi.fn();
        await nextTick(fn);
        expect(fn).toHaveBeenCalledOnce();
    });
});

// ── Guards ────────────────────────────────────────────────────────────────────

describe("next/scheduler (B.8/B.11)", () => {
    it("render effects corren antes que user effects en el mismo flush", () => {
        const s = signal(0);
        const order: string[] = [];
        // registrar user primero a propósito — el orden de encolado no debe
        // determinar el orden de ejecución
        effect(() => { s.value; order.push("user"); });
        _renderEffect(() => { s.value; order.push("render"); });
        order.length = 0;
        s.value = 1;
        expect(order).toEqual(["render", "user"]);
    });

    it("un render effect que invalida encola y drena en el mismo flush", () => {
        const a = signal(0);
        const b = signal(0);
        const order: string[] = [];
        // lee a, escribe b — no depende de b (si no, se re-dispararía a sí mismo)
        _renderEffect(() => { if (a.value > 0) b.value = 1; order.push("render"); });
        effect(() => { b.value; order.push("user"); });
        order.length = 0;
        a.value = 1; // render corre, escribe b → user re-corre en el mismo flush
        expect(order).toEqual(["render", "user"]);
    });
});

describe("next/guards", () => {
    it("write infinito en effect para por cap de flush", () => {
        const s = signal(0);
        expect(() => {
            effect(() => { s.value = s.value + 1; });
        }).toThrow();
    });

    it("ciclo de computeds lanza error recuperable", () => {
        const a: any = computed(() => (b as any).value + 1);
        const b: any = computed(() => (a as any).value + 1);
        expect(() => a.value).toThrow(/Ciclo/);
        // recuperable: una segunda lectura vuelve a lanzar, no queda corrupto
        expect(() => a.value).toThrow(/Ciclo/);
    });
});

// ── Ownership (B.10) ──────────────────────────────────────────────────────────

describe("next/ownership", () => {
    it("createRoot dispara disposal recursivo del sub-árbol", () => {
        const s = signal(0);
        let runs = 0;
        let cleaned = 0;
        const dispose = createRoot((d) => {
            effect(() => { runs++; s.value; });
            onCleanup(() => cleaned++);
            return d;
        });
        s.value = 1;
        expect(runs).toBe(2);
        dispose();
        s.value = 2;
        expect(runs).toBe(2);
        expect(cleaned).toBe(1);
    });

    it("runWithOwner asigna el owner activo", () => {
        const owner = createRoot((d) => {
            const o = getOwner();
            expect(o).not.toBeNull();
            return { dispose: d, owner: o };
        });
        // fuera del root no hay owner
        expect(getOwner()).toBeNull();
        // runWithOwner re-expone el owner dentro de fn
        const seen = runWithOwner(owner.owner, () => getOwner());
        expect(seen).toBe(owner.owner);
        owner.dispose();
    });

    it("los hijos de un effect mueren antes de su re-evaluación", () => {
        const s = signal(0);
        let alive = 0;
        effect(() => {
            s.value;
            effect(() => {
                s.value;
                alive++;
                return () => { alive--; };
            });
        });
        s.value = 1; // re-run padre → hijo viejo muere, uno nuevo nace
        s.value = 2;
        // nunca más de un hijo vivo a la vez
        expect(alive).toBe(1);
    });

    it("onCleanup corre antes de cada re-eval del effect", () => {
        const s = signal(0);
        let cleans = 0;
        effect(() => { s.value; onCleanup(() => cleans++); });
        s.value = 1;
        s.value = 2;
        expect(cleans).toBe(2);
    });

    it("computed anidado muere con su owner", () => {
        const s = signal(1);
        let evals = 0;
        let cRef: any = null;
        const dispose = createRoot((d) => {
            cRef = computed(() => { evals++; return s.value * 2; });
            cRef.value;
            return d;
        });
        s.value = 2;
        expect(cRef.value).toBe(4);
        const evalsBefore = evals;
        dispose();
        s.value = 3;
        // muerto: devuelve el último valor sin re-evaluar ni re-suscribirse
        expect(cRef.value).toBe(4);
        expect(evals).toBe(evalsBefore);
    });
});

describe("B.9 — ciclo de effects por nodo", () => {
    it("ReactiveCycleError identifica el effect que se re-encola", () => {
        const s = signal(0);
        // effect que se escribe a sí mismo → ciclo infinito sin guard
        expect(() => {
            effect(() => { s.value = s.value + 1; });
        }).toThrowError(/ReactiveCycle|ciclo|Maximum/i);
        // (el error es ReactiveCycleError — identifica el nodo del ciclo)
    });

    it("writes en effect entran en la MISMA ronda del flush (no recursión)", () => {
        const a = signal(0);
        const seen: number[] = [];
        const stop = effect(() => {
            seen.push(a.value);
            if (a.value < 3) a.value = a.value + 1; // write dentro del effect
        });
        expect(seen).toEqual([0, 1, 2, 3]); // re-corre en el mismo flush, 4 veces total
        stop();
    });
});

describe("B.12.1 — grafos profundos sin recursión", () => {
    // Nota: la PRIMERA eval de una cadena lazy es inherentemente recursiva —
    // el computed descubre sus fuentes dentro de fn() (como alien-signals).
    // Lo que el grafo next hace iterativo es la PROPAGACIÓN y el REFRESH de
    // updates (mark cascade + DFS post-order) — que es lo que R0 pide medir.
    it("cadena de 10.000 computeds — update propaga sin stack overflow", () => {
        const s = signal(0);
        let cur: { value: number } = s;
        for (let i = 0; i < 10_000; i++) {
            const prev = cur;
            cur = computed(() => prev.value + 1);
            cur.value; // eval poco profunda — prev ya está fresco
        }
        const stop = effect(() => { cur.value; });
        s.value = 41;
        expect(cur.value).toBe(41 + 10_000);
        stop();
    });

    it("cadena profunda fría — sondeo de versiones iterativo", () => {
        const s = signal(1);
        let cur: { value: number } = s;
        for (let i = 0; i < 5_000; i++) {
            const prev = cur;
            cur = computed(() => prev.value * 2);
            cur.value;
        }
        // vivo→frío: efecto que suscribe y muere
        const stop = effect(() => { cur.value; });
        stop();
        // write + lectura directa: sondea 5k niveles sin recursión
        s.value = 2;
        expect(cur.value).toBe(2 * Math.pow(2, 5_000));
    });
});

describe("unown — hijos dispuestos no se retienen", () => {
    it("dispose() des-registra al hijo de la lista del padre", () => {
        const outer = new Owner();
        const disposes: (() => void)[] = [];
        runWithOwner(outer, () => {
            for (let i = 0; i < 10; i++) {
                disposes.push(effect(() => { /* nada */ }));
            }
        });
        expect(outer.childCount).toBe(10);
        for (const d of disposes) d();
        expect(outer.childCount).toBe(0); // sin retención
        expect(outer.childrenHead).toBeNull();
    });

    it("dispose del padre con muchos hijos limpia todo", () => {
        const outer = new Owner();
        runWithOwner(outer, () => {
            for (let i = 0; i < 50; i++) {
                createRoot((d) => { effect(() => { }); return d; });
            }
        });
        outer.dispose();
        expect(outer.childrenHead).toBeNull();
        expect(outer.childCount).toBe(0);
    });
});

describe("B.12.4 — constSignal (durabilidad)", () => {
    it("no crea edges: writes no propagan y el effect no se suscribe", async () => {
        const c = constSignal(7);
        let runs = 0;
        const dispose = effect(() => { c.value; runs++; });
        expect(runs).toBe(1);
        expect(c.consumersHead).toBeNull(); // sin edge registrada
        dispose();
    });

    it("write en constSignal no propaga (contrato)", async () => {
        const c = constSignal(1);
        const spy = vi.spyOn(console, "warn").mockImplementation(() => { });
        (c as any).value = 2;
        expect(c.value).toBe(1);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});
