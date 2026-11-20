/**
 * The json-render catalog for this lab.
 *
 * json-render turns a JSON UI *tree* into components. We use it for the thing a
 * flat elicitation schema genuinely cannot express: the object the model builds
 * from the answers (a dashboard, a scorecard, a one-pager).
 *
 * The form itself stays a real MCP `requestedSchema` — that is the point of the
 * demo — but the readout is a json-render spec, validated against this catalog
 * and compiled by `@json-render/core` in the browser (see lab/render.js).
 *
 * Component definitions come straight from `@json-render/shadcn/catalog`, so the
 * names and props are shadcn's, not ours. Only `Metric` and `KeyValue` are local
 * additions, declared the way the skill documents extending a catalog.
 * Implementations are drawn in this page's design system (no Tailwind build).
 */
import { autoFixSpec, defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";

const shadcn = shadcnComponentDefinitions as Record<string, { props: z.ZodType; description?: string }>;

// --- local extensions, same shape as the shadcn entries ----------------------
const Metric = {
  props: z.object({
    label: z.string(),
    value: z.string(),
    hint: z.string().nullable(),
    emphasis: z.boolean().nullable(),
  }),
  description: "KPI tile: one big number or short value. emphasis=true paints it highlighter yellow.",
};

const KeyValue = {
  props: z.object({ rows: z.array(z.object({ label: z.string(), value: z.string() })) }),
  description: "Definition list of label/value pairs, for answered facts.",
};

const EXTENSIONS = { Metric, KeyValue } as const;

/** The exact slice of shadcn we use — picked explicitly, never spread whole. */
export const PICKED = [
  "Card", "Stack", "Grid", "Separator", "Heading", "Text", "Badge",
  "Alert", "Progress", "Table", "Spinner",
] as const;

const missing = PICKED.filter((name) => !shadcn[name]);
if (missing.length) throw new Error(`shadcn catalog is missing: ${missing.join(", ")}`);

export const componentDefinitions = {
  ...Object.fromEntries(PICKED.map((name) => [name, shadcn[name]])),
  ...EXTENSIONS,
} as Record<string, { props: z.ZodType; description?: string }>;

export const ELEMENT_TYPES = Object.keys(componentDefinitions);
export const ALLOWED = new Set(ELEMENT_TYPES);

export const catalog = defineCatalog(schema, { components: componentDefinitions, actions: {} });

export type JsonElement = {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
  /** Live binding to a form answer: `field` is the answer key. */
  valueFrom?: { field: string };
};
export type JsonSpec = { root: string; elements: Record<string, JsonElement>; state?: Record<string, unknown> };

/**
 * Validate against the catalog, then repair. json-render ships the repair we
 * want (`autoFixSpec`) and reports what it changed, so a dangling child costs a
 * note in the UI rather than a blank panel.
 */
export function validateSpec(
  raw: unknown,
): { ok: true; spec: JsonSpec; notes: string[] } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "spec is not an object" };
  const data = raw as Record<string, unknown>;
  if (!data.elements || typeof data.elements !== "object") return { ok: false, reason: "spec.elements missing" };
  if (typeof data.root !== "string" || !(data.elements as Record<string, unknown>)[data.root]) {
    return { ok: false, reason: "spec.root does not name an element" };
  }

  // Drop unknown component types first: autoFixSpec only checks references.
  const elements: Record<string, JsonElement> = {};
  const notes: string[] = [];
  for (const [id, node] of Object.entries(data.elements as Record<string, JsonElement>)) {
    if (!node || typeof node !== "object") continue;
    if (!ALLOWED.has(node.type)) {
      notes.push(`dropped unknown component ${JSON.stringify(node.type)}`);
      continue;
    }
    const binding = node.valueFrom;
    elements[id] = {
      type: node.type,
      props: node.props && typeof node.props === "object" ? node.props : {},
      children: Array.isArray(node.children) ? node.children.filter((c) => typeof c === "string") : [],
      ...(binding && typeof binding.field === "string" ? { valueFrom: { field: binding.field } } : {}),
    };
  }
  if (!elements[data.root as string]) return { ok: false, reason: "root element used an unknown component" };

  // json-render's own repair pass: removes child refs that point nowhere and
  // reports each fix, so a dangling id costs a note rather than a blank panel.
  const repaired = autoFixSpec({ root: data.root, elements } as never) as {
    spec: { root: string; elements: Record<string, JsonElement> };
    fixes: string[];
  };
  notes.push(...repaired.fixes);
  const finalSpec = repaired.spec;

  if (!finalSpec.elements[finalSpec.root]) return { ok: false, reason: "root element did not survive repair" };
  const checked = catalog.validate(finalSpec as never);
  if (!checked.success) return { ok: false, reason: checked.error?.issues?.[0]?.message ?? "catalog validation failed" };

  return { ok: true, spec: { root: finalSpec.root, elements: finalSpec.elements }, notes };
}

