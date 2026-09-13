import { describe, it, expect } from "vitest";
import { signal } from "../elur/reactivity.js";
import { html } from "../elur/template/html.js";
import { renderToString } from "../elur/server/index.js";
import { hydrate } from "../elur/hydrate/index.js";
import { ELUR_TEMPLATE_DESCRIPTOR } from "../elur/template/types.js";
import type { ElurTemplate, TemplateDescriptor } from "../elur/template/types.js";

/**
 * C.13 — hidratación compilada: el descriptor puede traer `hydrate`, una
 * activación por posición que el runtime despacha sin scan global de
 * markers. SSR omite `data-elur-*` cuando el descriptor la tiene.
 */
describe("compiled hydrate dispatch", () => {
    it("hydrate() llama a descriptor.hydrate con root+values+bounds", async () => {
        const s = signal("hola");
        const template = html`<div class=${s}>${s}</div>`;
        const container = document.createElement("div");
        container.innerHTML = await renderToString(template, { markers: "hydration" });

        let called: { root: unknown; values: unknown } | null = null;
        const descriptor = template[ELUR_TEMPLATE_DESCRIPTOR] as TemplateDescriptor;
        const compiled = {
            ...descriptor,
            hydrate: (root: unknown, values: readonly unknown[]) => {
                called = { root, values };
                return () => { };
            },
        };
        // Simula un template compilado: descriptor con hydrate.
        const fake = { ...template, [ELUR_TEMPLATE_DESCRIPTOR]: compiled } as ElurTemplate;
        const handle = hydrate(fake, container);
        const call = called as { root: unknown; values: readonly unknown[] } | null;
        expect(call).not.toBeNull();
        expect(call!.root).toBe(container);
        expect(call!.values[0]).toBe(s);
        handle.unmount();
    });

    it("SSR omite data-elur-* cuando el descriptor trae hydrate", async () => {
        const s = signal("x");
        const template = html`<div class=${s}>${s}</div>`;
        const descriptor = template[ELUR_TEMPLATE_DESCRIPTOR] as TemplateDescriptor;
        const compiled = { ...descriptor, hydrate: () => () => { } };
        const fake = { ...template, [ELUR_TEMPLATE_DESCRIPTOR]: compiled } as ElurTemplate;

        const out = await renderToString(fake, { markers: "hydration" });
        expect(out).not.toContain("data-elur-a-");
        // Los boundaries de nodo siguen emitiéndose.
        expect(out).toContain("<!--elur-1-->");
        expect(out).toContain("<!--elur-end-1-->");
    });
});
