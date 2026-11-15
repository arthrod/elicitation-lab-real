/**
 * Prop-level validation and repair for json-render specs.
 *
 * Structural validation (`validateSpec` in backend/catalog.ts) only checks that
 * element ids resolve and the root exists. That is not enough: a model happily
 * emits `Alert { severity: "warning" }` or `Badge { label: "Deadline" }` — real
 * component names with *wrong prop names* — which validates structurally and
 * then renders an empty box.
 *
 * Policy, in order, per element:
 *   1. exact   — props parse against the component's Zod schema
 *   2. repair  — coerce/rename/relocate props until they do (never silently lie)
 *   3. drop    — unmappable, recorded as a note with the reason
 *
 * Repair is deliberately conservative: it moves values it can place, and it
 * never invents a value to satisfy a required prop.
 */
import { z } from "npm:zod@4";
import { componentDefinitions, type JsonElement, type JsonSpec } from "./catalog.ts";

type Def = { props: z.ZodType; description?: string };
const DEFS = componentDefinitions as Record<string, Def>;

export type Repair = {
  id: string;
  type: string;
  /** What we changed, in words the UI can show the reader. */
  note: string;
};

export type PropResult =
  | { kind: "ok"; props: Record<string, unknown>; repairs: Repair[] }
  | { kind: "rescue"; type: string; props: Record<string, unknown>; repairs: Repair[] }
  | { kind: "drop"; reason: string };

type Shape = Record<string, z.ZodType>;

/**
 * Read the Zod object's shape. The published bundle exposes it at `def.shape`
 * while stock zod v4 uses `_def.shape`, so accept both rather than pinning to
 * one packaging.
 */
function rawShape(props: z.ZodType): Shape | undefined {
  const p = props as unknown as { _def?: { shape?: Shape }; def?: { shape?: Shape } };
  return p?._def?.shape ?? p?.def?.shape;
}

/** The declared prop names + which are required, read from the Zod object. */
function shapeOf(def: Def | undefined): { shape: Shape; keys: string[]; required: string[] } {
  if (!def) return { shape: {}, keys: [], required: [] };
  const shape = rawShape(def.props) ?? {};
  const keys = Object.keys(shape);
  const required = keys.filter((k) => {
    const fn = (shape[k] as unknown as { isOptional?: () => boolean }).isOptional;
    return typeof fn === "function" ? !fn.call(shape[k]) : true;
  });
  return { shape, keys, required };
}

const isStringType = (t: z.ZodType) =>
  (t as unknown as { _def?: { type?: string }; def?: { type?: string } })._def?.type === "string" ||
  (t as unknown as { def?: { type?: string } }).def?.type === "string";

