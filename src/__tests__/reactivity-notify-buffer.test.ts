import { describe, it, expect } from "vitest";
import { signal, effect, _getNotifyBufSize } from "../elur/reactivity";

// White-box test del buffer interno del runtime ESTABLE — los forks next/
// no tienen notify buffer (push-pull marca estados y encola directamente),
// por eso se excluye de los configs vitest.next*.config.ts.
describe("notify buffer (internals del estable)", () => {
    it("shrinks oversized notify buffer after low usage", () => {
        const s = signal(0);
        const disposers = Array.from({ length: 80 }, () => effect(() => { s.value; }));

        // Grow notify buffer with a high fan-out update.
        s.value = 1;
        expect(_getNotifyBufSize()).toBeGreaterThan(64);

        // Keep only a small subscriber set and trigger low-usage notify.
        for (let i = 0; i < 70; i++) disposers[i]();
        s.value = 2;
        expect(_getNotifyBufSize()).toBe(32);

        for (let i = 70; i < disposers.length; i++) disposers[i]();
    });
});
