# Elur

[![npm version](https://img.shields.io/npm/v/@elurjs/core.svg)](https://www.npmjs.com/package/@elurjs/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-766%20passing-brightgreen.svg)]()
[![Coverage](https://img.shields.io/badge/coverage-95.86%25-brightgreen.svg)]()
[![Bundle size](https://img.shields.io/badge/min%2Bgzip-~21%20KB-orange.svg)]()
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)]()
[![Website](https://img.shields.io/badge/website-elur-indigo.svg)](https://elur.dev/)

A lightweight, fully reactive framework for building modern web UIs — no virtual DOM, no required build step. Just signals, tagged templates, and pure TypeScript. Optional compiler + SSR/SSG via `@elurjs/kit`.

**[→ Documentation & Live Demo](https://elur.dev/)**

```
~63 KB minified · ~21 KB gzipped · zero dependencies · TypeScript-first · ES2022
```

## What's new in v4

Elur 4 runs a redesigned reactive engine — push-pull, versioned, glitch-free:

- **No glitches, ever** — diamond dependencies propagate version-consistent values; effects never observe torn state (the classic diamond produces inconsistent runs on 3.x, single consistent runs on 4.x).
- **Lazy computeds** — `computed()` re-evaluates on read only when a source actually changed; cold computeds cost nothing.
- **Ownership** — `createRoot`, `getOwner`, `runWithOwner`, `onCleanup`: deterministic disposal of whole reactive subtrees.
- **Scheduler** — render writes flush before user effects; long effect queues yield only when input is pending (`scheduler.yield`, Chromium).
- **Live lists** — `repeatLive`, `liveList`, shallow-equal entry preservation, keyed diffing with O(1) owner cleanup.
- **Compiled bindings** — `@elurjs/vite-plugin-elur` emits direct signal→DOM writes (no generic effect per binding) and compiled hydration.

Same API surface — `signal`, `computed`, `effect`, `watch`, `html`, `repeat`, `ElurComponent`, `createRouter` all unchanged.

## Installation

```bash
npm install @elurjs/core
```

## Subpath Imports (Tree-Shaking)

When you only need one module, import from subpaths:

```typescript
import { signal, effect } from "@elurjs/core/signals";
import { createRouter } from "@elurjs/core/router";
import { createStore } from "@elurjs/core/store";
import { createForm } from "@elurjs/core/form";
import { suspend, lazy } from "@elurjs/core/async";
import { html, repeat, transition } from "@elurjs/core/template";
import { mount } from "@elurjs/core/component";
import { ElurComponent } from "@elurjs/core/lifecycle";
import { provide, inject, createInjectionKey } from "@elurjs/core/context";
import { enableDevTools } from "@elurjs/core/devtools";
```

This is optional: `import { ... } from "@elurjs/core"` remains fully supported.

## Quick Start

```typescript
import { signal, html, ElurTemplate, ElurComponent, mount, createRouter, RouterView, Link, elurRouter } from "@elurjs/core";

// --- Pages as function components (ElurTemplate) ---
// Plain functions returning html`` are recommended for pages and
// display-only components — no class needed, signals just work.

function HomePage(): ElurTemplate {
  const count = signal(0);
  return html`
    <h1>Home</h1>
    <p>Count: ${() => count.value}</p>
    <button @click=${() => count.value++}>+1</button>
  `;
}

function UserPage(): ElurTemplate {
  const router = elurRouter();
  return html`<h1>User: ${() => router.params.value.id}</h1>`;
}

// --- Stateful component as class component (ElurComponent) ---
// Use a class when you need lifecycle hooks: onInit / onMount / onUnmount.

class Clock extends ElurComponent {
  private time = signal(new Date().toLocaleTimeString());
  private _id = 0;

  onMount() {
    this._id = setInterval(() => {
      this.time.value = new Date().toLocaleTimeString();
    }, 1000);
    return () => clearInterval(this._id); // auto-cleanup on unmount
  }

  render() {
    return html`<p>Clock: ${() => this.time.value}</p>`;
  }
}

// --- Router ---

const router = createRouter([
  { path: "/",         component: () => HomePage() },
  { path: "/user/:id", component: () => UserPage() },
]);

// --- App shell (function component) ---

function App(): ElurTemplate {
  return html`
    <nav>${new Link("/", "Home")} ${new Link("/user/42", "User 42")}</nav>
    ${new Clock()}
    ${new RouterView()}
  `;
}

mount(App(), "#app", { router });
```

## What's Included

Everything ships in a single zero-dependency import:

| Category | APIs |
|---|---|
| **Reactivity** | `signal`, `computed`, `effect`, `batch`, `watch`, `untrack`, `nextTick`, `createRoot`, `getOwner`, `runWithOwner`, `onCleanup`, `constSignal` |
| **Templates** | `` html` ` ``, `repeat`, `ref`, `portal`, `transition`, `showWhen` |
| **Components** | `ElurTemplate` (function components), `ElurComponent` (lifecycle class), `mount`, children & named slots |
| **Router** | `createRouter`, `RouterView`, `Link`, `elurRouter`, `RouterKey`, guards, nested routes, named routes (`name` + `navigate({ name })`), `mount(..., { router })` |
| **Forms** | `elurField`, `createForm`, `elurFieldArray`, built-in validators, programmatic value setting, Zod/Valibot interop |
| **State** | `createStore`, `provide`, `inject`, `createInjectionKey` |
| **Async** | `suspend` (with `invalidate` for re-fetching), `lazy` |
| **Error handling** | `createErrorBoundary` |

## Server-side rendering & hydration (v3)

```bash
npm install @elurjs/core
```

```typescript
import { renderToString, renderToChunks, createServerRenderScope } from "@elurjs/core/server";
import { hydrate } from "@elurjs/core/hydrate";
import { raw } from "@elurjs/core";
```

- DOM-free SSR (`renderToString`), incremental streaming (`renderToChunks`) and
  isolated render scopes (`createServerRenderScope`).
- Real hydration over existing SSR DOM: preserves nodes, focus, input state and
  scroll; keyed `repeat()` lists are adopted without recreating nodes.
- Render protocols (`renderServer` / `mountDom` / `hydrateDom`) and `raw()` for
  explicit trusted HTML.
- Minified with Oxc; validated by `npm run test:artifact`.

## Documentation

## Query Package

`createQuery` and query cache utilities now live in `@elurjs/query`.

```bash
npm install @elurjs/query
```

Full API reference, guides, and examples:

**→ [github.com/elurjs/elur](https://github.com/elurjs/elur)**

## License

MIT
