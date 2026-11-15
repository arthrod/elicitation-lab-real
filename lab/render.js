/**
 * json-render → DOM.
 *
 * The server sends a spec: `{ root, elements: { id: { type, props, children, valueFrom } } }`.
 * This walks the tree from the root, resolves each element's props (including
 * live answer bindings), and draws it with the page's own design system.
 *
 * Two deliberate choices:
 *
 *  1. Directives come from `@json-render/core` + `@json-render/directives` over
 *     esm.sh — the same code the server validates with. Reimplementing $math or
 *     $format here would let the browser and the server disagree about what a
 *     value means, which is the one bug this demo cannot afford.
 *  2. An element with no renderer draws a visible `⚠` marker instead of nothing.
 *     A silently missing panel is indistinguishable from a model that produced
 *     nothing; a marker tells the truth.
 */

let registry = null;
let resolvePropValue = null;

/** Load the directive engine once. Falls back to literal values if it fails. */
export async function initRenderer() {
  if (registry) return;
  const [core, directives] = await Promise.all([
    import("https://esm.sh/@json-render/core@0.22.0"),
    import("https://esm.sh/@json-render/directives@0.22.0"),
  ]);
  resolvePropValue = core.resolvePropValue;
  registry = core.createDirectiveRegistry(directives.standardDirectives);
}

const primitive = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Resolve one prop, applying any directive it carries. */
function resolveProp(value, state) {
  if (!resolvePropValue || !value || typeof value !== "object") return value;
  try {
    return resolvePropValue(value, { directives: registry, state });
  } catch {
    return undefined;
  }
}

/** Recursively swap `{ $this: true }` for the answer value. */
function substituteThis(node, answer) {
  if (node === undefined) return answer;
  if (Array.isArray(node)) return node.map((n) => substituteThis(n, answer));
  if (node && typeof node === "object") {
    const entries = Object.entries(node);
    if (entries.length === 1 && entries[0][0] === "$this") return answer;
    return Object.fromEntries(entries.map(([k, v]) => [k, substituteThis(v, answer)]));
  }
  return node;
}

const isEmpty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

/**
 * Read one element's props through its binding.
 * Mirrors `readBinding` in lab/bindings.ts — same rules, same refusals.
 */
function boundValue(element, answers) {
  const binding = element.valueFrom;
  if (!binding?.field) return undefined;
  const answer = answers[binding.field];
  const missing = isEmpty(answer);
  if (!binding.directive) return { value: answer, missing, computed: false };

  const params = substituteThis(binding.directive, answer);
  try {
    const value = resolveProp(params, answers);
    return { value, missing, computed: true };
  } catch {
    return { value: undefined, missing, computed: true };
  }
}

