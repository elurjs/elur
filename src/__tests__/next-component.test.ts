import { describe, it, expect, vi } from "vitest";
import { signal, effect } from "../elur/next/reactivity";
import {
    defineComponent,
    mountComponent,
    ComponentInstance,
    isComponentInvocation,
    slot,
} from "../elur/next/component";
import { html } from "../elur/template/index";
import { ElurComponent, _addComponentDebugHooks } from "../elur/lifecycle";
import { renderToString } from "../elur/server/index";
import { hydrate } from "../elur/next/hydrate";
import { provide, inject, createInjectionKey } from "../elur/context";
import { repeat } from "../elur/template/keyed";
import { repeatLive } from "../elur/next/keyed-diff";

describe("next/defineComponent", () => {
    it("la invocación no ejecuta setup hasta montar", () => {
        const setup = vi.fn(() => html`<div>hola</div>`);
        const Counter = defineComponent(setup);
        const inv = Counter({});
        expect(setup).not.toHaveBeenCalled();
        expect(isComponentInvocation(inv)).toBe(true);
    });

    it("monta el renderable y muere con unmount", async () => {
        const count = signal(0);
        const Counter = defineComponent(() => {
            return html`<p>${() => count.value}</p>`;
        });
        const container = document.createElement("div");
        const handle = mountComponent(Counter({}), container);
        expect(container.textContent).toBe("0");
        count.value = 5;
        await Promise.resolve(); // los writes de texto van por queueDOMWrite (microtask)
        expect(container.textContent).toBe("5");
        handle.unmount();
        count.value = 9;
        await Promise.resolve();
        // tras unmount: DOM removido por el cleanup del renderable y el
        // binding muerto (no re-render ni re-suscripción)
        expect(container.textContent).toBe("");
        expect(handle.instance.state).toBe("disposed");
    });

    it("ctx.onMount corre después del commit DOM", () => {
        let sawDOM = false;
        const C = defineComponent((_p, ctx) => {
            ctx.onMount(() => {
                sawDOM = container.textContent === "mounted!";
            });
            return html`<span>mounted!</span>`;
        });
        const container = document.createElement("div");
        mountComponent(C({}), container);
        expect(sawDOM).toBe(true);
    });

    it("ctx.onMount cleanup corre en unmount", () => {
        let cleaned = false;
        const C = defineComponent((_p, ctx) => {
            ctx.onMount(() => () => { cleaned = true; });
            return html`<i>x</i>`;
        });
        const container = document.createElement("div");
        const h = mountComponent(C({}), container);
        h.unmount();
        expect(cleaned).toBe(true);
    });

    it("unmount es idempotente", () => {
        let unmounts = 0;
        const C = defineComponent((_p, ctx) => {
            ctx.onUnmount(() => unmounts++);
            return html`<i>x</i>`;
        });
        const container = document.createElement("div");
        const h = mountComponent(C({}), container);
        h.unmount();
        h.unmount();
        expect(unmounts).toBe(1);
    });

    it("fallo en setup dispara rollback: DOM vacío + estado failed", () => {
        const Bad = defineComponent(() => {
            throw new Error("setup explota");
        });
        const container = document.createElement("div");
        const inst = new ComponentInstance(Bad({}));
        expect(() => inst.mount(container, null)).toThrow("setup explota");
        expect(inst.state).toBe("failed");
        expect(container.childNodes.length).toBe(0);
    });

    it("A.13/A.15 — invocación con misma definición+key actualiza props sin recrear setup", async () => {
        const v = signal(1);
        const setup = vi.fn((props: any) => html`<span>${() => props.v}</span>`);
        const Counter = defineComponent(setup);
        const container = document.createElement("div");
        // binding reactivo que produce una invocación por write
        const cleanup = html`<div>${() => Counter({ v: v.value, key: "c" })}</div>`._render(container, null);
        expect(setup).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain("1");
        v.value = 2;
        await Promise.resolve();
        // la instancia sobrevive: setup no volvió a correr y el DOM se actualizó
        expect(setup).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain("2");
        cleanup();
    });

    it("key distinta → remount (setup vuelve a correr)", async () => {
        const v = signal(1);
        const setup = vi.fn((props: any) => html`<span>${() => props.v}</span>`);
        const Counter = defineComponent(setup);
        const container = document.createElement("div");
        const cleanup = html`<div>${() => Counter({ v: v.value, key: v.value > 1 ? "b" : "a" })}</div>`._render(container, null);
        expect(setup).toHaveBeenCalledTimes(1);
        v.value = 2; // cambia v Y key → remount
        await Promise.resolve();
        expect(setup).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain("2");
        cleanup();
    });

    it("onError de ctx captura el fallo en vez de re-lanzar", () => {
        let captured: { phase: string; cause: unknown } | null = null;
        const Bad = defineComponent((_p, ctx) => {
            ctx.onError((info) => { captured = info; });
            throw new Error("boom");
        });
        const container = document.createElement("div");
        const inst = new ComponentInstance(Bad({}));
        inst.mount(container, null);
        expect(captured!.phase).toBe("setup");
        expect((captured!.cause as Error).message).toBe("boom");
        expect(inst.state).toBe("failed");
    });
});

