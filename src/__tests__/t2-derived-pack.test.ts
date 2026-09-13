import { describe, it, expect } from "vitest";
import { signal } from "../elur/reactivity.js";
import { html } from "../elur/template/html.js";
import { renderToString } from "../elur/server/index.js";
import { hydrate } from "../elur/hydrate/index.js";
import { isDerivedBinding, ELUR_DERIVED } from "../elur/template/types.js";
import { mount } from "../index.js";

const flushDom = () => Promise.resolve();

/**
 * C.7 T2 — el pack `__elurDerive(deps…, getter)` como valor first-class.
 *
 * El compilador emite `{ [ELUR_DERIVED]: true, deps, get }` como arg de un
 * binding; mount/hydrate/SSR deben resolverlo (nunca "[object Object]").
 * Corre sobre el motor canónico.
 */
const pack = (deps: unknown[], get: () => unknown) => ({
    [ELUR_DERIVED]: true,
    deps,
    get,
});

/** Pack 1-dep emitido por `__elurDerive1` — `dep` sin array. */
const pack1 = (dep: unknown, get: () => unknown) => ({
    [ELUR_DERIVED]: true,
    dep,
    get,
});

describe("derived pack detection", () => {
    it("isDerivedBinding sólo acepta packs brandeados", () => {
        expect(isDerivedBinding(pack([], () => 1))).toBe(true);
        expect(isDerivedBinding(pack1(signal(1), () => 1))).toBe(true);
        expect(isDerivedBinding({ deps: [], get: () => 1 })).toBe(false);
        expect(isDerivedBinding(null)).toBe(false);
        expect(isDerivedBinding(() => 1)).toBe(false);
    });
});

describe("derived pack through mount", () => {
    it("nodo: resuelve el valor y sigue a las deps", async () => {
        const a = signal(2);
        const b = signal(3);
        const template = html`<div>${pack([a, b], () => a.value * b.value)}</div>`;
        const container = document.createElement("div");
        const handle = mount(template, container);

        expect(container.textContent).toBe("6");
        a.value = 4;
        await flushDom();
        expect(container.textContent).toBe("12");
        handle.unmount();
    });

    it("attr: escribe el valor derivado y reacciona", async () => {
        const selected = signal(0);
        const template = html`<div class=${pack([selected], () => (selected.value === 1 ? "danger" : "row"))}></div>`;
        const container = document.createElement("div");
        const handle = mount(template, container);
        const el = container.firstElementChild as HTMLElement;

        expect(el.className).toBe("row");
        selected.value = 1;
        await flushDom();
        expect(el.className).toBe("danger");
        handle.unmount();
    });
});

describe("derived pack through SSR + hydration", () => {
    it("SSR resuelve el pack al valor derivado (no [object Object])", async () => {
        const s = signal("x");
        const template = html`<div>${pack([s], () => s.value + "-derived")}</div>`;
        const out = await renderToString(template, { markers: "hydration" });
        expect(out).toContain("x-derived");
        expect(out).not.toContain("[object Object]");
    });

    it("hydrate adopta el nodo y sigue a las deps", async () => {
        const s = signal(1);
        const template = html`<div>${pack([s], () => `v${s.value}`)}</div>`;
        const container = document.createElement("div");
        container.innerHTML = await renderToString(template, { markers: "hydration" });

        const handle = hydrate(template, container);
        expect(container.textContent).toContain("v1");
        s.value = 2;
        await flushDom();
        expect(container.textContent).toContain("v2");
        handle.unmount();
    });

    it("hydrate adopta attr derivado y reacciona", async () => {
        const sel = signal(5);
        const template = html`<div class=${pack([sel], () => (sel.value === 5 ? "danger" : ""))}></div>`;
        const container = document.createElement("div");
        container.innerHTML = await renderToString(template, { markers: "hydration" });

        const handle = hydrate(template, container);
        const el = container.firstElementChild as HTMLElement;
        expect(el.className).toBe("danger");
        sel.value = 7;
        await flushDom();
        expect(el.className).not.toBe("danger");
        handle.unmount();
    });
});

describe("pack 1-dep (__elurDerive1)", () => {
    it("nodo: resuelve y reacciona", async () => {
        const s = signal("a");
        const template = html`<div>${pack1(s, () => `${s.value}!`)}</div>`;
        const container = document.createElement("div");
        const handle = mount(template, container);

        expect(container.textContent).toBe("a!");
        s.value = "b";
        await flushDom();
        expect(container.textContent).toBe("b!");
        handle.unmount();
    });

    it("SSR resuelve el pack 1-dep", async () => {
        const s = signal(3);
        const template = html`<div>${pack1(s, () => s.value * 2)}</div>`;
        const out = await renderToString(template, { markers: "hydration" });
        expect(out).toContain(">6<");
        expect(out).not.toContain("[object Object]");
    });

    it("hydrate adopta attr derivado 1-dep y reacciona", async () => {
        const sel = signal(2);
        const template = html`<div class=${pack1(sel, () => (sel.value === 2 ? "danger" : ""))}></div>`;
        const container = document.createElement("div");
        container.innerHTML = await renderToString(template, { markers: "hydration" });

        const handle = hydrate(template, container);
        const el = container.firstElementChild as HTMLElement;
        expect(el.className).toBe("danger");
        sel.value = 9;
        await flushDom();
        expect(el.className).not.toBe("danger");
        handle.unmount();
    });
});
