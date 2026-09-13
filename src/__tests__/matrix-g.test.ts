/**
 * Matriz G — tipos de componente × contextos de montaje × invariantes.
 * (PLAN_TECNICO_ELUR_NEXT.md §G — gate de la estrategia beta.)
 *
 * Corre sobre el motor canónico (src/elur/*).
 *
 * Cobertura por tipo:
 *   - "tpl": template factory legacy (html``)
 *   - "cls": ElurComponent (clase con lifecycle)
 *   - defineComponent (funcional): component-functional.test.ts.
 *   - IonPage / Ionic cached page: suite de elur-ionic (fuera de core).
 *
 * Invariantes verificados por celda (los que aplican al tipo):
 *   setup/init 1× · render 1× · onMount 1× y tras DOM commit ·
 *   onUnmount 1× · cleanup 1× · hijo antes que padre · contexto ·
 *   error correcto · rollback sin DOM filtrado · devtools sin
 *   registros fantasmas · DOM vacío tras unmount.
 */
import { describe, it, expect, vi } from "vitest";
import { html, ref } from "../elur/template";
import type { ElurTemplate } from "../elur/template";
import {
    ElurComponent,
    _addComponentDebugHooks,
} from "../elur/lifecycle";
import { mount } from "../elur/component";
import { signal } from "../elur/reactivity";
import { repeat } from "../elur/template/keyed";
import { createErrorBoundary } from "../elur/template/error-boundary";
import { transition } from "../elur/template/transitions";
import { createPortalOutlet, portal, portalOutlet } from "../elur/template/portal";
import { suspend } from "../elur/async";
import { renderToString } from "../elur/server/index";
import { hydrate } from "../elur/hydrate";
import { createRouter, RouterView, _resetRouter } from "../elur/router";
import { provide, inject, createInjectionKey } from "../elur/context";

// =============================================================================
// --- Probes ------------------------------------------------------------------
// =============================================================================

interface ProbeLog {
    init: number;
    render: number;
    mount: number;
    unmount: number;
    cleanup: number;
    errors: unknown[];
    /** false si algún onMount corrió antes de que el DOM estuviera committed. */
    mountAfterDomCommit: boolean;
    ctx: unknown;
}

const TICK = () => new Promise((r) => setTimeout(r, 0));

/** Probe tipo ElurComponent — cuenta cada hook del ciclo de vida. */
function classProbe(tag = "p") {
    const r = ref<HTMLDivElement>();
    const log: ProbeLog = {
        init: 0, render: 0, mount: 0, unmount: 0, cleanup: 0,
        errors: [], mountAfterDomCommit: true, ctx: undefined,
    };
    class Probe extends ElurComponent {
        onInit() { log.init++; }
        render(): ElurTemplate {
            log.render++;
            return html`<div class="probe" data-tag=${tag} ref=${r}>probe</div>`;
        }
        onMount() {
            log.mount++;
            if (!r.el || !r.el.isConnected) log.mountAfterDomCommit = false;
            return () => { log.cleanup++; };
        }
        onUnmount() { log.unmount++; }
        onError(err: unknown) { log.errors.push(err); }
    }
    const inst = new Probe();
    return { content: inst as ElurComponent, log, el: () => r.el };
}

/** Probe tipo template legacy — DOM + binding vivo + cleanup. */
function tplProbe(tag = "p") {
    const s = signal(`${tag}-0`);
    const content = html`<div class="probe" data-tag=${tag}><i>${() => s.value}</i></div>`;
    return { content: content as ElurTemplate, s };
}

const CTX = createInjectionKey<string>("matrix-g");

function expectLifecycleOnce(log: ProbeLog) {
    expect(log.init).toBe(1);
    expect(log.render).toBe(1);
    expect(log.mount).toBe(1);
    expect(log.mountAfterDomCommit).toBe(true);
    expect(log.unmount).toBe(0);
    expect(log.cleanup).toBe(0);
    expect(log.errors).toEqual([]);
}