/** Render a Zod prop schema as a short signature: `text: string`, `gap?: sm|md|lg`. */
function describeProp(schema: z.ZodType): string {
  type Def = { type?: string; innerType?: Def; element?: Def; shape?: Record<string, z.ZodType>; values?: string[]; entries?: Record<string, string> };
  const def = (schema as unknown as { _def?: Def; def?: Def })._def ?? (schema as unknown as { def?: Def }).def;
  if (!def) return "any";
  switch (def.type) {
    case "nullable": {
      const inner = def.innerType ? describeProp(def.innerType as unknown as z.ZodType) : "any";
      return inner;
    }
    case "enum":
      return Object.keys(def.entries ?? {}).join("|");
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const inner = def.element ? describeProp(def.element as unknown as z.ZodType) : "any";
      return `${inner}[]`;
    }
    case "object": {
      const shape = def.shape ?? {};
      return `{ ${Object.entries(shape).map(([k, v]) => `${k}: ${describeProp(v)}`).join("; ")} }`;
    }
    default:
      return "any";
  }
}

/** The declared props of a component, as `name: type`. */
export function propSignature(def: { props: z.ZodType }): string {
  const shape = ((def.props as unknown as { _def?: { shape: Record<string, z.ZodType> }; def?: { shape: Record<string, z.ZodType> } })
    ._def ?? (def.props as unknown as { def?: { shape: Record<string, z.ZodType> } }).def)?.shape;
  if (!shape) return "";
  return Object.entries(shape).map(([key, schema]) => `${key}: ${describeProp(schema)}`).join("; ");
}

/**
 * Component list for the prompt, with each component's *actual* prop names.
 * Without this the model invents `label`/`severity`/`trend` and the renderer
 * draws empty boxes — the single biggest source of broken views.
 */
export const CATALOG_REFERENCE = Object.entries(componentDefinitions)
  .map(([name, def]) => `- ${name} { ${propSignature(def)} } — ${def.description ?? ""}`)
  .join("\n");

export const SPEC_SHAPE = `{
  "root": "<element id>",
  "elements": {
    "<id>": { "type": "<one of the components>", "props": { ... }, "children": ["<id>"], "valueFrom": { "field": "<answer key>" } }
  }
}`;

export const EXAMPLE_SPEC = {
  root: "root",
  elements: {
    root: {
      type: "Card",
      props: { title: "Housing case at a glance", description: "Built from the answers — nobody designed this screen in advance." },
      children: ["metrics", "sep", "pressure", "risk"],
    },
    metrics: { type: "Grid", props: { columns: 3, gap: "md" }, children: ["m-date", "m-issue", "m-kids"] },
    "m-date": { type: "Metric", props: { label: "Hearing", value: "—", hint: "until the hearing", emphasis: true }, children: [], valueFrom: { field: "hearing_date" } },
    "m-issue": { type: "Metric", props: { label: "Issue", value: "—", hint: null, emphasis: null }, children: [], valueFrom: { field: "legal_issue" } },
    "m-kids": { type: "Metric", props: { label: "Children", value: "—", hint: null, emphasis: null }, children: [], valueFrom: { field: "children_count" } },
    sep: { type: "Separator", props: { orientation: "horizontal" }, children: [] },
    pressure: { type: "Progress", props: { value: 70, max: 100, label: "Deadline pressure" }, children: [] },
    risk: { type: "Alert", props: { title: "Hearing inside two weeks", message: "A volunteer must be assigned this week.", type: "warning" }, children: [] },
  },
};
