/**
 * Shadow-render check.
 *
 * The real renderer touches the DOM, which this runtime doesn't have. So this
 * reproduces its *decisions* — which renderer each element dispatches to, and
 * what each binding resolves to — using the same server-side modules. If a
 * component type has no renderer, or a binding yields nothing, it shows here
 * rather than as a blank panel in the browser.
 */
import { draftPlan, EXAMPLE_PROMPTS } from "../backend/generate.ts";
import { prefilledContent } from "../backend/draft.ts";
import { readBinding } from "../lab/bindings.ts";

const RENDERED = new Set([
  "Card", "Stack", "Grid", "Separator", "Heading", "Text", "Badge",
  "Alert", "Progress", "Table", "Spinner", "Metric", "KeyValue",
]);

let failures = 0;

for (const example of EXAMPLE_PROMPTS) {
  const result = await draftPlan(example.prompt, example.practiceId);
  if (result.source === "error") {
    console.error(`✗ ${example.tag}: model error — ${result.error}`);
    failures++;
    continue;
  }
  const plan = result.plan;
  const answers = prefilledContent(plan).content as Record<string, unknown>;

  if (!plan.view) {
    console.log(`· ${example.tag}: no view (form only)`);
    continue;
  }

  const spec = plan.view.spec as {
    root: string;
    elements: Record<string, { type: string; children?: string[]; valueFrom?: { field: string } }>;
  };
  const seen = new Set<string>();
  const noRenderer = new Set<string>();
  const emptyBindings: string[] = [];

  const walk = (id: string, depth: number) => {
    if (depth > 8 || seen.has(id)) return;
    const node = spec.elements[id];
    if (!node) return;
    seen.add(id);
    if (!RENDERED.has(node.type)) noRenderer.add(`${node.type}(${id})`);
    if (node.valueFrom) {
      const r = readBinding(node.valueFrom as never, answers);
      if (r.value === undefined) emptyBindings.push(`${id}←${node.valueFrom.field}`);
    }
    (node.children ?? []).forEach((c) => walk(c, depth + 1));
  };
  walk(spec.root, 0);

  const unreachable = Object.keys(spec.elements).filter((id) => !seen.has(id));
  const ok = !noRenderer.size && !emptyBindings.length;

  console.log(
    `${ok ? "✓" : "✗"} ${example.tag}: ${seen.size}/${Object.keys(spec.elements).length} elements drawn` +
      (noRenderer.size ? ` | NO RENDERER: ${[...noRenderer].join(",")}` : "") +
      (emptyBindings.length ? ` | empty: ${emptyBindings.join(",")}` : "") +
      (unreachable.length ? ` | unreachable: ${unreachable.join(",")}` : ""),
  );
  if (!ok) failures++;
}

console.log(failures ? `\n${failures} problem(s)` : "\nall views render");
