import { afterEach, describe, expect, it, vi } from "vitest";
import { _addSignalDebugHooks, _setSignalDebugHooks, signal } from "../elur/reactivity";
import {
    ElurComponent,
    _addComponentDebugHooks,
    _setComponentDebugHooks,
} from "../elur/lifecycle";
import { html } from "../elur/template/index";
import { mount } from "../elur/component";

afterEach(() => {
    _setSignalDebugHooks(null);
    _setComponentDebugHooks(null);
    document.body.innerHTML = "";
});

describe("_addSignalDebugHooks", () => {
    it("delivers create/write events to multiple subscribers", () => {
        const a = { onCreate: vi.fn(), onWrite: vi.fn() };
        const b = { onCreate: vi.fn(), onWrite: vi.fn() };
        const offA = _addSignalDebugHooks(a);
        _addSignalDebugHooks(b);

        const s = signal(1);
        s.value = 2;

        expect(a.onCreate).toHaveBeenCalledTimes(1);
        expect(b.onCreate).toHaveBeenCalledTimes(1);
        expect(a.onWrite).toHaveBeenCalledWith(s, 2);
        expect(b.onWrite).toHaveBeenCalledWith(s, 2);

        offA();
        s.value = 3;
        expect(a.onWrite).toHaveBeenCalledTimes(1);
        expect(b.onWrite).toHaveBeenCalledTimes(2);
    });

    it("preserves a hook previously installed via _setSignalDebugHooks", () => {
        const legacy = { onWrite: vi.fn() };
        _setSignalDebugHooks(legacy);

        const extra = { onWrite: vi.fn() };
        const off = _addSignalDebugHooks(extra);

        const s = signal(0);
        s.value = 1;
        expect(legacy.onWrite).toHaveBeenCalledWith(s, 1);
        expect(extra.onWrite).toHaveBeenCalledWith(s, 1);

        off();
        s.value = 2;
        expect(extra.onWrite).toHaveBeenCalledTimes(1);
        expect(legacy.onWrite).toHaveBeenCalledTimes(2);
    });
});

describe("_addComponentDebugHooks", () => {
    class Probe extends ElurComponent {
        render() {
            return html`<span>probe</span>`;
        }
    }

    it("delivers mount/unmount events to multiple subscribers", () => {
        const a = { onMountStart: vi.fn(), onUnmount: vi.fn() };
        const b = { onMountStart: vi.fn(), onUnmount: vi.fn() };
        const offA = _addComponentDebugHooks(a);
        _addComponentDebugHooks(b);

        const container = document.createElement("div");
        document.body.appendChild(container);
        const handle = mount(new Probe(), container);

        expect(a.onMountStart).toHaveBeenCalledTimes(1);
        expect(b.onMountStart).toHaveBeenCalledTimes(1);

        offA();
        handle.unmount();
        expect(a.onUnmount).not.toHaveBeenCalled();
        expect(b.onUnmount).toHaveBeenCalledTimes(1);
        container.remove();
    });
});
