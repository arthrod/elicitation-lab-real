/** The elicitation contract: one schema, one validator, shared by server and browser. */
import { validateSpec } from "../backend/catalog.ts";
import { checkSpec } from "../backend/props.ts";

export type FieldType = "string" | "boolean" | "number" | "integer";
export type Field = {
  type: FieldType;
  title: string;
  description?: string;
  enum?: (string | number)[];
  enumNames?: string[];
  minimum?: number;
  maximum?: number;
  /** MCP allows: email, uri, date, date-time. */
  format?: string;
  minLength?: number;
  maxLength?: number;
  default?: string | number | boolean;
  /**
   * MCP-only UI hint, read from `_meta.ui.control` the way VS Code reads
   * `_meta.ui`. It never changes validation — only which widget renders.
   */
  control?: "textarea" | "select" | "radio" | "chips" | "switch" | "segmented" | "date" | "slider" | "stepper" | "number" | "checkboxes";
  /** Where the answer comes from when it is pre-filled and shouldn't be retyped. */
  source?: string;
  /** Unticked suggestions — candidate facts, offered as checkboxes. Never free text. */
  options?: string[];
};
export type Section = { title: string; fields: string[] };

export type ChecklistItem = {
  id: string;
  label: string;
  detail?: string;
  requires?: string;
  when?: Record<string, (string | number | boolean)[]>;
};

/** A live binding from a form answer into a json-render prop. */
export type ViewBinding = {
  /** Answer key this element reads. */
  field: string;
  /** Optional json-render directive, applied with the answer injected as `$this`. */
  directive?: Record<string, unknown>;
};

/**
 * A "view" is a second render of the same answers. Elicitation schemas are
 * flat JSON — a dashboard is a presentation choice the server makes *after*
 * the facts arrive, which is exactly what a server can do and a static form
 * cannot. The renderer is json-render, so a view is a json-render spec.
 */
export type PlanView = {
  /** json-render spec `{ root, elements }`; catalog-validated before it ships. */
  spec: unknown;
  /** Which treatment the model intended. */
  kind: "dashboard" | "summary" | "scorecard" | "timeline";
  title: string;
  /** Repairs applied by validation (dropped components, dangling children). */
  notes?: string[];
};

export type CaseFacts = {
  headline: string;
  source: string;
  /** Ticked by default — they are already known. */
  known: { label: string; field?: string }[];
  /** Left unticked — the questions this form exists to ask. */
  gaps: { label: string; why?: string }[];
};

export type Plan = {
  id: string;
  title: string;
  message: string;
  department: string;
  specialty: string;
  departmentCode: string;
  practice?: { id: string; name: string; city: string; focus?: string } | null;
  tags: string[];
  priority?: "routine" | "urgent" | "emergent";
  /** What the person actually asked for, verbatim-ish. */
  request?: string;
  /** Shown above the fields: "we could not know these in advance". */
  novel?: string;
  fieldsUnknownExAnte?: boolean;
  requiresView?: boolean;
  caseFacts?: CaseFacts;
  view?: PlanView;
  sections?: Section[];
  checklist: ChecklistItem[];
  requestedSchema: {
    type: "object";
    required: string[];
    properties: Record<string, Field>;
  };
};

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "plan";

const CODES: Record<string, string> = {
  cardiology: "CARD", radiology: "RAD", oncology: "ONC", neurology: "NEU",
  pediatrics: "PED", "emergency medicine": "EMER", "internal medicine": "IM",
  surgery: "SURG", orthopedics: "ORTH", pathology: "PATH", anesthesiology: "ANES",
  psychiatry: "PSYC", obstetrics: "OBGY", gynecology: "GYN", dermatology: "DERM",
  ophthalmology: "OPHT", urology: "UROL", gastroenterology: "GAST", pulmonology: "PULM",
  endocrinology: "ENDO", nephrology: "NEPH", hematology: "HEMA", rheumatology: "RHEU",
  "primary care": "PRIM", pharmacy: "PHAR", legal: "LEGAL", "pro bono": "PROB",
  immigration: "IMM", housing: "HOUS", "family law": "FAM", employment: "EMPL",
  "civil rights": "CIV", "public benefits": "BEN", "criminal defense": "CRIM",
};