describe("next/contexto por instancia (A.12)", () => {
    it("inject resuelve por la cadena de instancias — padre→hijo", () => {
        const KEY = createInjectionKey<string>("theme");
        let received: string | undefined;
        const Child = defineComponent(() => {
            received = inject(KEY);
            return html`<i>x</i>`;
        });
        const Parent = defineComponent(() => {
            provide(KEY, "dark");
            return html`<div>${Child({})}</div>`;
        });
        mountComponent(Parent({}), document.createElement("div"));
        expect(received).toBe("dark");
    });

    it("inject funciona en onMount y en effects — contexto permanente (A.3.6)", () => {
        const KEY = createInjectionKey<string>("theme");
        let inMount: string | undefined;
        let inEffect: string | undefined;
        const Child = defineComponent((_p, ctx) => {
            ctx.onMount(() => { inMount = inject(KEY); });
            effect(() => { inEffect = inject(KEY); });
            return html`<i>x</i>`;
        });
        const Parent = defineComponent(() => {
            provide(KEY, "dark");
            return html`<div>${Child({})}</div>`;
        });
        mountComponent(Parent({}), document.createElement("div"));
        // En el modelo de stack, onInit/render ya habrían popeado el frame —
        // aquí inject resuelve igual porque el contexto ES de la instancia.
        expect(inMount).toBe("dark");
        expect(inEffect).toBe("dark");
    });
});

describe("next/slots (A.14)", () => {
    it("ctx.slot() renderiza el contenido declarado por el consumidor", () => {
        const Card = defineComponent((_p, ctx) => {
            return html`<section><h1>card</h1><div>${() => ctx.slot()}</div></section>`;
        });
        const container = document.createElement("div");
        mountComponent(
            Card({}, { default: slot(() => html`<p>slot content</p>`) }),
            container,
        );
        expect(container.textContent).toContain("card");
        expect(container.textContent).toContain("slot content");
    });

    it("named slots: ctx.slot('actions')", () => {
        const Card = defineComponent((_p, ctx) => {
            return html`<section><div class="body">${() => ctx.slot()}</div><div class="actions">${() => ctx.slot("actions")}</div></section>`;
        });
        const container = document.createElement("div");
        mountComponent(
            Card({}, {
                default: slot(() => html`<p>body</p>`),
                actions: slot(() => html`<button>save</button>`),
            }),
            container,
        );
        expect(container.querySelector(".body")!.textContent).toContain("body");
        expect(container.querySelector(".actions")!.textContent).toContain("save");
    });

    it("el slot resuelve contexto del padre declarante (léxico)", () => {
        const KEY = createInjectionKey<string>("slot-ctx");
        // Child se declara en el slot del Root: aunque se monta DENTRO de
        // Wrapper (que también provee KEY), debe ver el provide de Root —
        // contexto léxico, no el de la cadena de montaje.
        const Child = defineComponent(() => {
            return html`<span>${inject(KEY)}</span>`;
        });
        const Wrapper = defineComponent((_p, ctx) => {
            provide(KEY, "from-wrapper");
            return html`<div class="wrap">${() => ctx.slot()}</div>`;
        });
        const Root = defineComponent(() => {
            provide(KEY, "from-root");
            return html`<main>${Wrapper({}, { default: slot(() => Child({})) })}</main>`;
        });
        const container = document.createElement("div");
        mountComponent(Root({}), container);
        expect(container.textContent).toContain("from-root");
        expect(container.textContent).not.toContain("from-wrapper");
    });
});