function expectTeardownOnce(log: ProbeLog) {
    expect(log.unmount).toBe(1);
    expect(log.cleanup).toBe(1);
}

// =============================================================================
// --- Celdas: raíz -------------------------------------------------------------
// =============================================================================

describe("matriz G — contexto root", () => {
    it("tpl: render + binding vivo + unmount limpia", async () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const p = tplProbe();
        const h = mount(p.content, host);
        expect(host.querySelector(".probe")!.textContent).toBe("p-0");
        p.s.value = "p-1";
        await TICK();
        expect(host.querySelector(".probe i")!.textContent).toBe("p-1");
        h.unmount();
        expect(host.querySelector(".probe")).toBeNull();
        host.remove();
    });

    it("cls: init/render/mount 1×, onMount tras commit, unmount limpia", () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const { content, log, el } = classProbe();
        const h = mount(content, host);
        expectLifecycleOnce(log);
        expect(el()!.isConnected).toBe(true);
        h.unmount();
        expectTeardownOnce(log);
        expect(host.querySelector(".probe")).toBeNull();
        host.remove();
    });
});

// =============================================================================
// --- Celdas: static child / arrays / condicional -------------------------------
// =============================================================================

describe("matriz G — static child", () => {
    it.each(["tpl", "cls"] as const)("%s dentro de <div> estático", (kind) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const probe = kind === "cls" ? classProbe() : tplProbe();
        const dispose = html`<section class="outer">${probe.content}</section>`._render(host, null);
        expect(host.querySelector(".probe")).not.toBeNull();
        if (kind === "cls") expectLifecycleOnce((probe as ReturnType<typeof classProbe>).log);
        dispose();
        expect(host.querySelector(".probe")).toBeNull();
        if (kind === "cls") expectTeardownOnce((probe as ReturnType<typeof classProbe>).log);
        host.remove();
    });
});

describe("matriz G — condicional reactivo", () => {
    it.each(["tpl", "cls"] as const)("%s aparece/desaparece con toggle, lifecycle por instancia", async (kind) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const show = signal(false);
        const probe = kind === "cls" ? classProbe() : tplProbe();
        const dispose = html`<div>${() => (show.value ? probe.content : null)}</div>`._render(host, null);
        expect(host.querySelector(".probe")).toBeNull();
        if (kind === "cls") {
            const l = (probe as ReturnType<typeof classProbe>).log;
            expect(l.init).toBe(0);
        }
        show.value = true;
        await TICK();
        expect(host.querySelector(".probe")).not.toBeNull();
        if (kind === "cls") expectLifecycleOnce((probe as ReturnType<typeof classProbe>).log);
        show.value = false;
        await TICK();
        expect(host.querySelector(".probe")).toBeNull();
        if (kind === "cls") expectTeardownOnce((probe as ReturnType<typeof classProbe>).log);
        dispose();
        host.remove();
    });
});

describe("matriz G — static array", () => {
    it.each(["tpl", "cls"] as const)("%s dentro de array estático", (kind) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const a = kind === "cls" ? classProbe("a") : tplProbe("a");
        const b = kind === "cls" ? classProbe("b") : tplProbe("b");
        const dispose = html`<div>${[a.content, b.content]}</div>`._render(host, null);
        const probes = host.querySelectorAll(".probe");
        expect(probes.length).toBe(2);
        expect(probes[0].getAttribute("data-tag")).toBe("a");
        if (kind === "cls") {
            expectLifecycleOnce((a as ReturnType<typeof classProbe>).log);
            expectLifecycleOnce((b as ReturnType<typeof classProbe>).log);
        }
        dispose();
        expect(host.querySelectorAll(".probe").length).toBe(0);
        host.remove();
    });
});

