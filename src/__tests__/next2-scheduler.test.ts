import { describe, it, expect, vi, afterEach } from "vitest";
import { signal, effect, batch } from "../elur/next-2/reactivity";
import { inputPending, yieldControl, scheduleTask } from "../elur/next-2/scheduler";

// F5: el flush cede el hilo sólo cuando (a) quedan user effects pendientes,
// (b) ya corrieron >256 pasos y (c) el navegador reporta input pendiente.
// Sin `navigator.scheduling` (o isInputPending=false) el flush es 100%
// síncrono — semántica intacta.

const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));
const flushMacrotasks = async () => { await macrotask(); await macrotask(); };

function stubScheduler(pending: boolean) {
    vi.stubGlobal("navigator", {
        scheduling: { isInputPending: () => pending },
    });
    // Determinista: `scheduler.yield` resuelve como microtask — el check
    // síncrono post-write sigue viendo sólo los pasos pre-yield.
    vi.stubGlobal("scheduler", { yield: () => Promise.resolve() });
}

afterEach(async () => {
    vi.unstubAllGlobals();
    // Drena cualquier continuación de flush pendiente — `flushing` queda
    // limpio para el siguiente test.
    await flushMacrotasks();
});

describe("next2/scheduler — primitivas F5", () => {
    it("inputPending() → false sin navigator.scheduling", () => {
        expect(inputPending()).toBe(false);
    });

    it("inputPending() refleja navigator.scheduling.isInputPending", () => {
        stubScheduler(true);
        expect(inputPending()).toBe(true);
        stubScheduler(false);
        expect(inputPending()).toBe(false);
    });

    it("yieldControl() resuelve en una macrotask sin scheduler.yield", async () => {
        let done = false;
        void yieldControl().then(() => { done = true; });
        expect(done).toBe(false);
        await flushMacrotasks();
        expect(done).toBe(true);
    });

    it("scheduleTask background → macrotask; user-blocking → microtask", async () => {
        const order: string[] = [];
        scheduleTask(() => order.push("bg"), "background");
        scheduleTask(() => order.push("ub"), "user-blocking");
        order.push("sync");
        await Promise.resolve();
        // user-blocking ya corrió (microtask); background sigue pendiente.
        expect(order).toEqual(["sync", "ub"]);
        await flushMacrotasks();
        expect(order).toEqual(["sync", "ub", "bg"]);
    });
});

describe("next2/flush — yield bajo input pendiente (F5)", () => {
    it("sin input pendiente: el flush de N effects es completamente síncrono", () => {
        stubScheduler(false);
        const s = signal(0);
        let ran = 0;
        for (let i = 0; i < 300; i++) effect(() => { void s.value; ran++; });
        ran = 0;
        s.value = 1;
        expect(ran).toBe(300);
    });

    it("con input pendiente y >256 user effects: cede y retoma en orden", async () => {
        stubScheduler(true);
        const s = signal(0);
        const order: number[] = [];
        for (let i = 0; i < 300; i++) {
            const idx = i;
            effect(() => { void s.value; order.push(idx); });
        }
        order.length = 0;

        s.value = 1;
        // Cedió tras 256 pasos: la cola NO se drenó en el mismo turno.
        expect(order.length).toBe(256);

        await flushMacrotasks();
        // La continuación drenó el resto — todos corrieron exactamente una
        // vez (el orden de encolado es el de la lista de consumers, no FIFO
        // de creación; el contrato es completitud, no orden).
        expect(order.length).toBe(300);
        expect(new Set(order).size).toBe(300);
    });

    it("writes durante el gap del yield los drena la continuación", async () => {
        stubScheduler(true);
        const s = signal(0);
        let ran = 0;
        for (let i = 0; i < 300; i++) effect(() => { void s.value; ran++; });
        ran = 0;

        s.value = 1;
        expect(ran).toBe(256);
        // Write reentrante durante el gap: flushing sigue activo — encola,
        // no arranca un segundo flush.
        s.value = 2;
        expect(ran).toBe(256);

        await flushMacrotasks();
        // Los 44 pendientes corren una vez (leen v2 directo); los 256 ya
        // corridos se re-encolaron y corren de nuevo → 256 + 300 = 556.
        expect(ran).toBe(556);
    });

    it("pocos effects con input pendiente: no cede (bajo el umbral)", () => {
        stubScheduler(true);
        const s = signal(0);
        let ran = 0;
        for (let i = 0; i < 10; i++) effect(() => { void s.value; ran++; });
        ran = 0;
        s.value = 1;
        expect(ran).toBe(10);
    });

    it("batch() respeta el yield igual que un write suelto", async () => {
        stubScheduler(true);
        const s = signal(0);
        let ran = 0;
        for (let i = 0; i < 300; i++) effect(() => { void s.value; ran++; });
        ran = 0;

        batch(() => { s.value = 1; });
        expect(ran).toBe(256);
        await flushMacrotasks();
        expect(ran).toBe(300);
    });
});
