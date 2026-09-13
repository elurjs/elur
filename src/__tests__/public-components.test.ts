/**
 * Public-API smoke test — importa SOLO desde el barrel público
 * (`../index.js`), el mismo path que un consumidor npm de `@elurjs/core`.
 * Verifica que el modelo de componentes funcionales funciona end-to-end
 * sin tocar imports internos.
 */
import { describe, it, expect } from "vitest";
import {
    defineComponent,
    mountComponent,
    mount,
    slot,
    signal,
    html,
    createInjectionKey,
    provide,
    inject,
    onCleanup,
} from "../index.js";

describe("public API — componentes funcionales", () => {
    it("defineComponent + mountComponent: props y lifecycle", async () => {
        let mounted = 0;
        let unmounted = 0;
        let countRef: { value: number } | undefined;
        const Counter = defineComponent<{ initial: number }>((props, ctx) => {
            ctx.onMount(() => { mounted++; });
            ctx.onUnmount(() => { unmounted++; });
            const count = signal(props?.initial ?? 0);
            countRef = count;
            return html`<button>${() => count.value}</button>`;
        });

        const container = document.createElement("div");
        const handle = mountComponent(Counter({ initial: 10 }), container);

        expect(container.textContent).toBe("10");
        expect(mounted).toBe(1);

        countRef!.value = 11;
        await Promise.resolve();
        expect(container.textContent).toBe("11");

        handle.unmount();
        expect(unmounted).toBe(1);
        expect(container.textContent).toBe("");
    });

    it("slots declarados por el consumidor con contexto léxico", () => {
        const KEY = createInjectionKey<string>("k");
        const Child = defineComponent(() => html`<b>${inject(KEY)}</b>`);
        const Wrapper = defineComponent((_p, ctx) => {
            provide(KEY, "wrapper");
            return html`<div>${() => ctx.slot()}</div>`;
        });
        const Root = defineComponent(() => {
            provide(KEY, "root");
            return html`${Wrapper({}, { default: slot(() => Child({})) })}`;
        });

        const container = document.createElement("div");
        mountComponent(Root({}), container);
        expect(container.textContent).toBe("root");
    });

    it("mount() acepta invocaciones directamente", () => {
        const App = defineComponent(() => html`<main>ok</main>`);
        const container = document.createElement("div");
        const h = mount(App({}), container);
        expect(container.textContent).toBe("ok");
        h.unmount();
    });

    it("props vivas: mismo def + key actualiza sin re-correr setup", async () => {
        let setups = 0;
        const Label = defineComponent<{ text: string; key?: string }>((props) => {
            setups++;
            return html`<span>${() => props!.text}</span>`;
        });

        const current = signal("a");
        const container = document.createElement("div");
        const h = mount(
            html`<div>${() => Label({ text: current.value, key: "l" })}</div>`,
            container,
        );
        expect(setups).toBe(1);

        current.value = "b";
        await Promise.resolve();
        expect(container.textContent).toBe("b");
        expect(setups).toBe(1); // updateProps — setup no re-corrió
        h.unmount();
    });

    it("onCleanup dentro de setup muere con el componente", () => {
        let cleaned = false;
        const C = defineComponent(() => {
            onCleanup(() => { cleaned = true; });
            return html`<i>x</i>`;
        });
        const container = document.createElement("div");
        const h = mountComponent(C({}), container);
        h.unmount();
        expect(cleaned).toBe(true);
    });
});
