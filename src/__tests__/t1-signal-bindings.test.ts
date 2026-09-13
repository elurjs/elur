import { describe, it, expect } from "vitest";
import { signal, computed, effect, _bindSignal, _bindDerived, Signal } from "../elur/reactivity.js";
import { html } from "../elur/template/html.js";
import { renderToString } from "../elur/server/index.js";
import { hydrate } from "../elur/hydrate/index.js";

/** Flush the queued DOM writes (queueDOMWrite uses a microtask). */
const flushDom = () => Promise.resolve();

/**
 * C.6 tier T1 — Signal como valor first-class en bindings.
 *
 * El compilador emite la SEÑAL como arg (no `() => sig.value`); el runtime
 * la suscribe con `_bindSignal` (edge permanente, sin effect ni tracking).
 * Corre sobre el motor canónico.
 */
describe("_bindSignal (T1 primitive)", () => {
    it("writes initial value and follows signal updates", () => {
        const s = signal("a");
        const writes: string[] = [];
        const dispose = _bindSignal(s, (v) => writes.push(v as string));

        expect(writes).toEqual(["a"]);
        s.value = "b";
        expect(writes).toEqual(["a", "b"]);
        dispose();
    });

    it("does not write when the value did not change", () => {
        const s = signal(1);
        const writes: number[] = [];
        const dispose = _bindSignal(s, (v) => writes.push(v as number));

        s.value = 1; // same value — dedup
        expect(writes).toEqual([1]);
        dispose();
    });

    it("stops writing after dispose", () => {
        const s = signal(0);
        const writes: number[] = [];
        const dispose = _bindSignal(s, (v) => writes.push(v as number));

        dispose();
        s.value = 42;
        expect(writes).toEqual([0]);
    });

    it("follows computed sources, including cold computeds", () => {
        const a = signal(1);
        // Nunca leído antes del bind — debe evaluarse lazy al suscribir.
        const c = computed(() => a.value * 2);
        const writes: number[] = [];
        const dispose = _bindSignal(c as Signal<number>, (v) => writes.push(v as number));

        expect(writes).toEqual([2]);
        a.value = 5;
        expect(writes).toEqual([2, 10]);
        a.value = 5; // no-change → no extra write
        expect(writes).toEqual([2, 10]);
        dispose();
    });
});

describe("_bindDerived (T2 primitive)", () => {
    it("evaluates the getter untracked and writes on derived change", () => {
        const dep = signal(1);
        const writes: string[] = [];
        const dispose = _bindDerived(
            dep,
            () => (dep.value === 2 ? "danger" : "row"),
            (v) => writes.push(v as string),
        );

        expect(writes).toEqual(["row"]);
        dep.value = 2;
        expect(writes).toEqual(["row", "danger"]);
        dep.value = 2; // derived value unchanged → no write
        dep.value = 3;
        expect(writes).toEqual(["row", "danger", "row"]);
        dispose();
    });

    it("does not subscribe the enclosing effect to the dep", () => {
        const dep = signal(0);
        const cleanups: Array<() => void> = [];
        let effectRuns = 0;
        const disposeOuter = effect(() => {
            effectRuns++;
            // Simula la creación de una fila dentro de un efecto padre.
            cleanups.push(_bindDerived(dep, () => dep.value * 10, () => { }));
        });

        expect(effectRuns).toBe(1);
        dep.value = 1; // el effect NO debe re-correr — la dep no es suya
        expect(effectRuns).toBe(1);
        for (const c of cleanups) c();
        disposeOuter();
    });

    it("stops after dispose", () => {
        const dep = signal(5);
        const writes: number[] = [];
        const dispose = _bindDerived(dep, () => dep.value + 1, (v) => writes.push(v as number));

        dispose();
        dep.value = 9;
        expect(writes).toEqual([6]);
    });
});

describe("Signal as first-class binding value", () => {
    it("renders and updates `${sig}` directly in node position", async () => {
        const s = signal("hello");
        const container = document.createElement("div");
        const cleanup = html`<div>${s}</div>`._render(container, null);

        expect(container.textContent).toBe("hello");
        s.value = "world";
        await flushDom();
        expect(container.textContent).toBe("world");
        cleanup();
        s.value = "after-dispose";
        await flushDom();
        expect(container.textContent).not.toBe("after-dispose");
    });

    it("renders and updates `${sig}` in attribute position", async () => {
        const cls = signal("one");
        const container = document.createElement("div");
        const cleanup = html`<div class=${cls}></div>`._render(container, null);
        const el = container.firstElementChild as HTMLElement;

        expect(el.className).toBe("one");
        cls.value = "two";
        await flushDom();
        expect(el.className).toBe("two");
        cleanup();
    });

    it("handles null/false signal values as empty text", async () => {
        const s = signal<string | null | false>("x");
        const container = document.createElement("div");
        const cleanup = html`<p>${s}</p>`._render(container, null);

        expect(container.textContent).toBe("x");
        s.value = null;
        await flushDom();
        expect(container.textContent).toBe("");
        s.value = false;
        await flushDom();
        expect(container.textContent).toBe("");
        cleanup();
    });

    it("still treats getters as reactive expressions (unchanged semantics)", async () => {
        const a = signal(1);
        const b = signal(2);
        const container = document.createElement("div");
        const cleanup = html`<p>${() => a.value + b.value}</p>`._render(container, null);

        expect(container.textContent).toBe("3");
        a.value = 10;
        await flushDom();
        expect(container.textContent).toBe("12");
        b.value = 20;
        await flushDom();
        expect(container.textContent).toBe("30");
        cleanup();
    });
});

describe("Signal values through SSR + hydration", () => {
    it("SSR resolves a direct Signal value via peek", async () => {
        const s = signal("ssr-text");
        const template = html`<div>${s}</div>`;
        const out = await renderToString(template, { markers: "hydration" });
        expect(out).toContain("ssr-text");
    });

    it("hydration activates a direct Signal node binding and keeps updating", async () => {
        const s = signal("initial");
        const template = html`<div>${s}</div>`;
        const container = document.createElement("div");
        container.innerHTML = await renderToString(template, { markers: "hydration" });

        const handle = hydrate(template, container);
        expect(container.textContent).toContain("initial");
        s.value = "hydrated";
        await flushDom();
        expect(container.textContent).toContain("hydrated");
        handle.unmount();
    });

    it("hydration activates a direct Signal attribute binding", async () => {
        const cls = signal("ssr-class");
        const template = html`<div class=${cls}></div>`;
        const container = document.createElement("div");
        container.innerHTML = await renderToString(template, { markers: "hydration" });

        const handle = hydrate(template, container);
        const el = container.firstElementChild as HTMLElement;
        expect(el.className).toBe("ssr-class");
        cls.value = "hydrated-class";
        await flushDom();
        expect(el.className).toBe("hydrated-class");
        handle.unmount();
    });
});
