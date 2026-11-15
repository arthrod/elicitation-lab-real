/**
 * One-off: generate views with the real model, validate them, and write the
 * result to lab/seeds.json so the View tab always has something real to show
 * even if the drafting proxy is down or quota-limited.
 *
 * Run with `run_file`. Re-run whenever the catalog or prompt changes.
 */
import { draftPlan, EXAMPLE_PROMPTS } from "../backend/generate.ts";
import { prefilledContent } from "../backend/draft.ts";
import { readBinding } from "../lab/bindings.ts";

const seeds: Record<string, unknown> = {};

for (const example of EXAMPLE_PROMPTS) {
  const result = await draftPlan(example.prompt, example.hospitalId);
  if (result.source === "error") {
    console.error("skip", example.tag, "→", result.error);
    continue;
  }
  const { plan } = result;
  const draft = prefilledContent(plan);
  const answers = draft.content;

  console.log(
    `\n${example.tag}: view=${plan.view ? plan.view.kind : "none"}` +
      ` | required seeded=${draft.seeded.length ? draft.seeded.join(",") : "none"}` +
      (plan.view?.notes?.length ? ` | notes=${plan.view.notes.length}` : ""),
  );

  // Prove the directives resolve against real answers.
  if (plan.view) {
    const spec = plan.view.spec as {
      elements: Record<string, { valueFrom?: { field: string; directive?: Record<string, unknown> } }>;
    };
    for (const [id, node] of Object.entries(spec.elements ?? {})) {
      if (!node.valueFrom) continue;
      const resolved = readBinding(node.valueFrom, answers as Record<string, unknown>);
      console.log(
        `  ${id} ← ${node.valueFrom.field}` +
          `${node.valueFrom.directive ? " (computed)" : ""} = ${JSON.stringify(resolved.value)}` +
          `${resolved.missing ? " [missing]" : ""}`,
      );
    }
  }

  seeds[example.tag] = { plan, draft };
}

// No filesystem writes in this runtime: print the JSON so it can be pasted
// into lab/seeds.json in one go.
console.log(`\n--- seeds.json (${Object.keys(seeds).length} entries) ---`);
console.log(JSON.stringify(seeds));