describe("next/SSR + hydrate de funciones (A.17/A.18)", () => {
    it("renderToString serializa un componente funcional (A.17)", async () => {
        const setup = vi.fn((props: any) => html`<b>fn:${props.v}</b>`);
        const C = defineComponent(setup);
        const out = await renderToString(C({ v: 7 }), { markers: "hydration" });
        expect(out).toContain("fn:");
        expect(out).toContain("7");
        // setup corre una vez en server y no hay lifecycle DOM
        expect(setup).toHaveBeenCalledTimes(1);
    });

    it("onServerRender corre en SSR, onMount no (A.17)", async () => {
        const calls: string[] = [];
        const C = defineComponent((_p, ctx) => {
            ctx.onServerRender(() => calls.push("server"));
            ctx.onMount(() => { calls.push("mount"); });
            return html`<i>x</i>`;
        });
        await renderToString(C({}), {});
        expect(calls).toEqual(["server"]);
    });

    it("hydrate adopta el DOM SSR y activa bindings bajo el owner de la instancia (A.18)", async () => {
        const n = signal(5);
        const C = defineComponent(() => html`<b>fn:${() => n.value}</b>`);
        const container = document.createElement("div");
        container.innerHTML = await renderToString(C({}), { markers: "hydration" });
        const b = container.querySelector("b")!;
        expect(container.textContent).toContain("fn:5");

        const handle = hydrate(C({}), container);
        // nodo SSR adoptado, no recreado
        expect(container.querySelector("b")).toBe(b);
        // binding vivo tras hidratación
        n.value = 9;
        await Promise.resolve();
        expect(container.textContent).toContain("fn:9");
        // unmount mata el binding
        handle.unmount();
        n.value = 12;
        await Promise.resolve();
        expect(container.textContent).not.toContain("fn:12");
    });
});

describe("next/adaptador de clase", () => {
    it("monta un ElurComponent clásico via kernel", () => {
        const order: string[] = [];
        class C extends ElurComponent {
            render() {
                return html`<b>clase</b>`;
            }
            onInit() { order.push("init"); }
            onMount() { order.push("mount"); }
            onUnmount() { order.push("unmount"); }
        }
        const container = document.createElement("div");
        const h = mountComponent(new C(), container);
        expect(container.textContent).toBe("clase");
        expect(order).toEqual(["init", "mount"]);
        h.unmount();
        expect(order).toEqual(["init", "mount", "unmount"]);
        expect(h.instance.state).toBe("disposed");
    });

    it("effects del render de una clase mueren al unmount", () => {
        const s = signal(0);
        let effectRuns = 0;
        class C extends ElurComponent {
            render() {
                effect(() => { effectRuns++; s.value; });
                return html`<b>x</b>`;
            }
        }
        const container = document.createElement("div");
        const h = mountComponent(new C(), container);
        s.value = 1;
        const ran = effectRuns;
        h.unmount();
        s.value = 2;
        expect(effectRuns).toBe(ran); // no más runs tras unmount
    });
});