/** Turn an answer into something safe to print in a text slot. */
function asText(value) {
  if (isEmpty(value)) return "";
  if (Array.isArray(value)) return value.join(" · ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/* ============================ components ============================ */

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const spacer = (direction, gap) => {
  const size = { none: "0", sm: "6px", md: "12px", lg: "20px", xl: "28px" }[gap] ?? "12px";
  return direction === "horizontal"
    ? { display: "flex", flexDirection: "row", gap: size, flexWrap: "wrap", alignItems: "center" }
    : { display: "grid", gap: size };
};

/**
 * Props, with any live binding applied.
 *
 * A binding ALWAYS beats a literal in the slot it targets. Specs routinely
 * carry a placeholder (`Metric { value: "—" }`) alongside `valueFrom`; if the
 * placeholder were allowed to win, every bound tile would render an em-dash
 * and the view would look broken while reporting zero errors. That was a real
 * bug, not a hypothetical.
 */
function withBinding(element, answers, keys) {
  const out = {};
  for (const [k, v] of Object.entries(element.props ?? {})) out[k] = resolveProp(v, answers);
  const bound = boundValue(element, answers);
  if (bound) {
    out.__bound = bound;
    // A missing answer leaves the placeholder in place: the tile then shows
    // "—" with `empty` styling, which is distinguishable from a real value.
    if (!bound.missing && bound.value !== undefined) {
      const text = primitive(bound.value)
        ? String(bound.value)
        : Array.isArray(bound.value)
        ? bound.value.join(" · ")
        : undefined;
      if (text !== undefined) for (const key of keys) out[key] = text;
    }
  }
  return out;
}

const RENDERERS = {
  Card(props, children) {
    const box = el("div", "v-card");
    if (props.tone === "ink") box.classList.add("v-card-ink");
    if (props.title) box.append(el("div", "v-card-title", props.title));
    if (props.description) box.append(el("p", "v-card-desc", props.description));
    if (children.length) {
      const body = el("div", "v-card-body");
      children.forEach((c) => body.append(c));
      box.append(body);
    }
    return box;
  },

  Stack(props, children) {
    const box = el("div", "v-stack");
    Object.assign(box.style, spacer(props.direction === "horizontal" ? "horizontal" : "vertical", props.gap));
    if (props.align) box.style.alignItems = props.align === "center" ? "center" : props.align === "end" ? "flex-end" : "flex-start";
    children.forEach((c) => box.append(c));
    return box;
  },

  Grid(props, children) {
    const box = el("div", "v-grid");
    const cols = Math.min(4, Math.max(1, Number(props.columns) || 2));
    box.style.setProperty("--v-cols", String(cols));
    box.style.gap = { sm: "8px", md: "12px", lg: "16px", xl: "20px" }[props.gap] ?? "12px";
    children.forEach((c) => box.append(c));
    return box;
  },

  Separator() {
    return el("div", "v-sep");
  },

  Heading(props) {
    const tag = props.level === "h1" ? "h2" : props.level === "h3" ? "h4" : props.level === "h4" ? "h5" : "h3";
    return el(tag, "v-heading", props.text);
  },

  Text(props) {
    const variant = props.variant ?? "body";
    return el("p", `v-text v-text-${variant}`, props.text);
  },

  Badge(props) {
    const box = el("span", `v-badge v-badge-${props.variant ?? "default"}`, props.text);
    return box;
  },

  Alert(props) {
    const type = props.type ?? "info";
    const box = el("div", `v-alert v-alert-${type}`);
    box.setAttribute("role", type === "error" ? "alert" : "status");
    const mark = { info: "i", success: "✓", warning: "!", error: "✕" }[type] ?? "i";
    box.append(el("span", "v-alert-mark", mark));
    const body = el("div", "v-alert-body");
    if (props.title) body.append(el("strong", "v-alert-title", props.title));
    if (props.message) body.append(el("span", "v-alert-msg", props.message));
    box.append(body);
    return box;
  },

  Progress(props) {
    const max = Number(props.max) || 100;
    const raw = Number(props.value);
    const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, (raw / max) * 100)) : 0;
    const box = el("div", "v-progress");
    if (props.label) box.append(el("span", "v-progress-label", props.label));
    const track = el("div", "v-progress-track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(max));
    if (Number.isFinite(raw)) track.setAttribute("aria-valuenow", String(raw));
    if (props.label) track.setAttribute("aria-label", props.label);
    const fill = el("div", `v-progress-fill${pct >= 70 ? " hot" : ""}`);
    fill.style.width = `${Number.isFinite(raw) ? Math.max(pct, 2) : 0}%`;
    track.append(fill);
    box.append(track);
    const read = el("span", "v-progress-read");
    read.textContent = Number.isFinite(raw) ? `${raw} / ${max}` : "not answered yet";
    box.append(read);
    return box;
  },

  Table(props) {
    const table = el("table", "v-table");
    if (props.caption) table.append(el("caption", "", props.caption));
    if (Array.isArray(props.columns) && props.columns.length) {
      const thead = el("thead");
      const tr = el("tr");
      props.columns.forEach((c) => tr.append(el("th", "", c)));
      thead.append(tr);
      table.append(thead);
    }
    const tbody = el("tbody");
    (Array.isArray(props.rows) ? props.rows : []).forEach((row) => {
      const tr = el("tr");
      (Array.isArray(row) ? row : [row]).forEach((cell) => tr.append(el("td", "", cell)));
      tbody.append(tr);
    });
    table.append(tbody);
    return table;
  },

  Spinner(props) {
    const box = el("div", "v-spinner");
    box.setAttribute("role", "status");
    box.append(el("span", "v-spinner-dot"));
    box.append(el("span", "", props.label ?? "Loading"));
    return box;
  },

  Metric(props) {
    const value = asText(props.value);
    const box = el("div", `v-metric${props.emphasis ? " emphasis" : ""}${value ? "" : " empty"}`);
    box.append(el("span", "k", props.label));
    box.append(el("span", "v", value || "—"));
    if (props.hint) box.append(el("span", "h", props.hint));
    return box;
  },

  KeyValue(props) {
    const dl = el("dl", "kv v-keyvalue");
    (Array.isArray(props.rows) ? props.rows : []).forEach((row) => {
      dl.append(el("dt", "", row?.label ?? ""));
      dl.append(el("dd", "", asText(row?.value) || "—"));
    });
    return dl;
  },
};

/** Which props an element's binding may fill, per component. */
const BINDING_TARGETS = {
  Metric: ["value"],
  Text: ["text"],
  Heading: ["text"],
  Badge: ["text"],
  Progress: ["value"],
  Alert: ["message"],
  Card: ["title", "description"],
};

/** Prop signature the server sends, so the debug panel can show what was asked for. */
export const RENDERED_TYPES = Object.keys(RENDERERS);

/* ============================ the walk ============================ */

/**
 * Draw a spec into a container.
 * @returns {{ rendered: number, missing: string[] }}
 */
export function renderSpec(container, spec, answers = {}) {
  container.replaceChildren();
  if (!spec || typeof spec !== "object" || !spec.elements) {
    container.append(el("p", "v-empty", "The model produced no renderable view for this case."));
    return { rendered: 0, missing: [] };
  }

  const seen = new Set();
  const missing = [];
  let rendered = 0;

  const draw = (id, depth) => {
    if (depth > 8 || seen.has(id)) return null;
    const element = spec.elements[id];
    if (!element) {
      missing.push(id);
      return null;
    }
    seen.add(id);

    const renderer = RENDERERS[element.type];
    const targets = BINDING_TARGETS[element.type] ?? [];
    const props = withBinding(element, answers, targets);

    if (!renderer) {
      missing.push(`${element.type} (${id})`);
      const warn = el("div", "v-unknown", `⚠ ${element.type} has no renderer`);
      warn.title = JSON.stringify(props);
      return warn;
    }

    const kids = (element.children ?? [])
      .map((child) => draw(child, depth + 1))
      .filter(Boolean);
    rendered++;
    return renderer(props, kids);
  };

  const root = draw(spec.root, 0);
  if (root) container.append(root);
  else container.append(el("p", "v-empty", "The view's root element could not be rendered."));

  return { rendered, missing };
}
