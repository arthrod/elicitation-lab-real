/**
 * Live bindings for json-render specs: the bridge between an answer and a prop.
 *
 * A spec element may carry `valueFrom`, which reads a form answer at render
 * time instead of freezing a string into `props`:
 *
 *   "valueFrom": { "field": "hearing_date" }                       // raw answer
 *   "valueFrom": { "field": "children_count",
 *                  "directive": { "$pluralize": 2, "one": "child",
 *                                 "other": "children" } }          // computed
 *
 * `$this` inside a directive means "the answer". So a days-remaining metric is
 * `{ "$math": "subtract", "a": <today>, "b": { "$this": true } }` — the
 * directive resolves against the live value, not a literal.
 *
 * The directives themselves are `@json-render/directives`' `standardDirectives`;
 * we only adapt their calling convention, never reimplement them.
 */
import { createDirectiveRegistry, resolvePropValue } from "npm:@json-render/core@0.22.0";
import { standardDirectives } from "npm:@json-render/directives@0.22.0";

export const directiveNames = standardDirectives.map((d) => d.name);

/**
 * The registry `resolvePropValue` expects. Built once and shared: the core
 * resolver walks a prop bag and applies whichever directive it finds.
 */
export const registry = createDirectiveRegistry(standardDirectives);

/** Resolve one prop value (string, or a `{ $directive: ... }` object). */
export function resolveProp(value: unknown, state: Record<string, unknown> = {}): unknown {
  return resolvePropValue(value as never, { directives: registry, state } as never);
}

const hasDirective = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && Object.keys(value).some((k) => directiveNames.includes(k)));

/** Recursively swap `{ $this: true }` for the actual answer value. */
function substituteThis(node: unknown, answer: unknown): unknown {
  if (node === undefined) return answer;
  if (Array.isArray(node)) return node.map((n) => substituteThis(n, answer));
  if (node && typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>);
    if (entries.length === 1 && entries[0][0] === "$this") return answer;
    return Object.fromEntries(entries.map(([k, v]) => [k, substituteThis(v, answer)]));
  }
  return node;
}

export type Binding = { field: string; directive?: Record<string, unknown> };

export type Resolved = { value: unknown; computed: boolean; missing: boolean; invalid?: string };

/** A value that can be shown in a single text/number slot. */
const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * Read a binding against the current answers.
 * `computed` is true when a directive actually ran — the UI marks those, since
 * "7" derived from a date is a different claim than "7" typed by a person.
 *
 * A multi-select answer (ticked options) is a *set*, not a value: rendering it
 * into a single prop would print `["not yet assessed"]`. Those are rejected
 * unless a directive joins them ($join/$count), so a view can never show a raw
 * array as if it were a fact.
 */
export function readBinding(
  binding: Binding,
  answers: Record<string, unknown>,
): Resolved {
  const answer = answers[binding.field];
  const missing = answer === undefined || answer === null || answer === "" ||
    (Array.isArray(answer) && answer.length === 0);
  if (!binding.directive) {
    if (Array.isArray(answer)) {
      return { value: undefined, computed: false, missing, invalid: "array needs $join or $count" };
    }
    return { value: answer, computed: false, missing };
  }

  const params = substituteThis(binding.directive, answer) as Record<string, unknown>;
  if (missing && !hasDirective(params)) return { value: undefined, computed: false, missing: true };
  try {
    const value = resolveProp(params, answers);
    if (!isScalar(value)) {
      return { value: undefined, computed: true, missing, invalid: "directive returned a non-scalar" };
    }
    return { value, computed: true, missing };
  } catch {
    return { value: undefined, computed: false, missing };
  }
}

/**
 * Small set of directives the model is allowed to reach for, in the exact wire
 * format (`{"$math":"subtract","a":10,"b":3}`). Kept short on purpose: every
 * extra directive is another way for a view to be subtly wrong.
 */
export const DIRECTIVE_REFERENCE = [
  '$math — arithmetic. Wire format: { "$math": "subtract" | "add" | "multiply" | "divide" | "round" | "floor" | "ceil" | "abs", "a": number, "b"?: number }',
  '$format — { "$format": "date" | "number" | "currency" | "percent", "value": any, "currency"?: "USD" }',
  '$pluralize — { "$pluralize": <count>, "one": "day", "other": "days", "zero"?: "no days" }',
  '$join — { "$join": [<values>], "separator": " · " }',
  '$truncate — { "$truncate": <string>, "length": 40 }',
  '$concat — { "$concat": [<values>] }',
].join("\n");