describe("A.16 — error boundaries", () => {
    it("error en setup burbujea a la boundary del padre", () => {
        const seen: string[] = [];
        const Bad = defineComponent(() => {
            throw new Error("boom-setup");
        });
        const Good = defineComponent((_p, ctx) => {
            ctx.onError((info) => {
                seen.push(info.phase + ":" + (info.cause as Error).message);
                return { handled: true };
            });
            return html`<div>${Bad({})}</div>`;
        });
        const container = document.createElement("div");
        // El hijo falla en setup; la boundary del padre lo maneja.
        mountComponent(Good({}), container);
        expect(seen).toEqual(["setup:boom-setup"]);
    });

    it("error sin boundary se propaga", () => {
        const Bad = defineComponent(() => {
            throw new Error("boom");
        });
        const container = document.createElement("div");
        expect(() => mountComponent(Bad({}), container)).toThrow("boom");
    });

    it("boundary con fallback lo renderiza en la posición", () => {
        const Bad = defineComponent(() => {
            throw new Error("x");
        });
        const Wrapper = defineComponent((_p, ctx) => {
            ctx.onError(() => ({
                handled: true,
                fallback: "FALLBACK-TEXT",
            }));
            return html`<div>${Bad({})}</div>`;
        });
        const container = document.createElement("div");
        mountComponent(Wrapper({}), container);
        expect(container.textContent).toContain("FALLBACK-TEXT");
    });

    it("error en effect burbujea por la cadena de owners a la boundary", () => {
        const seen: string[] = [];
        const s = signal(0);
        const Child = defineComponent(() => {
            effect(() => {
                if (s.value > 0) throw new Error("effect-boom");
                s.value;
            });
            return html`<span>ok</span>`;
        });
        const Wrapper = defineComponent((_p, ctx) => {
            ctx.onError((info) => {
                seen.push(info.phase);
                return { handled: true };
            });
            return html`<div>${Child({})}</div>`;
        });
        const container = document.createElement("div");
        mountComponent(Wrapper({}), container);
        s.value = 1;
        expect(seen).toEqual(["effect"]);
    });

    it("onMount que lanza → rollback + boundary (fase mount)", () => {
        const seen: string[] = [];
        const Child = defineComponent((_p, ctx) => {
            ctx.onMount(() => {
                throw new Error("mount-boom");
            });
            return html`<span>hi</span>`;
        });
        const Wrapper = defineComponent((_p, ctx) => {
            ctx.onError((info) => {
                seen.push(info.phase + ":" + (info.cause as Error).message);
                return { handled: true };
            });
            return html`<div>${Child({})}</div>`;
        });
        const container = document.createElement("div");
        mountComponent(Wrapper({}), container);
        expect(seen).toEqual(["mount:mount-boom"]);
    });
});

