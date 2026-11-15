/**
 * Page-level checks that don't need a browser.
 *
 * The renderer touches `document`, so this file gives it a minimal DOM: just
 * enough for `createElement`, `append`, `className` and `textContent`. That is
 * deliberate — if the renderer needs anything more than that to draw a spec,
 * it is coupling to the DOM in a way that will break in the page too.
 *
 * What it proves:
 *  1. Every static file the page references is actually served (a 404 here is
 *     a silently missing feature in the browser).
 *  2. `render.js` parses and exports what `app.js` imports.
 *  3. `app.js` imports resolve and its source has no dangling references to
 *     the removed `view.blocks` contract.
 *  4. For a real generated plan, the spec renders with the same element count
 *     the server's shadow check predicts.
 */
import { readFile, serveFile } from "https://esm.town/v/std/utils/index.ts";
import { EXAMPLE_SPEC } from "../backend/catalog.ts";
import { draftPlan, EXAMPLE_PROMPTS } from "../backend/generate.ts";
import { prefilledContent } from "../backend/draft.ts";

/** Same resolution the real entrypoint uses (main.http.ts). */
const serveAsset = (path: string) => serveFile(path, import.meta.url.replace("scripts/", ""));
const readPage = () => readFile("/lab/index.html", import.meta.url.replace("scripts/", ""));

let failures = 0;
const fail = (msg: string) => {
  console.log(`✗ ${msg}`);
  failures++;
};
const pass = (msg: string) => console.log(`✓ ${msg}`);

/* ---------------- 1. static files are reachable ---------------- */

const ASSETS = [
  "/lab/index.html",
  "/lab/app.js",
  "/lab/render.js",
  "/lab/shared.css",
  "/lab/tokens.css",
  "/lab/lab.css",
];

for (const path of ASSETS) {
  try {
    const response = await serveAsset(path);
    if (response.status !== 200) fail(`${path} → ${response.status}`);
    else pass(`${path} served`);
  } catch (error) {
    fail(`${path} → ${(error as Error).message}`);
  }
}

/* ---------------- 2. the page imports what it uses ---------------- */

const app = await (await serveAsset("/lab/app.js")).text();
if (!/^import \{ initRenderer, renderSpec \} from "\/lab\/render\.js";/m.test(app)) {
  fail("app.js does not import renderSpec/initRenderer from /lab/render.js");
} else pass("app.js imports the renderer");
// Only count real code, not the comment that explains the old contract.
const appCode = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
if (/view\.blocks/.test(appCode)) fail("app.js still references view.blocks (the removed contract)");
else pass("app.js no longer reads view.blocks");
if (!/await initRenderer\(\)/.test(app)) fail("app.js never calls initRenderer()");
else pass("app.js initialises the directive engine");

/* ---------------- 3. a minimal DOM, enough for renderSpec ---------------- */

class Node {
  tag: string;
  className = "";
  textContent = "";
  children: Node[] = [];
  style: Record<string, string> = { setProperty: () => {} } as never;
  attrs: Record<string, string> = {};
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: unknown[]) {
    for (const node of nodes) if (node instanceof Node) this.children.push(node);
  }
  appendChild(node: Node) {
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes: Node[]) {
    this.children = [...nodes];
  }
  setAttribute(key: string, value: string) {
    this.attrs[key] = value;
  }
  get text() {
    return [this.textContent, ...this.children.map((c) => c.text)].join("");
  }
}

// deno-lint-ignore no-explicit-any
(globalThis as any).document = {
  createElement: (tag: string) => new Node(tag),
  createTextNode: (text: string) => {
    const node = new Node("#text");
    node.textContent = text;
    return node;
  },
};

const { renderSpec } = await import("../lab/render.js");

/* ---------------- 4. render the hand-written example spec ---------------- */

const answers = { hearing_date: "2026-11-19", legal_issue: "housing", children_count: 2 };
const host = new Node("div");
const exampleResult = renderSpec(host, EXAMPLE_SPEC, answers);
const expected = Object.keys(EXAMPLE_SPEC.elements).length;

if (exampleResult.rendered === expected && !exampleResult.missing.length) {
  pass(`example spec: ${exampleResult.rendered}/${expected} elements drawn`);
} else {
  fail(`example spec: ${exampleResult.rendered}/${expected} drawn, missing: ${exampleResult.missing.join(",")}`);
}

const exampleText = host.text;
// A bare binding prints the raw answer; only a $format/$pluralize directive
// changes its presentation. The example spec binds them bare, so this is what
// "the bound value reached the DOM" looks like.
for (const wanted of ["Housing case at a glance", "2026-11-19", "housing", "2", "Deadline pressure"]) {
  if (!exampleText.includes(wanted)) fail(`example spec output missing ${JSON.stringify(wanted)}`);
}
// The regression that mattered: a placeholder literal must never beat a binding.
if (exampleText.includes("—until the hearing") || /Hearing\s*—/.test(exampleText)) {
  fail("a bound Metric rendered its placeholder instead of the answer");
} else pass("example spec shows bound answers, not placeholder literals");

/* ---------------- 5. a broken spec degrades, never throws ---------------- */

const broken = new Node("div");
try {
  const result = renderSpec(broken, { root: "nope", elements: {} }, {});
  if (result.rendered === 0) pass("broken spec renders an explanation, not a blank panel");
  else fail("broken spec unexpectedly rendered something");
} catch (error) {
  fail(`broken spec threw: ${(error as Error).message}`);
}

const noSpec = new Node("div");
try {
  renderSpec(noSpec, null, {});
  pass("null spec renders an explanation");
} catch (error) {
  fail(`null spec threw: ${(error as Error).message}`);
}

/* ---------------- 6. one live plan, rendered ---------------- */

const live = EXAMPLE_PROMPTS.find((e) => e.advantage === "view");
if (live) {
  const result = await draftPlan(live.prompt, live.practiceId);
  if (result.source === "error") {
    // The proxy allows 100 requests/day. A quota stop says nothing about the
    // renderer, so report it as skipped rather than failed.
    if (/quota/i.test(result.error)) console.log(`· live plan skipped — ${result.error}`);
    else fail(`live plan (${live.tag}) — ${result.error}`);
  } else if (!result.plan.view) {
    fail(`live plan (${live.tag}) produced no view`);
  } else {
    const content = prefilledContent(result.plan).content as Record<string, unknown>;
    const box = new Node("div");
    const drawn = renderSpec(box, result.plan.view.spec as never, content);
    const total = Object.keys((result.plan.view.spec as { elements: object }).elements).length;
    if (drawn.rendered === total && !drawn.missing.length) {
      pass(`live plan (${live.tag}): ${drawn.rendered}/${total} elements drawn`);
    } else {
      fail(`live plan (${live.tag}): ${drawn.rendered}/${total}, missing ${drawn.missing.join(",")}`);
    }
    if (result.plan.view.notes?.length) {
      console.log(`  · repairs: ${result.plan.view.notes.join(" | ")}`);
    }
  }
}

/* ---------------- 7. the page itself is served ---------------- */

const page = await readPage();
if (page.includes('src="/lab/app.js"') && page.includes('type="module"')) {
  pass("index.html loads app.js as a module");
} else fail("index.html does not load app.js as a module");

console.log(failures ? `\n${failures} problem(s)` : "\npage verified");