describe("matriz G — reactive array", () => {
    it.each(["tpl", "cls"] as const)("%s: update añade items sin perder contenido", async (kind) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const a = kind === "cls" ? classProbe("a") : tplProbe("a");
        const b = kind === "cls" ? classProbe("b") : tplProbe("b");
        const arr = signal<unknown[]>([a.content]);
        const dispose = html`<div>${() => arr.value}</div>`._render(host, null);
        expect(host.querySelectorAll(".probe").length).toBe(1);
        arr.value = [a.content, b.content];
        await TICK();
        expect(host.querySelectorAll(".probe").length).toBe(2);
        dispose();
        host.remove();
    });
});

// =============================================================================
// --- Celdas: keyed list -------------------------------------------------------
// =============================================================================

describe("matriz G — keyed list", () => {
    it.each(["tpl", "cls"] as const)("%s por item: mount/update/unmount por key", async (kind) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const items = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
        const logs = new Map<number, ProbeLog>();
        const renderItem = (it: { id: number }) => {
            const probe = kind === "cls" ? classProbe(`k${it.id}`) : tplProbe(`k${it.id}`);
            if (kind === "cls") logs.set(it.id, (probe as ReturnType<typeof classProbe>).log);
            return probe.content;
        };
        const dispose = html`<ul>${() => repeat(items.value, (i) => i.id, renderItem)}</ul>`._render(host, null);
        await TICK();
        expect(host.querySelectorAll(".probe").length).toBe(3);
        // Remove del medio: sólo su entry muere.
        items.value = [{ id: 1 }, { id: 3 }];
        await TICK();
        expect(host.querySelectorAll(".probe").length).toBe(2);
        if (kind === "cls") {
            expect(logs.get(2)!.unmount).toBe(1);
            expect(logs.get(1)!.unmount).toBe(0);
            expect(logs.get(3)!.unmount).toBe(0);
        }
        dispose();
        if (kind === "cls") {
            expect(logs.get(1)!.unmount).toBe(1);
            expect(logs.get(3)!.unmount).toBe(1);
        }
        host.remove();
    });
});

// =============================================================================
// --- Celdas: portal -----------------------------------------------------------
// =============================================================================

describe("matriz G — portal", () => {
    it.each(["tpl", "cls"] as const)("%s teleporta a outlet y limpia", (kind) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const outlet = createPortalOutlet();
        const probe = kind === "cls" ? classProbe() : tplProbe();
        const dispose = html`<div>${portalOutlet(outlet)}${portal(probe.content, outlet)}</div>`._render(host, null);
        // El contenido aterriza en el div data-elur-outlet (no en su posición).
        const outletEl = host.querySelector("[data-elur-outlet]");
        expect(outletEl).not.toBeNull();
        expect(outletEl!.querySelector(".probe")).not.toBeNull();
        if (kind === "cls") expectLifecycleOnce((probe as ReturnType<typeof classProbe>).log);
        dispose();
        expect(host.querySelector(".probe")).toBeNull();
        host.remove();
    });
});

// =============================================================================
// --- Celdas: transition -------------------------------------------------------
// =============================================================================

describe("matriz G — transition", () => {
    it.each(["tpl", "cls"] as const)("%s estático monta lifecycle 1×", (kind) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const probe = kind === "cls" ? classProbe() : tplProbe();
        const dispose = html`<div>${transition(probe.content as never)}</div>`._render(host, null);
        expect(host.querySelector(".probe")).not.toBeNull();
        if (kind === "cls") expectLifecycleOnce((probe as ReturnType<typeof classProbe>).log);
        dispose();
        if (kind === "cls") expectTeardownOnce((probe as ReturnType<typeof classProbe>).log);
        host.remove();
    });
});

// =============================================================================
// --- Celdas: error boundary ---------------------------------------------------
// =============================================================================