export function departmentCode(department: string): string {
  const key = department.trim().toLowerCase();
  if (CODES[key]) return CODES[key];
  const words = key.split(/[\s-]+/).filter(Boolean);
  if (!words.length) return "GENX";
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase().padEnd(4, "X");
  return words.map((w) => w[0]).join("").toUpperCase().slice(0, 4).padEnd(4, "X");
}

export function matterRef(plan: Pick<Plan, "departmentCode">, seed: number): string {
  return `${plan.departmentCode}-${1000 + (Math.abs(seed) % 9000)}`;
}

export type Chat = { role: "system" | "user"; content: string };

export const CONTROLS = [
  "textarea", "select", "radio", "chips", "switch",
  "segmented", "date", "slider", "stepper", "number", "checkboxes",
] as const;
export const FORMATS = ["email", "uri", "date", "date-time"];

/** Prompt shown to the browser so the "under the hood" panel is never a lie. */
export function systemPrompt(
  practices: { id: string; name: string; city: string; focus?: string }[],
  viewCatalog?: { components: string; directives: string },
): string {
  return `You turn a person's free-text request into an MCP elicitation/create request for a legal
services organisation.

The whole point: NOBODY KNOWS THE FIELDS IN ADVANCE. The person writing the request often does not
know the legal name for their problem and does not know how forms work. Invent the questions this
specific request needs — you are not filling in a template.

Return one JSON object:
{
  "title": string,                 // imperative, <= 8 words
  "message": string,               // 1-2 sentences the person reads
  "department": string,            // e.g. "Housing", "Benefits", "Employment"
  "specialty": string,             // narrower than department
  "priority": "routine" | "urgent" | "emergent",
  "tags": string[],                // 2-4 lowercase
  "practiceId": string | null,     // only an id from the known practices
  "requiresView": boolean,         // true when the user asked for anything other than a plain form
  "novel": string,                 // one sentence: what is unusual about this form and why it could not be pre-built
  "caseFacts": {                   // only when the request contains facts about a real matter
    "headline": string,
    "source": string,              // where the facts came from
    "known": [{ "label": string, "field": string }],   // already answered — pre-filled, ticked
    "gaps":  [{ "label": string, "why": string }]      // the open questions
  } | null,
  "view": {                        // a rendered object, when requiresView is true
    "kind": "dashboard" | "summary" | "scorecard" | "timeline",
    "title": string,
    "spec": {                      // json-render spec
      "root": "<element id>",
      "elements": {
        "<id>": { "type": "<component>", "props": {}, "children": ["<id>"],
                  "valueFrom": { "field": "<answer key>", "directive": { "<$directive>": null } } }
      }
    }
  } | null,
  "sections": [{ "title": string, "fields": string[] }],
  "fields": {
    "<key>": {
      "type": "string" | "boolean" | "number" | "integer",
      "title": string,
      "description": string,
      "enum": string[], "enumNames": string[],
      "minimum": number, "maximum": number,
      "format": "email" | "uri" | "date" | "date-time",
      "minLength": number, "maxLength": number,
      "default": string | number | boolean,
      "control": "textarea" | "select" | "radio" | "chips" | "switch" | "segmented" | "date" | "slider" | "stepper" | "number",
      "source": string,            // e.g. "from the intake letter" when the value is pre-filled
      "options": string[]          // unticked suggestions the person can tick
    }
  },
  "required": string[],
  "checklist": [{ "id": string, "label": string, "detail": string,
                  "requires": string, "when": { "<field>": [values] } }]
}

Widget rules — pick deliberately, never default to a text box:
- 3-8 distinct option strings -> control "chips". 9+ options -> "select".
- "radio" for mutually exclusive choices with consequences, "segmented" for 2-4 short ones.
- "switch" for booleans.
- "date" (+ format "date") for any deadline, hearing or filing date.
- "slider" with minimum/maximum for a score or percentage; "stepper" for small counts.
- "textarea" only for prose the person must actually write, and keep it short.
- "options" for places where the intake already gives candidate facts: the person ticks, never types.
- "source" on every field whose value comes from the request text.
- If a field has "options", its "default" (if any) MUST be a LIST drawn from those options,
  never a bare scalar — the answer is a set of ticked options.

The form must be LESS intense, not more:
- Hard cap: 7 fields. Prefer 4-5. A pro bono or "other" intake should be 5 or fewer.
- Put a "default" on EVERY field you can possibly answer from the request text
  (urgency, language, issue area, court-date status, risk, hours). A form that
  opens pre-filled is the whole point of the demo; a blank form is a failure.
- Dates ("format": "date") MUST be ISO YYYY-MM-DD strings in "default" — never prose.
- Only mark a field required when the answer truly blocks progress. A required field
  with no default is correct when the person genuinely did not say — the form will ask.
- For "other"/unstructured matters: caseFacts.known lists every fact already
  stated (each mapped to a field), and the fields only ask what is genuinely missing.
- If the request contains something that cannot be true (a meeting after the last day of work
  presented as a written warning, a hearing date in the past for a future hearing), say so once in
  "novel" and make the form ask the person to confirm the correct order. Do not silently copy it.

Rules for "view": produce it whenever the request is not "give me a form" — a dashboard, a
one-pager, a scorecard, a triage list, or asking for steps someone missed. The view is a
json-render spec rendered by real components; it is NOT a form and it must not re-ask anything
the fields already collect. Instead it READS them through bindings.

Component catalog — use ONLY these types, and ONLY the props listed (they are the real contract;
inventing a prop name such as "label" on Heading or "trend" on Metric produces an empty box):
${viewCatalog?.components ?? "(components unavailable)"}

Binding — how a view reads an answer. Every element may carry "valueFrom":
  { "field": "<answer key>" }                                    // raw value
  { "field": "<answer key>", "directive": { "$pluralize": 2, "one": "child", "other": "children" } }
Inside a directive, "$this" means the answer, so a derived number is:
  { "$math": "subtract", "a": 10, "b": { "$this": true } }

Directives available (wire format shown exactly):
${viewCatalog?.directives ?? "(directives unavailable)"}

Binding rules — a wrong binding is worse than no binding:
- A field with "options" (ticked list) is a SET. Never bind it bare into a Metric
  or Text; it renders as an array. Use { "$join": { "$this": true }, "separator": " · " }
  or { "$count": { "$this": true } }.
- Only bind a field to a prop of a compatible shape: number/score → Progress/Bar,
  short text → Metric value or Text, set → Tags or a $join.
- Do NOT bind a field with "options" (like a risk dropdown) to a Metric "value" —
  put the chosen option in Text/Badge via $join.
- Metric.value and Modal props are strings. A number must be wrapped: { "$format": "number", "value": ... }.

Spec rules:
- root must be a "Card" (a view) or "Stack" (a single-column report).
- Every id in a "children" array must exist in "elements". Leaf elements use "children": [].
- 6-16 elements. 2-4 Metric elements when there are numbers to show.
- Prefer a computed Metric ("hint" explains the calculation) over restating a field.
- Never invent answer keys; only reference keys you also declared in "fields".

Other rules:
- Every field key appears in exactly one section.
- Checklist items are 2-5 real gates, not decoration.
- Never request sensitive identifiers (SSN, full date of birth with name, medical records, case numbers you were not given).
- This is a demo with fictional data. Never give legal advice; ask for facts instead.
- Known practices — use the exact id in practiceId:
${JSON.stringify(practices)}.`;
}