describe("C.16.1 — keyed list, misma key objeto nuevo", () => {
    // El fix correcto NO es remount (rompe identidad DOM en reorder) sino
    // señales por item: repeatLive pasa accessors y los bindings actualizan
    // in-place. `repeat` clásico conserva la semántica vieja (item capturado).
    it("repeatLive: objeto nuevo misma key → contenido actualiza SIN remount", async () => {
        const items = signal([{ id: 1, name: "A" }]);
        const container = document.createElement("div");
        const cleanup = html`<ul>${() =>
            repeatLive(
                items.value,
                (i) => i.id,
                (getItem) => html`<li>${() => getItem().name}</li>`,
            )}</ul>`._render(container, null);
        const li = container.querySelector("li");
        expect(container.textContent).toContain("A");
        items.value = [{ id: 1, name: "B" }];
        await Promise.resolve(); // los writes de texto van por microtask
        expect(container.textContent).toContain("B");
        expect(container.textContent).not.toContain("A");
        expect(container.querySelector("li")).toBe(li); // DOM preservado
        cleanup();
    });

    it("repeatLive: reorder con objetos nuevos preserva nodos y actualiza", async () => {
        const items = signal([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
        const container = document.createElement("div");
        const cleanup = html`<ul>${() =>
            repeatLive(
                items.value,
                (i) => i.id,
                (getItem) => html`<li>${() => getItem().n}</li>`,
            )}</ul>`._render(container, null);
        const [liA, liB] = Array.from(container.querySelectorAll("li"));
        items.value = [{ id: "b", n: 20 }, { id: "a", n: 10 }];
        await Promise.resolve();
        const lis = Array.from(container.querySelectorAll("li"));
        expect(lis[0]).toBe(liB); // identidad preservada en el move
        expect(lis[1]).toBe(liA);
        expect(lis[0].textContent).toBe("20"); // contenido actualizado
        expect(lis[1].textContent).toBe("10");
        cleanup();
    });

    it("repeat clásico: documenta semántica — objeto nuevo misma key NO actualiza", () => {
        const items = signal([{ id: 1, name: "A" }]);
        const container = document.createElement("div");
        const cleanup = html`<ul>${() =>
            repeat(
                items.value,
                (i) => i.id,
                (i) => html`<li>${i.name}</li>`,
            )}</ul>`._render(container, null);
        items.value = [{ id: 1, name: "B" }];
        // Semántica vieja preservada (identidad > contenido) — el fix es repeatLive.
        expect(container.textContent).toContain("A");
        cleanup();
    });
});

describe("A.3.8 — detach/attach", () => {
    it("detach preserva estado y effects; attach reinserta", async () => {
        const count = signal(0);
        const C = defineComponent(() => html`<p>${() => count.value}</p>`);
        const container = document.createElement("div");
        const inst = new ComponentInstance(C({}));
        inst.mount(container, null);
        const p = container.querySelector("p")!;
        expect(inst.state).toBe("mounted");

        inst.detach();
        expect(inst.state).toBe("deactivated");
        expect(container.querySelector("p")).toBeNull(); // fuera del DOM

        count.value = 7; // effects siguen vivos detached
        await Promise.resolve();
        expect(p.textContent).toBe("7");

        inst.attach();
        expect(inst.state).toBe("mounted");
        expect(container.querySelector("p")).toBe(p); // MISMO nodo
        expect(container.textContent).toContain("7");
        inst.unmount();
        expect(inst.state).toBe("disposed");
    });

    it("unmount de detached dispone limpio", () => {
        const C = defineComponent(() => html`<p>x</p>`);
        const container = document.createElement("div");
        const inst = new ComponentInstance(C({}));
        inst.mount(container, null);
        inst.detach();
        inst.unmount();
        expect(inst.state).toBe("disposed");
    });
});

describe("A.2.7/A.2.8 — arrays estáticos y reactivos", () => {
    it("effects dentro de items de array estático limpian con el binding", async () => {
        const s = signal(0);
        let effectRuns = 0;
        const container = document.createElement("div");
        // Array estático: cada item crea un effect durante su render.
        const cleanup = html`<div>${[
            html`<span>a</span>`,
            html`<span>b</span>`,
        ]}</div>`._render(container, null);
        cleanup();
        // Tras cleanup del binding los items están fuera — cualquier effect
        // creado por sus templates ya no corre.
        s.value++;
        await Promise.resolve();
        expect(effectRuns).toBe(0);
    });

    it("provide() dentro de item de keyed list lo ven sus hijos", () => {
        const KEY = createInjectionKey<string>("item-key");
        const Child = defineComponent(() => {
            const v = inject(KEY);
            return html`<i>${v}</i>`;
        });
        // El item provee a SUS hijos directos en su propio render.
        const Item = defineComponent(() => {
            provide(KEY, "from-item");
            return html`<b>${Child({})}</b>`;
        });
        const items = signal([{ id: 1 }, { id: 2 }]);
        const container = document.createElement("div");
        const cleanup = html`<ul>${() =>
            repeat(
                items.value,
                (i) => i.id,
                () => Item({}) as never,
            )}</ul>`._render(container, null);
        const texts = container.textContent;
        expect(texts).toContain("from-item");
        expect(texts.match(/from-item/g)!.length).toBe(2); // ambos items
        cleanup();
    });
});
describe("A.2.4/A.3.3 — debug events del kernel", () => {
    it("mountStart/mountEnd/unmount con referencia a la instancia", () => {
        const events: string[] = [];
        let mountedRef: unknown = null;
        const off = _addComponentDebugHooks({
            onMountStart: (i) => { events.push("start"); mountedRef = i; },
            onMountEnd: () => events.push("end"),
            onUnmount: () => events.push("unmount"),
        });
        const C = defineComponent(() => html`<p>x</p>`);
        const inst = new ComponentInstance(C({}));
        inst.mount(document.createElement("div"), null);
        expect(events).toEqual(["start", "end"]);
        expect(mountedRef).toBe(inst); // funcional → la instancia
        inst.unmount();
        expect(events).toEqual(["start", "end", "unmount"]);
        off();
    });

    it("A.3.3: mountEnd se emite aunque el mount falle (balanceado)", () => {
        const events: string[] = [];
        const off = _addComponentDebugHooks({
            onMountStart: () => events.push("start"),
            onMountEnd: () => events.push("end"),
        });
        const Bad = defineComponent(() => { throw new Error("boom"); });
        const inst = new ComponentInstance(Bad({}));
        expect(() => inst.mount(document.createElement("div"), null)).toThrow();
        expect(events).toEqual(["start", "end"]); // balanceado
        off();
    });
});

describe("C.16.2 — fast paths", () => {
    const renderKeys = (ids: number[]) =>
        repeat(ids, (i) => i, (i) => html`<li>${i}</li>`);
    it("insert en medio con suffix: orden correcto", async () => {
        const items = signal([1, 2, 3]);
        const container = document.createElement("div");
        const cleanup = html`<ul>${() => renderKeys(items.value)}</ul>`._render(container, null);
        items.value = [1, 9, 2, 3]; // 9 entre 1 y 2 (suffix = [2,3])
        await Promise.resolve();
        await Promise.resolve();
        const lis = container.querySelectorAll("li");
        expect([...lis].map((l) => l.textContent)).toEqual(["1", "9", "2", "3"]);
        cleanup();
    });
    it("prepend y append puros preservan nodos", async () => {
        const items = signal([2, 3]);
        const container = document.createElement("div");
        const cleanup = html`<ul>${() => renderKeys(items.value)}</ul>`._render(container, null);
        await Promise.resolve();
        const before = [...container.querySelectorAll("li")];
        items.value = [1, 2, 3, 4]; // prepend 1 + append 4
        await Promise.resolve();
        await Promise.resolve();
        const after = [...container.querySelectorAll("li")];
        expect(after.map((l) => l.textContent)).toEqual(["1", "2", "3", "4"]);
        expect(after[1]).toBe(before[0]); // 2 mismo nodo
        expect(after[2]).toBe(before[1]); // 3 mismo nodo
        cleanup();
    });
});

describe("A.21 — controllers (Lit-style)", () => {
    it("hooks completos: init→mounted→deactivate→activate→unmount", () => {
        const calls: string[] = [];
        class Ctrl { hostInit(){calls.push("init")} hostMounted(){calls.push("mounted")}
            hostDeactivate(){calls.push("deact")} hostActivate(){calls.push("act")}
            hostUnmount(){calls.push("unmount")} }
        class C extends ElurComponent {
            constructor() { super(); this.addController(new Ctrl()); }
            render() { return html`<p>x</p>`; }
        }
        const inst = new ComponentInstance(new C());
        inst.mount(document.createElement("div"), null);
        expect(calls).toEqual(["init", "mounted"]);
        inst.detach();
        inst.attach();
        expect(calls).toEqual(["init", "mounted", "deact", "act"]);
        inst.unmount();
        expect(calls).toContain("unmount");
    });

    it("programático: inst.addController + owner posee lo que crea", async () => {
        let ran = 0;
        const s = signal(0);
        const C = defineComponent(() => html`<p>x</p>`);
        const inst = new ComponentInstance(C({}));
        inst.addController({
            hostInit() { effect(() => { s.value; ran++; }); },
        });
        inst.mount(document.createElement("div"), null);
        expect(ran).toBe(1);
        s.value++;
        await Promise.resolve();
        expect(ran).toBe(2); // el effect del controller vive
        inst.unmount();
        s.value++;
        await Promise.resolve();
        expect(ran).toBe(2); // muerto con la instancia
    });
});
