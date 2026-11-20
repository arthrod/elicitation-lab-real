/**
 * Common-server entry point (Node). Val Town uses main.http.ts instead; this
 * file is excluded from the val sync via .vtignore.
 *
 *   npm install
 *   OPENAI_API_KEY=sk-... npm start     # PORT env var, default 8000
 *
 * Serves the same Hono app as the val, with static files read from disk
 * instead of Val Town's readFile/serveFile.
 */
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApp } from "./backend/app.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const readPage = () => readFile(`${root}lab/index.html`, "utf8");

// app.ts only forwards whitelisted /lab/* asset paths here.
const serveAsset = async (path: string): Promise<Response> => {
  const rel = path.replace(/^\/+/, "");
  const body = await readFile(`${root}${rel}`);
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(body, {
    headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
  });
};

const app = createApp(readPage, serveAsset);

const port = Number(process.env.PORT ?? 8000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Elicitation Lab listening on http://localhost:${info.port}`);
});
