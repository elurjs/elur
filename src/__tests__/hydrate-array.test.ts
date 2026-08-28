import { describe, expect, it } from "vitest";
import { signal, computed } from "../elur/reactivity.js";
import { html } from "../elur/template/html.js";
import { renderToString } from "../elur/server/index.js";
import { hydrate } from "../elur/hydrate/index.js";

describe("hydrate reactive array + computed", () => {
  it("updates the computed filter after hydration", async () => {
    const genre = signal<string | null>(null);
    const movies = [
      { title: "Inception", genres: ["Sci-Fi"] },
      { title: "Mad Max", genres: ["Sci-Fi"] },
      { title: "Everything", genres: ["Sci-Fi"] },
      { title: "Spirited Away", genres: ["Animation"] },
    ];
    const visible = computed(() => {
      const g = genre.value;
      return movies.filter((m) => !g || m.genres.includes(g));
    });
    const count = computed(() => visible.value.length);
    const template = html`
      <div>
        <button @click=${() => (genre.value = genre.value === "Sci-Fi" ? null : "Sci-Fi")}>toggle</button>
        <p>${() => count.value} resultado</p>
        ${() => visible.value.map((m) => html`<article class="movie-card">${m.title}</article>`)}
      </div>
    `;
    const container = document.createElement("div");
    container.innerHTML = await renderToString(template, { markers: "hydration" });
    const handle = hydrate(template, container);
    expect(container.querySelectorAll(".movie-card")).toHaveLength(4);
    expect(container.querySelector("p")!.textContent).toContain("4");
    (container.querySelector("button")!).click();
    expect(container.querySelectorAll(".movie-card")).toHaveLength(3);
    expect(container.querySelector("p")!.textContent).toContain("3");
    handle.unmount();
  });
});