const BLOCKED = [
  "does not exist", "not in the known list", "apologize", "apology", "rickroll",
  "ignore previous", "as an ai", "cannot help", "i'm sorry",
];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Coerce a model-supplied date into ISO YYYY-MM-DD, or give up and drop it. */
function isoDate(value: unknown): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Normalise the model's `valueFrom` into a `ViewBinding`, resolving the two
 * shapes models produce: `{ path }` and `{ field }`.
 */
function cleanBinding(raw: unknown, keys: Set<string>): ViewBinding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, any>;
  const field = cleanText(b.field) || cleanText(b.path);
  if (!field || !keys.has(field)) return undefined;
  const out: ViewBinding = { field };
  if (b.directive && typeof b.directive === "object" && !Array.isArray(b.directive)) {
    out.directive = b.directive as Record<string, unknown>;
  }
  return out;
}

/**
 * Normalise whatever the model returned into a valid, renderable Plan.
 * The model is schema-constrained, but this keeps a bad generation from
 * producing a broken dialog: unknown keys, dangling references and
 * prompt-injection-shaped text are repaired or dropped here.
 */
export function normalizePlan(raw: unknown, prompt: string): Plan {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const schemaProps = data.requestedSchema && typeof data.requestedSchema === "object"
    ? (data.requestedSchema as Record<string, unknown>).properties
    : undefined;
  const fields = (
    schemaProps && typeof schemaProps === "object"
      ? schemaProps
      : (data.fields && typeof data.fields === "object" ? data.fields : {})
  ) as Record<string, Field>;

  const properties: Record<string, Field> = {};
  for (const [key, value] of Object.entries(fields)) {
    const field = value as Field;
    if (!field || typeof field !== "object") continue;
    const clean: Field = {
      type: oneOf(field.type, ["string", "boolean", "number", "integer"] as const, "string"),
      title: cleanText(field.title) || key,
    };
    if (field.description) clean.description = cleanText(field.description).slice(0, 240);
    if (Array.isArray(field.enum) && field.enum.length) clean.enum = field.enum.slice(0, 10);
    if (Array.isArray(field.enumNames)) clean.enumNames = field.enumNames.slice(0, 10).map((n) => cleanText(n));
    if (Array.isArray(field.options)) {
      clean.options = field.options.map((o) => cleanText(o)).filter(Boolean).slice(0, 10);
    }
    if (typeof field.minimum === "number") clean.minimum = field.minimum;
    if (typeof field.maximum === "number") clean.maximum = field.maximum;
    if (typeof field.minLength === "number") clean.minLength = field.minLength;
    if (typeof field.maxLength === "number") clean.maxLength = field.maxLength;
    if (field.format && FORMATS.includes(field.format)) clean.format = field.format;
    if (field.control && CONTROLS.includes(field.control)) clean.control = field.control;
    if (field.source) clean.source = cleanText(field.source).slice(0, 60);

    // --- default: must agree with the field's own constraints ---------------
    let fallback = field.default;
    if (field.format === "date") {
      fallback = isoDate(field.default);
    }
    if (clean.options?.length) {
      // A tick-list default: the model may send a scalar that names an option.
      if (typeof fallback === "string" && clean.options.includes(fallback)) fallback = [fallback];
      else if (!Array.isArray(fallback)) fallback = undefined;
    }
    if (["string", "number", "boolean"].includes(typeof fallback) || Array.isArray(fallback)) {
      clean.default = fallback as Field["default"];
    }
    if (typeof clean.default === "number") {
      if (clean.minimum !== undefined && clean.default < clean.minimum) clean.default = clean.minimum;
      if (clean.maximum !== undefined && clean.default > clean.maximum) clean.default = clean.maximum;
      if (clean.type === "integer") clean.default = Math.round(clean.default);
    }
    properties[key.replace(/[^A-Za-z0-9_]/g, "_")] = clean;
  }
  if (!Object.keys(properties).length) {
    properties.needsReview = {
      type: "string",
      title: "What to review",
      description: "The model returned no usable fields, so this is the only question left.",
    };
  }

  const keys = Object.keys(properties);
  const sections: Section[] = [];
  const seen = new Set<string>();
  for (const section of Array.isArray(data.sections) ? data.sections : []) {
    const title = cleanText(section?.title) || "Details";
    const list = (Array.isArray(section?.fields) ? section.fields : [])
      .map(String)
      .filter((key) => properties[key] && !seen.has(key));
    if (!list.length) continue;
    list.forEach((key) => seen.add(key));
    sections.push({ title, fields: list });
  }
  const rest = keys.filter((key) => !seen.has(key));
  if (rest.length) sections.push({ title: sections.length ? "Additional detail" : "Request details", fields: rest });

  const requiredSource = Array.isArray(data.requestedSchema?.required)
    ? data.requestedSchema.required
    : Array.isArray(data.required) ? data.required : [];
  const required = requiredSource.map(String).filter((key) => properties[key]);

  const checklist: ChecklistItem[] = (Array.isArray(data.checklist) ? data.checklist : [])
    .slice(0, 6)
    .map((item: any, index: number) => {
      const clean: ChecklistItem = {
        id: slug(cleanText(item?.id) || cleanText(item?.label) || `item-${index + 1}`),
        label: cleanText(item?.label) || `Step ${index + 1}`,
      };
      if (item?.detail) clean.detail = cleanText(item.detail).slice(0, 160);
      if (typeof item?.requires === "string" && properties[item.requires]) clean.requires = item.requires;
      if (item?.when && typeof item.when === "object") {
        const when: Record<string, (string | number | boolean)[]> = {};
        for (const [key, values] of Object.entries(item.when)) {
          if (!properties[key] || !Array.isArray(values)) continue;
          when[key] = values as (string | number | boolean)[];
        }
        if (Object.keys(when).length) clean.when = when;
      }
      return clean;
    })
    .filter((item) => !BLOCKED.some((bad) => `${item.label} ${item.detail || ""}`.toLowerCase().includes(bad)));
  if (!checklist.length) checklist.push({ id: "confirm", label: "The information above is correct" });

  // --- view: a json-render spec, catalog-validated and repaired ------------
  const viewData = data.view && typeof data.view === "object" ? data.view : null;
  let view: PlanView | null = null;
  if (viewData?.spec) {
    const spec = viewData.spec as {
      root?: unknown;
      elements?: Record<string, { valueFrom?: unknown }>;
    };
    // Turn `valueFrom` into the binding shape first, so catalog validation sees
    // only fields that exist.
    if (spec.elements && typeof spec.elements === "object") {
      for (const node of Object.values(spec.elements)) {
        if (!node || typeof node !== "object") continue;
        const binding = cleanBinding(node.valueFrom, new Set(keys));
        if (binding) node.valueFrom = binding;
        else delete node.valueFrom;
      }
    }
    const checked = validateSpec(spec);
    if (checked.ok) {
      // Structure is sound; now repair prop names before anything renders.
      const props = checkSpec(checked.spec);
      if (props.ok) {
        view = {
          spec: props.spec,
          kind: oneOf(viewData.kind, ["dashboard", "summary", "scorecard", "timeline"] as const, "dashboard"),
          title: cleanText(viewData.title) || "Case at a glance",
          notes: [...checked.notes, ...props.repairs.map((r) => `${r.id || r.type}: ${r.note}`), ...props.dropped],
        };
      }
    }
  }

  const facts = data.caseFacts && typeof data.caseFacts === "object" ? data.caseFacts : null;
  const caseFacts: CaseFacts | null = facts
    ? {
      headline: cleanText(facts.headline) || "Facts from the request",
      source: cleanText(facts.source) || "the original message",
      known: (Array.isArray(facts.known) ? facts.known : [])
        .map((k: any) => ({ label: cleanText(k?.label), field: properties[k?.field] ? String(k.field) : undefined }))
        .filter((k: { label: string }) => k.label).slice(0, 10),
      gaps: (Array.isArray(facts.gaps) ? facts.gaps : [])
        .map((g: any) => ({ label: cleanText(g?.label), why: cleanText(g?.why) || undefined }))
        .filter((g: { label: string }) => g.label).slice(0, 10),
    }
    : null;

  const department = cleanText(data.department) || "General";
  const practice = data.practice && typeof data.practice === "object" && cleanText(data.practice.id)
    ? {
      id: String(data.practice.id),
      name: cleanText(data.practice.name) || String(data.practice.id),
      city: cleanText(data.practice.city),
      focus: cleanText(data.practice.focus) || undefined,
    }
    : null;

  const givenId = cleanText(data.id);
  const id = /^[a-z0-9][a-z0-9-]{0,39}$/.test(givenId)
    ? givenId
    : slug(cleanText(data.title) || prompt.slice(0, 40));

  return {
    id,
    title: cleanText(data.title) || prompt.slice(0, 60) || "New request",
    message: cleanText(data.message) || `Drafting a request from: ${prompt}`,
    department,
    specialty: cleanText(data.specialty) || department,
    departmentCode: departmentCode(department),
    practice,
    tags: (Array.isArray(data.tags) ? data.tags : []).map((t) => slug(String(t))).filter(Boolean).slice(0, 4),
    priority: oneOf(data.priority, ["routine", "urgent", "emergent"] as const, "routine"),
    request: cleanText(data.request) || undefined,
    novel: cleanText(data.novel) || undefined,
    fieldsUnknownExAnte: Boolean(data.fieldsUnknownExAnte ?? true),
    requiresView: Boolean(data.requiresView) || Boolean(view),
    caseFacts,
    view: view ?? undefined,
    sections,
    checklist,
    requestedSchema: { type: "object", required, properties },
  };
}