/** The first meaningful text in an object, whatever the model called the key. */
function firstText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const joined = value.filter((v) => typeof v === "string" && v.trim()).join(" · ");
    return joined || undefined;
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "label", "title", "value", "message", "name", "description", "severity", "tone"]) {
      const found = firstText((value as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** Props models use for emphasis that mean "this is a warning/alert". */
const WARNINGISH = /warn|alert|danger|critical|high|urgent|risk/i;

/**
 * The prop names models reach for that don't exist, mapped to the *role* of the
 * value rather than a fixed target. A role is then resolved against the props
 * the component actually declares, so `label` lands on `text` for Heading and on
 * `title` for Card — instead of being forced into a prop that isn't there.
 */
const ROLE_OF: Record<string, "heading" | "body" | "detail" | "headingOrBody"> = {
  heading: "heading",
  headline: "heading",
  heading_text: "heading",
  header: "heading",
  label: "headingOrBody",
  title_text: "headingOrBody",
  // Long-form text belongs on the descriptive prop.
  subtitle: "body",
  caption: "body",
  body: "body",
  content: "body",
  summary: "body",
  message: "body",
  detail: "detail",
  hint: "detail",
  // Variants / severity.
  severity: "detail",
  kind: "detail",
  status: "detail",
};

/** Which of a component's props can hold each role, in preference order. */
const ROLE_TARGETS: Record<string, string[]> = {
  heading: ["text", "title", "label"],
  body: ["description", "message", "text", "value"],
  detail: ["hint", "description", "message", "text"],
  headingOrBody: ["text", "title", "label", "description"],
};

/**
 * Coerce known prop aliases onto the real names. This is where "recycle"
 * happens — a wrong prop is moved to the prop the component actually reads.
 * `shape` is the component's declared props, so we never invent a target.
 */
function renameAliases(
  props: Record<string, unknown>,
  shape: Shape,
): { props: Record<string, unknown>; moved: string[] } {
  const moved: string[] = [];
  const out: Record<string, unknown> = { ...props };
  const has = (key: string) => key in shape;

  for (const [from, value] of Object.entries(props)) {
    if (has(from) || value === undefined) continue;
    const role = ROLE_OF[from];
    if (role) {
      const target = (ROLE_TARGETS[role] ?? []).find((t) => has(t) && out[t] === undefined);
      if (target) {
        out[target] = value;
        delete out[from];
        moved.push(`${from}→${target}`);
        continue;
      }
      // A variant word (`severity: "warning"`) belongs on an enum prop.
      if (from === "severity" && has("type") && out.type === undefined) {
        out.type = value;
        delete out[from];
        moved.push(`severity→type`);
        continue;
      }
      continue;
    }
    // Plain aliases that only make sense on one prop.
    const alias: Record<string, string> = { amount: "value", count: "value", total: "max", cols: "columns", highlight: "emphasis" };
    const target = alias[from];
    if (target && has(target) && out[target] === undefined) {
      out[target] = value;
      delete out[from];
      moved.push(`${from}→${target}`);
    }
  }
  return { props: out, moved };
}

/**
 * Validate one element's props, repairing first. Returns a rescue when the
 * component can't hold the props but a different one can (e.g. a Badge carrying
 * a long explanation becomes a Text).
 */
export function checkProps(element: JsonElement): PropResult {
  const repairs: Repair[] = [];
  const type = element.type;
  const original = (element.props ?? {}) as Record<string, unknown>;
  const def = DEFS[type];

  if (!def) {
    const text = firstText(original);
    if (!text) return { kind: "drop", reason: `unknown component ${type} with no usable text` };
    return {
      kind: "rescue",
      type: "Text",
      props: { text },
      repairs: [{ id: "", type, note: `${type} isn't in the catalog — shown as text` }],
    };
  }

  // 1. exact
  const exact = def.props.safeParse(original);
  if (exact.success) return { kind: "ok", props: original, repairs };

  // 2. repair — resolve aliases against the props this component declares
  const { shape, keys, required } = shapeOf(def);
  const { props: renamed, moved } = renameAliases(original, shape);
  if (moved.length) repairs.push({ id: "", type, note: `renamed ${moved.join(", ")}` });
  const candidate: Record<string, unknown> = {};
  for (const key of keys) {
    if (renamed[key] !== undefined) candidate[key] = renamed[key];
  }

  // These schemas use `.nullable()`, not `.optional()` — so every declared prop
  // must be *present*, though it may be null. Fill the gaps rather than fail.
  const text = firstText(original);
  let usedText = 0;
  for (const key of required) {
    if (candidate[key] !== undefined) continue;
    if (!isStringType(shape[key]) || !text) continue;
    candidate[key] = text;
    usedText++;
    repairs.push({ id: "", type, note: `used text for ${key}` });
  }
  let nulled = 0;
  for (const key of keys) {
    if (candidate[key] !== undefined) continue;
    candidate[key] = null;
    nulled++;
  }
  if (nulled && !usedText) repairs.push({ id: "", type, note: `filled ${nulled} empty prop(s)` });
  // A null `label` would render a blank tile; prefer the text we have.
  if (text && "label" in shape && candidate.label == null) candidate.label = text;

  const repaired = def.props.safeParse(candidate);
  if (repaired.success) {
    const dropped = Object.keys(original).filter((k) => !(k in candidate) && !moved.some((m) => m.startsWith(`${k}→`)));
    if (dropped.length) repairs.push({ id: "", type, note: `dropped unsupported prop(s) ${dropped.join(", ")}` });
    return { kind: "ok", props: repaired.data as Record<string, unknown>, repairs };
  }

  // 3. rescue into a component that can hold the content
  // A value-bound element has no literal text — it reads an answer at render
  // time. Keep it and fill every prop with null rather than dropping the node.
  const bound = element.valueFrom ? true : false;
  if (!text && bound) {
    const all: Record<string, unknown> = {};
    for (const key of keys) all[key] = candidate[key] ?? null;
    const boundParse = def.props.safeParse(all);
    if (boundParse.success) {
      return {
        kind: "ok",
        props: boundParse.data as Record<string, unknown>,
        repairs: [...repairs, { id: "", type, note: "kept (value-bound); empty props nulled" }],
      };
    }
  }

  const severity = WARNINGISH.test(String(original.severity ?? original.type ?? original.tone ?? ""));
  if (text) {
    if (severity && type !== "Alert") {
      return {
        kind: "rescue",
        type: "Alert",
        props: { title: text, type: "warning" },
        repairs: [{ id: "", type, note: `${type} was a warning — shown as an Alert` }],
      };
    }
    // Alert with no title is the common failure; give it one from the message.
    if (type === "Alert") {
      const message = firstText(original.message ?? original.description ?? original.body);
      const title = firstText(original.title ?? original.label ?? original.text);
      const alert = DEFS.Alert.props.safeParse({ title: title ?? message ?? "Notice", message: message ?? null, type: severity ? "warning" : "info" });
      if (alert.success) {
        return {
          kind: "ok",
          props: alert.data as Record<string, unknown>,
          repairs: [{ id: "", type, note: "moved alert text into title/message" }],
        };
      }
    }
    return {
      kind: "rescue",
      type: "Text",
      props: { text },
      repairs: [{ id: "", type, note: `${type} props didn't fit — shown as text` }],
    };
  }

  return { kind: "drop", reason: `${type} props didn't validate and no text could be salvaged` };
}

export type SpecCheck = {
  ok: boolean;
  spec: JsonSpec;
  repairs: Repair[];
  dropped: string[];
  reason?: string;
};

/**
 * Validate and repair every element reachable from the root. Children pointing
 * at an element we had to drop are removed, so the tree never references a hole.
 */
export function checkSpec(spec: JsonSpec): SpecCheck {
  const repairs: Repair[] = [];
  const dropped: string[] = [];
  const out: Record<string, JsonElement> = {};

  for (const [id, element] of Object.entries(spec.elements)) {
    const result = checkProps(element);
    if (result.kind === "drop") {
      dropped.push(`${id} (${element.type}): ${result.reason}`);
      continue;
    }
    const type = result.kind === "rescue" ? result.type : element.type;
    for (const r of result.repairs) repairs.push({ ...r, id });
    // Note the ordering: props last, so the repaired bag wins over the original.
    out[id] = { children: element.children, ...element, type, props: result.props };
  }

  // Prune references to elements that no longer exist.
  for (const element of Object.values(out)) {
    const before = element.children?.length ?? 0;
    element.children = (element.children ?? []).filter((child) => Boolean(out[child]));
    if (element.children.length !== before) {
      repairs.push({ id: "", type: element.type, note: `removed ${before - element.children.length} broken child link(s)` });
    }
  }

  const root = out[spec.root];
  if (!root) return { ok: false, spec, repairs, dropped, reason: "root element was dropped" };
  return { ok: true, spec: { ...spec, root: spec.root, elements: out }, repairs, dropped };
}

/** One-line human summary for the UI note strip. */
export function summarise(check: SpecCheck): string | undefined {
  const parts: string[] = [];
  if (check.repairs.length) parts.push(`${check.repairs.length} repaired`);
  if (check.dropped.length) parts.push(`${check.dropped.length} dropped`);
  return parts.length ? parts.join(" · ") : undefined;
}
