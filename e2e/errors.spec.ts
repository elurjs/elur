import { test, expect } from "@playwright/test";

// Since v3.4.0, partial attribute interpolation detection moved to the
// build-time Vite plugin. The core's html`` tag no longer throws at
// template creation time for partial interpolation — it silently produces
// a (possibly broken) descriptor. These tests document that behavior.
test.describe("partial interpolation — core behavior (browser DOM)", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/mount");
    });

    test("boolean parcial no lanza error en creación", async ({ page }) => {
        const msg = await page.evaluate(() => window.__elur.tryPartial("boolean"));
        expect(msg).toBe("NO-ERROR");
    });

    test("evento parcial no lanza error en creación", async ({ page }) => {
        const msg = await page.evaluate(() => window.__elur.tryPartial("event"));
        expect(msg).toBe("NO-ERROR");
    });

    test("ref/show/hide parciales no lanzan error en creación", async ({ page }) => {
        const ref = await page.evaluate(() => window.__elur.tryPartial("ref"));
        expect(ref).toBe("NO-ERROR");
        const show = await page.evaluate(() => window.__elur.tryPartial("show"));
        expect(show).toBe("NO-ERROR");
        const hide = await page.evaluate(() => window.__elur.tryPartial("hide"));
        expect(hide).toBe("NO-ERROR");
    });

    test("atributo dinámico y tag name dinámico no lanzan error en creación", async ({ page }) => {
        const dyn = await page.evaluate(() => window.__elur.tryPartial("dynamic"));
        expect(dyn).toBe("NO-ERROR");
        const tag = await page.evaluate(() => window.__elur.tryPartial("tagname"));
        expect(tag).toBe("NO-ERROR");
    });

    test("comilla sin cerrar no lanza error en creación", async ({ page }) => {
        const msg = await page.evaluate(() => window.__elur.tryPartial("unclosed"));
        expect(msg).toBe("NO-ERROR");
    });
});