export type ChecklistState = { id: string; label: string; detail?: string; done: boolean };

export function checklistState(plan: Plan, content: Record<string, unknown>, ticked: string[]): ChecklistState[] {
  return plan.checklist.map((item) => {
    if (ticked.includes(item.id)) return { id: item.id, label: item.label, detail: item.detail, done: true };
    let done = true;
    if (item.requires) {
      const value = content[item.requires];
      done = value !== undefined && value !== "" && value !== null &&
        !(Array.isArray(value) && value.length === 0);
    }
    if (done && item.when) {
      done = Object.entries(item.when).every(([key, allowed]) => {
        const value = content[key];
        return Array.isArray(value)
          ? value.some((v) => allowed.includes(v))
          : allowed.includes(value as never);
      });
    }
    return { id: item.id, label: item.label, detail: item.detail, done };
  });
}

type Validation =
  | { valid: false; errors: string[] }
  | {
    valid: true;
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
    checklist?: ChecklistState[];
  };

export function validateResponse(plan: Plan, input: unknown, ticked: string[] = []): Validation {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { valid: false, errors: ["Expected a response object"] };
  const body = input as Record<string, unknown>;
  if (body.action !== "accept" && body.action !== "decline" && body.action !== "cancel") {
    return { valid: false, errors: ["action must be accept, decline or cancel"] };
  }
  if (body.action !== "accept") return { valid: true, action: body.action };
  const content = body.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return { valid: false, errors: ["content must be an object"] };
  const data = content as Record<string, unknown>;
  const errors: string[] = [];
  const empty = (value: unknown) =>
    value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

  for (const key of plan.requestedSchema.required) {
    if (empty(data[key])) errors.push(`${key}: required`);
  }
  for (const [key, value] of Object.entries(data)) {
    const field = plan.requestedSchema.properties[key];
    if (!field) { errors.push(`${key}: unknown field`); continue; }
    // A tick-list is an array of the declared options; everything else is scalar.
    if (field.options) {
      const list = Array.isArray(value) ? value : [value];
      if (!Array.isArray(value) || list.some((v) => !field.options!.includes(String(v)))) {
        errors.push(`${key}: expected a list of the offered options`);
      }
      continue;
    }
    const expected = field.type === "integer" ? "number" : field.type;
    if (typeof value !== expected || (expected === "number" && !Number.isFinite(value as number))) {
      errors.push(`${key}: expected ${field.type}`);
      continue;
    }
    if (field.type === "integer" && !Number.isInteger(value as number)) errors.push(`${key}: expected integer`);
    else if (field.enum && !field.enum.includes(value as string)) errors.push(`${key}: invalid choice`);
    else if (typeof value === "number" && ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) {
      errors.push(`${key}: outside allowed range`);
    } else if (typeof value === "string" && ((field.minLength !== undefined && value.length < field.minLength) || (field.maxLength !== undefined && value.length > field.maxLength))) {
      errors.push(`${key}: length outside allowed range`);
    } else if (typeof value === "string" && field.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      errors.push(`${key}: expected YYYY-MM-DD`);
    } else if (typeof value === "string" && field.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      errors.push(`${key}: expected an email address`);
    }
  }
  return errors.length
    ? { valid: false, errors }
    : { valid: true, action: "accept", content: data, checklist: checklistState(plan, data, ticked) };
}

