import { Hono } from "npm:hono@4.13.12";
import { type Field, matterRef, starterPlans, systemPrompt } from "../lab/model.ts";
import { CATALOG_REFERENCE, EXAMPLE_SPEC } from "./catalog.ts";
import { DIRECTIVE_REFERENCE } from "../lab/bindings.ts";
import { draftPlan, EXAMPLE_PROMPTS, inventRequest, PRACTICES, pickPrompt } from "./generate.ts";
import { readJsonBody } from "./http_util.ts";

export const draftApi = new Hono();

/** The prompt actually sent — the same text the model receives. */
export const PROMPT = systemPrompt(PRACTICES, {
  components: CATALOG_REFERENCE,
  directives: DIRECTIVE_REFERENCE,
});

/** Everything the browser needs to render the empty state truthfully. */
draftApi.get("/meta", (c) =>
  c.json({
    practices: PRACTICES,
    examples: EXAMPLE_PROMPTS,
    starterPlans,
    prompt: PROMPT,
    model: "gpt-5.6-luna",
    limits: { proxyPerDay: 100 },
    view: { components: CATALOG_REFERENCE.split("\n").length, example: EXAMPLE_SPEC },
  }));

/**
 * One invented request, for the "random request" button. Small and separate
 * from /draft: it returns prose only, never a plan.
 */
draftApi.post("/random", async (c) => {
  const body = await readJsonBody<{ seen?: string[] }>(c);
  const seen = Array.isArray(body?.seen) ? body!.seen.slice(-6) : [];
  const invented = await inventRequest(seen);
  return c.json(invented);
});

/**
 * The starting answers a generated plan implies: defaults from the schema, the
 * already-known facts, and the pre-extracted candidates left unticked. This is
 * what turns a 40-field intake into a handful of confirmations.
 *
 * It also guarantees the invariant the demo depends on: **every required field
 * opens with a value**. A required field the model forgot to default gets a
 * sensible seed from its own type, so the form opens valid instead of opening
 * with a silent red error.
 */
export function prefilledContent(plan: { requestedSchema: { required?: string[]; properties: Record<string, Field> } }): {
  content: Record<string, unknown>;
  fromFacts: string[];
  suggestions: Record<string, string[]>;
  /** Required fields that had to be seeded because the model gave no default. */
  seeded: string[];
} {
  const content: Record<string, unknown> = {};
  const suggestions: Record<string, string[]> = {};
  const fromFacts: string[] = [];
  const seeded: string[] = [];

  for (const [key, field] of Object.entries(plan.requestedSchema.properties)) {
    if (field.options?.length) suggestions[key] = [...field.options];
    if (field.default !== undefined) {
      content[key] = Array.isArray(field.default) ? [...field.default] : field.default;
      fromFacts.push(key);
    } else if (field.options?.length) {
      content[key] = [];
    }
  }

  for (const key of plan.requestedSchema.required ?? []) {
    if (content[key] !== undefined) continue;
    const field = plan.requestedSchema.properties[key];
    if (!field) continue;
    const seed = seedValue(field);
    if (seed === undefined) continue;
    content[key] = seed;
    fromFacts.push(key);
    seeded.push(key);
  }

  return { content, fromFacts, suggestions, seeded };
}

/** The least-surprising valid value for an unanswered field. */
function seedValue(field: Field): unknown {
  if (field.options?.length) return [field.options[0]];
  if (field.enum?.length) return field.enum[0];
  if (field.type === "boolean") return false;
  if (field.type === "number" || field.type === "integer") return field.minimum ?? 0;
  if (field.format === "date") return new Date().toISOString().slice(0, 10);
  if (field.format === "email") return "applicant@example.org";
  if (field.format === "uri") return "https://example.org";
  return field.minLength ? "x".repeat(field.minLength) : "To be confirmed";
}

draftApi.post("/draft", async (c) => {
  const body = await readJsonBody<{ prompt?: string; practiceId?: string; seen?: string[] }>(c);
  if (body === null) return c.json({ error: "invalid JSON body" }, 400);
  const prompt = (body.prompt ?? "").toString().trim();
  if (prompt.length < 4) return c.json({ error: "Describe the request in at least a few words." }, 400);
  if (prompt.length > 600) return c.json({ error: "Keep the prompt under 600 characters." }, 400);

  const result = await draftPlan(prompt, body.practiceId || undefined);
  if (result.source === "error") {
    const fallback = starterPlans[Math.floor(Math.random() * starterPlans.length)];
    return c.json({
      error: result.error,
      hint: result.hint,
      transcript: result.transcript,
      // A hand-written plan keeps the demo usable when the proxy is down.
      fallback: { plan: fallback, draft: prefilledContent(fallback) },
    }, 502);
  }

  const plan = result.plan;
  const ref = matterRef(plan, prompt.length * 37 + plan.departmentCode.charCodeAt(0));
  return c.json({
    plan: { ...plan, matterRef: ref },
    draft: prefilledContent(plan),
    meta: { model: result.model, ms: result.ms, tokens: result.tokens },
    transcript: result.transcript,
    nextExample: pickPrompt(Array.isArray(body.seen) ? body.seen : [prompt]),
  });
});