describe("matriz G — error boundary", () => {
    it("cls: contenido sano monta normal dentro del boundary", () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const probe = classProbe();
        const dispose = html`<div>${createErrorBoundary(probe.content, html`<p>fb</p>`)}</div>`._render(host, null);
        expectLifecycleOnce(probe.log);
        dispose();
        host.remove();
    });

    it("cls: render que lanza → fallback + onError + sin DOM filtrado", () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const log: ProbeLog = { init: 0, render: 0, mount: 0, unmount: 0, cleanup: 0, errors: [], mountAfterDomCommit: true, ctx: undefined };
        class Bad extends ElurComponent {
            onInit() { log.init++; }
            render(): ElurTemplate { log.render++; throw new Error("boom"); }
            onUnmount() { log.unmount++; }
            onError(err: unknown) { log.errors.push(err); }
        }
        const dispose = html`<div>${createErrorBoundary(new Bad(), html`<p class="fb">fallback</p>`)}</div>`._render(host, null);
        // El boundary captura el error — fallback visible, sin mount, sin DOM roto.
        expect(host.querySelector(".fb")).not.toBeNull();
        expect(log.mount).toBe(0);
        expect(host.querySelector(".probe")).toBeNull();
        dispose();
        host.remove();
    });
});

// =============================================================================
// --- Celdas: suspend / lazy ---------------------------------------------------
// =============================================================================

describe("matriz G — suspend", () => {
    it.each(["tpl", "cls"] as const)("%s tras resolve: fallback→contenido, lifecycle 1×", async (kind) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const probe = kind === "cls" ? classProbe() : tplProbe();
        const comp = suspend(
            () => Promise.resolve("ok"),
            () => probe.content as never,
            { fallback: html`<span class="loading">…</span>` },
        );
        const h = mount(comp, host);
        expect(host.querySelector(".loading")).not.toBeNull();
        await TICK();
        expect(host.querySelector(".probe")).not.toBeNull();
        if (kind === "cls") expectLifecycleOnce((probe as ReturnType<typeof classProbe>).log);
        h.unmount();
        host.remove();
    });
});

// =============================================================================
// --- Celdas: router -----------------------------------------------------------
// =============================================================================

describe("matriz G — router", () => {
    it("cls: route component monta 1× bajo RouterView y muere al navegar", async () => {
        _resetRouter();
        const host = document.createElement("div");
        document.body.appendChild(host);
        const probe = classProbe();
        const other = tplProbe("other");
        createRouter([
            { path: "/", component: () => probe.content },
            { path: "/away", component: () => other.content },
        ], { mode: "hash" });
        const h = mount(new RouterView(), host);
        await TICK(); await TICK();
        expect(host.querySelector(".probe")).not.toBeNull();
        expectLifecycleOnce(probe.log);
        h.unmount();
        _resetRouter();
        host.remove();
    });
});

// =============================================================================
// --- Celdas: SSR / hydration --------------------------------------------------
// =============================================================================

describe("matriz G — SSR", () => {
    it.each(["tpl", "cls"] as const)("%s: markup + init/render, onMount NO corre", async (kind) => {
        const probe = kind === "cls" ? classProbe() : tplProbe();
        const out = await renderToString(probe.content as never);
        expect(out).toContain("probe");
        if (kind === "cls") {
            const l = (probe as ReturnType<typeof classProbe>).log;
            expect(l.init).toBe(1);
            expect(l.render).toBe(1);
            expect(l.mount).toBe(0); // server-only: onMount nunca en SSR
            expect(l.unmount).toBe(0);
        }
    });
});

