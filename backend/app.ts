import { Hono } from "hono";
import { draftApi } from "./draft.ts";
import { labApi } from "./lab.ts";

/** Inject asset access so routing can be exercised without Val Town services. */
export function createApp(readPage: () => Promise<string>, serveAsset: (path: string) => Promise<Response>): Hono {
  const app = new Hono();
  app.onError((error) => {
    console.error("unhandled", error);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });
  app.route("/api/lab", labApi);
  app.route("/api/lab", draftApi);
  app.get("/", async (c) => c.html(await readPage()));
  app.get("/lab", async (c) => c.html(await readPage()));

  /**
   * Every file the page actually fetches must be listed here, or it 404s and
   * the page silently loses a feature. `index.html` loads `app.js` as a module
   * (it uses top-level await); `app.js` imports `render.js`, which is what
   * turns a spec into DOM. Leaving any of these out is not a cosmetic gap.
   */
  const assets = new Set([
    "/lab/index.html",
    "/lab/app.js",
    "/lab/render.js",
    "/lab/shared.css",
    "/lab/tokens.css",
    "/lab/lab.css",
  ]);
  app.get("/lab/*", (c) => assets.has(c.req.path) ? serveAsset(c.req.path) : c.notFound());
  return app;
}