/** Hand-written plan: the fallback when AI drafting is unavailable. */
export const starterPlans: Plan[] = [
  {
    id: "pro-bono-other",
    title: "Triage the pro bono 'other' intake",
    message: "The applicant picked «Other» and attached a paragraph. A few things are missing before a volunteer can take the case.",
    department: "Pro bono",
    specialty: "Intake triage",
    departmentCode: "PROB",
    practice: null,
    tags: ["pro-bono", "intake"],
    priority: "routine",
    novel: "Nobody can list the fields for “Other” in advance — they come from what the applicant wrote.",
    caseFacts: {
      headline: "Applicant ticked «Other» on the legal issue dropdown",
      source: "intake form + attached letter",
      known: [
        { label: "Eviction hearing scheduled 2026-11-19", field: "deadline" },
        { label: "Two children in the household", field: "children" },
      ],
      gaps: [
        { label: "Which practice should take this?", why: "«Other» fits three of our practices" },
        { label: "How soon is help needed?", why: "drives the deadline" },
      ],
    },
    sections: [
      { title: "What the letter already tells us", fields: ["issueArea", "deadline", "children"] },
      { title: "The gaps", fields: ["language", "urgency", "contactEmail"] },
    ],
    checklist: [
      { id: "conflict", label: "No conflict with an existing client", requires: "issueArea" },
      { id: "deadline", label: "Deadline is more than 10 days away", when: { urgency: ["no-rush", "soon"] } },
    ],
    requestedSchema: {
      type: "object",
      required: ["issueArea", "contactEmail"],
      properties: {
        issueArea: {
          type: "string",
          title: "Closest issue area",
          enum: ["housing", "benefits", "employment", "immigration", "family"],
          enumNames: ["Housing / eviction", "Public benefits", "Employment", "Immigration", "Family"],
          control: "chips",
          default: "housing",
          description: "We narrowed «Other» to five practices that take these cases.",
        },
        deadline: { type: "string", title: "Court or filing date", format: "date", control: "date", default: "2026-11-19", source: "from the attached letter" },
        children: { type: "integer", title: "Children in household", control: "stepper", minimum: 0, maximum: 12, default: 2 },
        language: {
          type: "string",
          title: "Preferred language",
          enum: ["en", "pt", "es"],
          enumNames: ["English", "Portuguese", "Spanish"],
          control: "select",
          default: "en",
        },
        urgency: {
          type: "string",
          title: "How soon do you need help?",
          enum: ["today", "soon", "no-rush"],
          enumNames: ["Today", "This week", "No rush"],
          control: "segmented",
          default: "today",
        },
        contactEmail: { type: "string", title: "Email for the volunteer", format: "email", control: "number", default: "applicant@example.org" },
      },
    },
  },
];