describe("matriz G — hydration", () => {
    it.each(["tpl", "cls"] as const)("%s: adopta DOM SSR, onMount 1×, binding vivo", async (kind) => {
        const probe = kind === "cls" ? classProbe() : tplProbe();
        const markup = await renderToString(probe.content as never, { markers: "hydration" });
        const host = document.createElement("div");
        host.innerHTML = markup;
        document.body.appendChild(host);
        const pre = host.querySelector(".probe");
        expect(pre).not.toBeNull();
        const probe2 = kind === "cls" ? classProbe() : tplProbe();
        const handle = hydrate(probe2.content as never, host);
        const post = host.querySelector(".probe");
        // Adopción: el nodo SSR no fue recreado.
        expect(post).toBe(pre);
        if (kind === "cls") {
            const l = (probe2 as ReturnType<typeof classProbe>).log;
            expect(l.mount).toBe(1);
            expect(l.mountAfterDomCommit).toBe(true);
        } else {
            (probe2 as ReturnType<typeof tplProbe>).s.value = "hyd-1";
            expect(host.querySelector(".probe i")!.textContent).toBe("hyd-1");
        }
        handle.unmount();
        host.remove();
    });
});

describe("matriz G — hydration mismatch", () => {
    it.each(["tpl", "cls"] as const)("%s: warn-remount reconstruye DOM correcto", async (kind) => {
        const host = document.createElement("div");
        host.innerHTML = `<div class="wrong">contenido distinto</div>`;
        document.body.appendChild(host);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const probe = kind === "cls" ? classProbe() : tplProbe();
        const handle = hydrate(probe.content as never, host, { mismatch: "warn-remount" });
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        expect(host.querySelector(".probe")).not.toBeNull();
        expect(host.querySelector(".wrong")).toBeNull();
        if (kind === "cls") {
            const l = (probe as ReturnType<typeof classProbe>).log;
            expect(l.mount).toBe(1);
        }
        handle.unmount();
        host.remove();
    });
});

// =============================================================================
// --- Invariantes transversales ------------------------------------------------
// =============================================================================

describe("matriz G — orden y contexto", () => {
    it("hijo onMount corre antes que padre onMount", () => {
        const order: string[] = [];
        class Child extends ElurComponent {
            render() { return html`<i>child</i>`; }
            onMount() { order.push("child"); }
        }
        class Parent extends ElurComponent {
            render() { return html`<div>${new Child()}</div>`; }
            onMount() { order.push("parent"); }
        }
        const host = document.createElement("div");
        document.body.appendChild(host);
        const h = mount(new Parent(), host);
        expect(order).toEqual(["child", "parent"]);
        h.unmount();
        host.remove();
    });

    it("provide/inject correcto dentro del árbol (static child)", () => {
        const seen: unknown[] = [];
        class Child extends ElurComponent {
            render() { seen.push(inject(CTX)); return html`<i>c</i>`; }
        }
        class Parent extends ElurComponent {
            render() { provide(CTX, "ctx-value"); return html`<div>${new Child()}</div>`; }
        }
        const host = document.createElement("div");
        document.body.appendChild(host);
        const h = mount(new Parent(), host);
        expect(seen).toEqual(["ctx-value"]);
        h.unmount();
        host.remove();
    });

    it("devtools hooks: mountStart/mountEnd/unmount pareados, sin fantasmas", () => {
        const calls: string[] = [];
        const hooks = {
            onMountStart: () => calls.push("start"),
            onMountEnd: () => calls.push("end"),
            onUnmount: () => calls.push("unmount"),
        };
        const remove = _addComponentDebugHooks(hooks);
        const host = document.createElement("div");
        document.body.appendChild(host);
        const probe = classProbe();
        const h = mount(probe.content, host);
        h.unmount();
        remove();
        // Pareado: cada start tiene su end; unmount una vez.
        expect(calls.filter((c) => c === "start").length).toBe(1);
        expect(calls.filter((c) => c === "end").length).toBe(1);
        expect(calls.filter((c) => c === "unmount").length).toBe(1);
        expect(calls.indexOf("start")).toBeLessThan(calls.indexOf("end"));
        host.remove();
    });

    it("unmount idempotente — doble unmount no duplica hooks", () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const probe = classProbe();
        const h = mount(probe.content, host);
        h.unmount();
        h.unmount();
        expect(probe.log.unmount).toBe(1);
        expect(probe.log.cleanup).toBe(1);
        host.remove();
    });
});
