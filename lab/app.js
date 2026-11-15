import { initRenderer, renderSpec } from "/lab/render.js";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  meta: null,
  plan: null,
  draft: {},
  fromFacts: new Set(),
  ticked: new Set(),
  autoCleared: new Set(),
  factsTicked: new Set(),
  factMap: {},
  action: "accept",
  tab: "schema",
  view: "form",
  transcript: [],
  lastMeta: null,
  serverErrors: {},
  seen: [],
};

const ACTION_NOTES = {
  accept: "Returns the content object. Required fields must be filled before validating.",
  decline: "Returns a decline with no content — the agent gets a refusal, not a blank answer.",
  cancel: "Returns a cancellation with no content — the user backed out entirely.",
};

function toast(message, isError = false) {
  const target = $("#toast");
  target.textContent = message;
  target.classList.toggle("err", isError);
  target.classList.add("show");
  clearTimeout(target.timer);
  target.timer = setTimeout(() => target.classList.remove("show"), 2800);
}

/* ================= gates (mirrors the server) ================= */

function checklistState() {
  const plan = state.plan;
  if (!plan) return [];
  return plan.checklist.map((item) => {
    if (state.ticked.has(item.id) || state.autoCleared.has(item.id)) return { ...item, done: true };
    let done = true;
    if (item.requires) {
      const v = state.draft[item.requires];
      done = v !== undefined && v !== "" && v !== null && !(Array.isArray(v) && !v.length);
    }
    if (done && item.when) {
      done = Object.entries(item.when).every(([k, allowed]) => {
        const v = state.draft[k];
        return Array.isArray(v) ? v.some((x) => allowed.includes(x)) : allowed.includes(v);
      });
    }
    if (done) state.autoCleared.add(item.id);
    return { ...item, done };
  });
}

/* ================= helpers ================= */

const isEmpty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

function displayValue(field, value) {
  if (isEmpty(value)) return "";
  if (Array.isArray(value)) return value.map((v) => labelFor(field, v)).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return labelFor(field, value);
}

function labelFor(field, value) {
  if (field?.enum) {
    const i = field.enum.indexOf(value);
    if (i >= 0 && field.enumNames?.[i]) return field.enumNames[i];
  }
  if (field?.format === "date" && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [y, m, d] = String(value).split("-");
    return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m - 1]} ${y}`;
  }
  return String(value);
}

/** Which widget to draw. Explicit control wins; otherwise infer from the type. */
function widgetOf(field) {
  if (field.options?.length) return "checkboxes";
  if (field.control) return field.control;
  if (field.format === "date") return "date";
  if (field.type === "boolean") return "switch";
  if (field.enum) return field.enum.length <= 3 ? "segmented" : field.enum.length <= 8 ? "chips" : "select";
  if (field.type === "number" || field.type === "integer") {
    return field.minimum !== undefined && field.maximum !== undefined ? "slider" : "number";
  }
  return "text";
}

function setValue(key, value) {
  if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) delete state.draft[key];
  else state.draft[key] = value;
  state.serverErrors = {};
  drawPayload();
  if (state.view === "view") drawView();
}

/* ================= the widgets ================= */

function fieldRow(key, field) {
  const required = state.plan.requestedSchema.required.includes(key);
  const row = el("div", "field");
  if (state.fromFacts.has(key) && !isEmpty(state.draft[key])) row.classList.add("pre-filled");

  const label = el(field.options || field.enum || field.type === "boolean" ? "span" : "label", "fl");
  const id = `f-${key}`;
  if (!(field.options || field.enum || field.type === "boolean")) label.htmlFor = id;
  label.append(document.createTextNode(field.title));
  label.append(el("span", required ? "req" : "opt", required ? "required" : "optional"));
  label.append(el("span", "hint", widgetLabel(field)));
  row.append(label);

  if (field.source) row.append(el("span", "src-tag", `pre-filled ${field.source}`));

  const widget = el("div", "w-wrap");
  const w = widgetOf(field);
  const value = state.draft[key];

  if (w === "checkboxes" || w === "chips") {
    const multi = w === "checkboxes" || (field.options?.length > 0);
    const group = el("div", `w-chips ${multi ? "multi" : "single"}`);
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", field.title);
    const values = field.options ?? field.enum ?? [];
    values.forEach((option, i) => {
      const name = field.options ? String(option) : (field.enumNames?.[i] ?? String(option));
      const active = multi ? Array.isArray(value) && value.includes(option) : value === option;
      const chip = el("button", "w-chip");
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(active));
      chip.append(document.createTextNode(name));
      chip.addEventListener("click", () => {
        if (multi) {
          const list = Array.isArray(value) ? [...value] : [];
          const at = list.indexOf(option);
          if (at >= 0) list.splice(at, 1);
          else list.push(option);
          setValue(key, list);
        } else {
          setValue(key, active ? undefined : option);
        }
        drawDialog();
      });
      group.append(chip);
    });
    widget.append(group);
    if (w === "checkboxes") widget.append(el("span", "hint-line", "Tick anything that applies — nothing to type."));
  } else if (w === "select") {
    const select = el("select", "w-input select-input");
    select.id = id;
    const blank = el("option", "", "Choose…");
    blank.value = "";
    select.append(blank);
    (field.enum ?? []).forEach((option, i) => {
      const opt = el("option", "", field.enumNames?.[i] ?? String(option));
      opt.value = String(option);
      select.append(opt);
    });
    select.value = value === undefined ? "" : String(value);
    select.addEventListener("change", () => setValue(key, select.value === "" ? undefined : coerce(field, select.value)));
    widget.append(select);
  } else if (w === "segmented" || w === "radio") {
    const box = el("div", w === "segmented" ? "w-seg" : "w-radios");
    box.setAttribute("role", w === "segmented" ? "group" : "radiogroup");
    box.setAttribute("aria-label", field.title);
    (field.enum ?? []).forEach((option, i) => {
      const name = field.enumNames?.[i] ?? String(option);
      const button = el("button", w === "segmented" ? "" : "w-radio");
      button.type = "button";
      button.setAttribute(w === "segmented" ? "aria-pressed" : "aria-checked", String(value === option));
      if (w === "segmented") button.append(document.createTextNode(name));
      else {
        button.append(el("span", "dot"));
        button.append(el("span", "", name));
      }
      button.addEventListener("click", () => {
        setValue(key, value === option ? undefined : option);
        drawDialog();
      });
      box.append(button);
    });
    widget.append(box);
  } else if (w === "switch") {
    const button = el("button", "w-switch");
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(value === true));
    button.append(el("span", "track"));
    button.append(el("span", "", value === true ? "On" : value === false ? "Off" : "Not set"));
    button.append(el("span", "state", value === true ? "yes" : value === false ? "no" : "—"));
    button.addEventListener("click", () => {
      setValue(key, value === true ? false : true);
      drawDialog();
    });
    widget.append(button);
  } else if (w === "slider") {
    const min = field.minimum ?? 0;
    const max = field.maximum ?? (field.type === "integer" ? 10 : 100);
    const current = typeof value === "number" ? value : min;
    const wrap = el("div", "w-slider");
    const read = el("div", "row");
    const out = el("b", "", String(isEmpty(value) ? "—" : value));
    read.append(el("span", "", `${min}`));
    read.append(out);
    read.append(el("span", "", `${max}`));
    const range = el("input", "range");
    range.type = "range";
    range.id = id;
    range.min = String(min);
    range.max = String(max);
    range.step = field.type === "integer" ? "1" : "any";
    range.value = String(current);
    range.addEventListener("input", () => {
      out.textContent = range.value;
      setValue(key, Number(range.value));
    });
    wrap.append(read, range);
    widget.append(wrap);
  } else if (w === "stepper") {
    const min = field.minimum ?? 0;
    const max = field.maximum ?? 999;
    const step = field.type === "number" ? 0.5 : 1;
    const box = el("div", "w-stepper");
    const input = el("input");
    input.type = "number";
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = value === undefined ? "" : String(value);
    const bump = (dir) => {
      const base = typeof value === "number" ? value : dir > 0 ? min - step : min + step;
      const next = Math.min(max, Math.max(min, Math.round((base + dir * step) * 100) / 100));
      setValue(key, next);
      drawDialog();
    };
    const minus = el("button", "", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", `Decrease ${field.title}`);
    minus.addEventListener("click", () => bump(-1));
    const plus = el("button", "", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", `Increase ${field.title}`);
    plus.addEventListener("click", () => bump(1));
    input.addEventListener("input", () => setValue(key, input.value === "" ? undefined : Number(input.value)));
    box.append(minus, input, plus);
    widget.append(box);
  } else if (w === "date") {
    const wrap = el("div", "w-date");
    const input = el("input");
    input.type = "date";
    input.id = id;
    input.value = typeof value === "string" ? value : "";
    input.addEventListener("change", () => setValue(key, input.value || undefined));
    const today = el("button", "", "Today");
    today.type = "button";
    today.addEventListener("click", () => {
      input.value = new Date().toISOString().slice(0, 10);
      setValue(key, input.value);
    });
    const clear = el("button", "", "Clear");
    clear.type = "button";
    clear.addEventListener("click", () => {
      input.value = "";
      setValue(key, undefined);
    });
    wrap.append(input, today, clear);
    widget.append(wrap);
  } else if (w === "textarea") {
    const area = el("textarea", "w-input");
    area.id = id;
    area.rows = 3;
    if (field.minLength) area.minLength = field.minLength;
    if (field.maxLength) area.maxLength = field.maxLength;
    area.value = value ?? "";
    area.placeholder = field.description || "A sentence is enough";
    area.addEventListener("input", () => setValue(key, area.value === "" ? undefined : area.value));
    widget.append(area);
  } else {
    const input = el("input", "w-input" + (field.type === "string" ? "" : " mono"));
    input.id = id;
    input.type = field.format === "email" ? "email" : field.type === "string" ? "text" : "number";
    if (field.minimum !== undefined) input.min = field.minimum;
    if (field.maximum !== undefined) input.max = field.maximum;
    if (field.type === "integer") input.step = "1";
    if (field.type === "number") input.step = "any";
    if (field.minLength) input.minLength = field.minLength;
    if (field.maxLength) input.maxLength = field.maxLength;
    input.value = value ?? "";
    input.placeholder = field.description ? "" : (field.format || "");
    input.addEventListener("input", () => setValue(key, input.value === "" ? undefined : coerce(field, input.value)));
    widget.append(input);
  }

  row.append(widget);
  if (field.description && w !== "textarea") row.append(el("span", "desc", field.description));
  if (state.serverErrors[key]) row.append(el("span", "err", state.serverErrors[key]));
  return row;
}

function coerce(field, raw) {
  if (field.type === "number" || field.type === "integer") return Number(raw);
  return raw;
}

function widgetLabel(field) {
  const w = widgetOf(field);
  const names = {
    chips: "pick one", checkboxes: "tick any", select: "dropdown", segmented: "one only",
    radio: "one only", switch: "toggle", slider: "slider", stepper: "count",
    date: "date picker", textarea: "short text", text: field.format || "text", number: "number",
  };
  return names[w] ?? w;
}

/* ================= facts ================= */

function drawFacts() {
  const facts = state.plan?.caseFacts;
  const box = $("#facts");
  box.hidden = !facts;
  if (!facts) return;
  $("#facts-headline").textContent = facts.headline;
  $("#facts-source").textContent = facts.source ? `source · ${facts.source}` : "";
  const body = $("#facts-body");
  body.replaceChildren();

  facts.known.forEach((fact, i) => {
    const id = String(i);
    const on = state.factsTicked.has(id);
    const button = el("button", "fact");
    button.type = "button";
    button.setAttribute("role", "checkbox");
    button.setAttribute("aria-checked", String(on));
    button.append(el("span", "box"));
    const txt = el("span", "txt", fact.label);
    if (fact.field) txt.append(el("span", "map", `→ fills ${fact.field}`));
    button.append(txt);
    button.addEventListener("click", () => {
      if (state.factsTicked.has(id)) {
        state.factsTicked.delete(id);
      } else {
        state.factsTicked.add(id);
      }
      // Re-apply: unticking a known fact should actually empty its field.
      reapplyDefaults();
      drawDialog();
    });
    body.append(button);
  });

  facts.gaps.forEach((gap) => {
    const row = el("div", "fact");
    row.style.cursor = "default";
    row.append(el("span", "box"));
    const txt = el("span", "txt");
    txt.append(el("span", "gap", "ask"));
    txt.append(document.createTextNode(gap.label));
    if (gap.why) txt.append(el("span", "map", gap.why));
    row.append(txt);
    body.append(row);
  });
}

/**
 * Recompute the pre-filled layer from the ticked facts. Any field a ticked
 * fact maps to is restored to its default; any field only that fact was
 * filling goes back to empty. Fields the person typed themselves are kept.
 */
function reapplyDefaults() {
  const plan = state.plan;
  if (!plan) return;
  const { properties } = plan.requestedSchema;
  const tickedFields = new Set();
  (plan.caseFacts?.known ?? []).forEach((fact, i) => {
    if (state.factsTicked.has(String(i)) && fact.field && properties[fact.field]) tickedFields.add(fact.field);
  });

  for (const [key, field] of Object.entries(properties)) {
    if (field.options?.length) {
      if (!Array.isArray(state.draft[key])) state.draft[key] = [];
      continue;
    }
    if (field.default === undefined) continue;
    const shouldHold = tickedFields.has(key) || !state.fromFacts.has(key);
    if (shouldHold) {
      state.draft[key] = field.default;
      state.fromFacts.add(key);
    } else {
      delete state.draft[key];
    }
  }
  state.autoCleared = new Set();
}

/* ================= dialog ================= */

function drawDialog() {
  const plan = state.plan;
  $("#d-title").textContent = plan ? plan.title : "Nothing generated yet";
  const ref = $("#d-ref");
  ref.hidden = !plan;
  if (plan) ref.textContent = plan.matterRef ?? plan.id;
  if (!plan) {
    $("#view-tabs").hidden = true;
    $("#novel").hidden = true;
    $("#facts").hidden = true;
    $("#d-form").replaceChildren();
    $("#d-checks").hidden = true;
    $("#d-view").hidden = true;
    $("#submit").disabled = true;
    return;
  }

  $("#novel").hidden = !plan.novel;
  if (plan.novel) {
    $("#novel").replaceChildren(
      el("span", "lbl", "Why this form exists — and why it could not be pre-built"),
      el("p", "", plan.novel),
    );
  }

  $("#view-tabs").hidden = !plan.view;
  document.querySelectorAll("#view-tabs button").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.view === state.view))
  );

  const showingForm = state.view === "form" || !plan.view;
  $("#d-form").hidden = !showingForm;
  $("#d-checks").hidden = !showingForm || !plan.checklist.length;
  $("#d-view").hidden = showingForm;

  if (showingForm) {
    drawFacts();
    const form = $("#d-form");
    form.replaceChildren();
    const sections = plan.sections?.length
      ? plan.sections
      : [{ title: "Request details", fields: Object.keys(plan.requestedSchema.properties) }];
    for (const section of sections) {
      form.append(el("div", "section-head", section.title));
      for (const key of section.fields) {
        const field = plan.requestedSchema.properties[key];
        if (!field) continue;
        form.append(fieldRow(key, field));
      }
    }
    drawChecklist();
  } else {
    drawView();
  }
}

function drawChecklist() {
  const items = checklistState();
  $("#d-checks").hidden = !items.length || state.view !== "form";
  if (!items.length) return;
  $("#check-prog").textContent = `${items.filter((i) => i.done).length} / ${items.length} cleared`;
  const list = $("#check-list");
  list.replaceChildren();
  for (const item of items) {
    const row = el("button", `check ${item.done ? "done" : ""}`);
    row.type = "button";
    row.setAttribute("role", "checkbox");
    row.setAttribute("aria-checked", String(item.done));
    row.addEventListener("click", () => {
      if (state.ticked.has(item.id)) state.ticked.delete(item.id);
      else state.ticked.add(item.id);
      drawChecklist();
      drawPayload();
    });
    row.append(el("span", "box"));
    const body = el("span", "lbl", item.label);
    if (item.when) {
      const cond = Object.entries(item.when).map(([k, v]) => `${k}=${v.join("|")}`).join(" & ");
      body.append(el("span", "gate", `when ${cond}`));
    } else if (item.requires) {
      body.append(el("span", "gate", `needs ${item.requires}`));
    }
    if (item.detail) body.append(el("span", "d", item.detail));
    row.append(body);
    list.append(row);
  }
}

/* ================= the generated view ================= */

/**
 * The View tab renders the model's json-render spec. The old implementation
 * read `view.blocks` / `view.style` — fields the Plan contract stopped having
 * when views became json-render specs — so it threw on every plan that had a
 * view and left the panel blank. `renderSpec` is the real renderer.
 */
function drawView() {
  const plan = state.plan;
  const box = $("#d-view");
  box.replaceChildren();
  if (!plan?.view) {
    box.append(el("p", "v-empty", "This request didn't need a view — it's a form."));
    return;
  }
  const view = plan.view;

  const head = el("div", "view-head");
  head.append(el("h3", "", view.title || "View"));
  if (view.kind) head.append(el("span", "style", view.kind));
  box.append(head);

  const spec = view.spec;
  if (!spec || typeof spec !== "object" || !spec.elements) {
    box.append(el("p", "v-empty", "The model returned a view that couldn't be rendered: no spec elements."));
    return;
  }

  try {
    renderSpec(box, spec, state.draft);
  } catch (error) {
    // A renderer bug must not take the whole panel (or the page) down with it.
    console.error("renderSpec failed", error);
    box.append(el("p", "v-empty", `Drawing the view failed: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }

  if (view.notes?.length) box.append(notesStrip(view.notes));
}

/** Repairs the server made, so a dropped component costs a note and not a mystery. */
function notesStrip(notes) {
  const details = el("details", "v-notes");
  const summary = el("summary", "", `⚠ ${notes.length} repair${notes.length === 1 ? "" : "s"} applied`);
  details.append(summary);
  const list = el("ul");
  notes.forEach((note) => list.append(el("li", "", String(note))));
  details.append(list);
  return details;
}


/* ================= readiness + payload ================= */

function issues() {
  const plan = state.plan;
  if (!plan || state.action !== "accept") return [];
  const problems = [];
  for (const key of plan.requestedSchema.required) {
    if (isEmpty(state.draft[key])) problems.push(`${key}: required`);
  }
  for (const [key, value] of Object.entries(state.draft)) {
    const field = plan.requestedSchema.properties[key];
    if (!field || field.options) continue;
    if (typeof value === "number" && ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) {
      problems.push(`${key}: range`);
    }
    if (typeof value === "string" && field.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      problems.push(`${key}: email`);
    }
  }
  return problems;
}

function responsePayload() {
  const plan = state.plan;
  const base = plan ? { plan } : {};
  if (state.action !== "accept") return { ...base, action: state.action };
  return { ...base, action: state.action, content: state.draft, ticked: [...state.ticked] };
}

function updateReadiness() {
  const problems = issues();
  const ready = Boolean(state.plan) && !problems.length;
  $("#submit").disabled = !ready;
  $("#valid").textContent = problems.length
    ? `■ ${problems.slice(0, 3).join(" · ")}${problems.length > 3 ? ` +${problems.length - 3}` : ""}`
    : ready ? "■ Ready for server validation" : "■ —";
  $("#valid").className = problems.length ? "bad" : ready ? "ok" : "";
}

function envelope() {
  const plan = state.plan;
  if (!plan) return { request: null, result: null };
  return {
    request: {
      jsonrpc: "2.0",
      id: 4711,
      method: "elicitation/create",
      params: {
        mode: "form",
        message: plan.message,
        requestedSchema: plan.requestedSchema,
        // Rich widgets travel in the MCP-only extension slot, like VS Code's _meta.ui.
        _meta: {
          ui: { view: plan.view ?? null, facts: plan.caseFacts ?? null, novel: plan.novel ?? null },
        },
      },
    },
    result: state.submittedResult ?? null,
  };
}

function payloadText() {
  const plan = state.plan;
  switch (state.tab) {
    case "response":
      return JSON.stringify(responsePayload(), null, 2);
    case "request":
      return state.transcript.length
        ? state.transcript.map((m) => `--- ${m.role} ---\n${m.content}`).join("\n\n")
        : "Generate first to see the exact system + user prompt sent to the model.";
    case "envelope": {
      const { request, result } = envelope();
      return request ? JSON.stringify({ request, result }, null, 2) : "No plan yet.";
    }
    default:
      return plan
        ? JSON.stringify({
          mode: "form",
          message: plan.message,
          requestedSchema: plan.requestedSchema,
          _meta: { ui: { controls: Object.fromEntries(Object.entries(plan.requestedSchema.properties).map(([k, f]) => [k, widgetOf(f)])) } },
        }, null, 2)
        : "No plan yet.";
  }
}

function drawPayload() {
  const text = payloadText();
  $("#payload").textContent = text;
  $("#bytes").textContent = `${new Blob([text]).size} bytes`;
  $("#tab-label").textContent = {
    schema: "requestedSchema",
    response: "response → server",
    request: "prompt → model",
    envelope: "JSON-RPC frame",
  }[state.tab];
  updateReadiness();
}

/* ================= decided panel ================= */

function drawDecided() {
  const plan = state.plan;
  const box = $("#decided");
  box.replaceChildren();
  $("#decided-ref").textContent = plan ? (plan.matterRef ?? plan.id) : "—";
  if (!plan) return;
  const kv = el("dl", "kv");
  const add = (k, v) => {
    kv.append(el("dt", "", k));
    kv.append(el("dd", "", v || "—"));
  };
  add("Department", plan.department);
  add("Specialty", plan.specialty);
  add("Routing", plan.departmentCode);
  if (plan.practice) add("Practice", `${plan.practice.name}${plan.practice.city ? ` · ${plan.practice.city}` : ""}`);
  add("Priority", plan.priority);
  const widgets = Object.values(plan.requestedSchema.properties).map((f) => widgetOf(f));
  add("Widgets", widgets.join(" · "));
  add("Fields", `${Object.keys(plan.requestedSchema.properties).length} · ${plan.requestedSchema.required.length} required`);
  box.append(kv);
  if (plan.tags?.length) {
    const chips = el("div", "chips");
    chips.style.marginTop = "12px";
    plan.tags.forEach((t) => chips.append(el("span", "chip", t)));
    box.append(chips);
  }
  if (state.lastMeta) {
    box.append(el("p", "hint-line", `Drafted by ${state.lastMeta.model} in ${state.lastMeta.ms} ms${state.lastMeta.tokens ? ` · ${state.lastMeta.tokens} tokens` : ""}.`));
  }
}

function drawStats() {
  const plan = state.plan;
  $("#s-fields").textContent = plan ? String(Object.keys(plan.requestedSchema.properties).length) : "0";
  $("#s-prefilled").textContent = String([...state.fromFacts].filter((k) => !isEmpty(state.draft[k])).length);
  $("#s-widgets").textContent = plan ? String(new Set(Object.values(plan.requestedSchema.properties).map(widgetOf)).size) : "0";
  $("#s-ms").textContent = state.lastMeta?.ms ? String(state.lastMeta.ms) : "—";
}

/* ================= examples ================= */

const ADVANTAGE_COPY = {
  fields: "Fields nobody could list in advance",
  lighter: "Shorter + pre-filled",
  view: "A view instead of a form",
};

function drawExamples() {
  const box = $("#examples");
  box.replaceChildren();
  for (const example of state.meta?.examples ?? []) {
    // The card shows the EXPLANATION. The prompt is only revealed (and sent)
    // when the visitor commits, so the box never arrives pre-filled.
    const button = el("button", "example");
    button.type = "button";
    button.append(el("span", "tag", `${example.tag} · ${ADVANTAGE_COPY[example.advantage] ?? example.advantage}`));
    button.append(el("span", "q", example.shows));
    button.append(el("span", "s", "Show the real request and generate →"));
    button.addEventListener("click", () => {
      $("#prompt").value = example.prompt;
      updateCount();
      generate(example.practiceId);
    });
    // Hover preview of the actual message, so nothing is hidden.
    button.title = example.prompt;
    box.append(button);
  }
}

/* ================= generation ================= */

function updateCount() {
  const v = $("#prompt").value;
  $("#count").textContent = `${v.length} / 600`;
  $("#count").style.color = v.length > 600 ? "var(--accent-orange)" : "";
}

let ticker = null;
async function generate(practiceOverride) {
  const prompt = $("#prompt").value.trim();
  if (prompt.length < 4) {
    toast("Describe the request in a few more words", true);
    $("#prompt").focus();
    return;
  }
  const practiceId = practiceOverride ?? ($("#practice").value || undefined);
  $("#generate").disabled = true;
  const status = $("#status");
  status.classList.add("on");
  $("#status-text").textContent = "Inventing fields and pre-filling…";
  const started = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    $("#status-time").textContent = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  }, 100);

  try {
    const response = await fetch("/api/lab/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, practiceId, seen: state.seen }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.fallback) {
        applyPlan(result.fallback.plan, result.fallback.draft, null, result.transcript ?? []);
        jumpToResult();
        toast(`${result.error}${result.hint ? ` — ${result.hint}` : ""}`, true);
      } else {
        throw new Error(result.error || "Drafting failed");
      }
      return;
    }
    state.seen.push(prompt);
    applyPlan(result.plan, result.draft, result.meta, result.transcript);
    jumpToResult();
    const n = Object.keys(result.plan.requestedSchema.properties).length;
    toast(`${n} fields invented · ${Object.keys(result.draft.content).length} pre-filled`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not generate", true);
  } finally {
    clearInterval(ticker);
    $("#generate").disabled = false;
    status.classList.remove("on");
    $("#status-time").textContent = "";
  }
}

function jumpToResult() {
  const target = $("#lab");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  const dialog = $("#dialog");
  dialog.classList.remove("flash");
  // restart the highlight animation
  void dialog.offsetWidth;
  dialog.classList.add("flash");
  setTimeout(() => $("#lab").focus({ preventScroll: true }), reduce ? 0 : 500);
}

function applyPlan(plan, draft, meta, transcript) {
  state.plan = plan;
  state.draft = { ...(draft?.content ?? {}) };
  state.fromFacts = new Set(draft?.fromFacts ?? []);
  // The facts strip: every known fact maps to a field, so start ticked.
  state.factsTicked = new Set((plan.caseFacts?.known ?? []).map((_, i) => String(i)));
  state.factMap = {};
  state.ticked = new Set();
  state.autoCleared = new Set();
  state.serverErrors = {};
  state.submittedResult = null;
  state.action = "accept";
  state.transcript = transcript ?? [];
  state.lastMeta = meta;
  // Land on whatever the model actually produced: a view if it made one.
  state.view = plan.view ? "view" : "form";
  document.querySelectorAll("#action button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.v === "accept"))
  );
  $("#actnote").textContent = ACTION_NOTES.accept;
  drawDecided();
  drawDialog();
  drawPayload();
  drawStats();
}

/* ================= submit ================= */

$("#submit").addEventListener("click", async () => {
  if (!state.plan || issues().length) return;
  const button = $("#submit");
  button.disabled = true;
  button.textContent = "Validating…";
  try {
    const response = await fetch(`/api/lab/plans/${encodeURIComponent(state.plan.id)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responsePayload()),
    });
    const result = await response.json();
    if (!response.ok || !result.valid) {
      state.serverErrors = {};
      for (const message of result.errors ?? []) {
        const [key, ...rest] = String(message).split(":");
        state.serverErrors[key.trim()] = rest.join(":").trim() || "invalid";
      }
      throw new Error(result.errors?.join(" · ") || result.error || "Validation failed");
    }
    state.submittedResult = result.action === "accept"
      ? { action: result.action, content: result.content, checklist: result.checklist }
      : { action: result.action };
    state.tab = "envelope";
    document.querySelectorAll("#tabs button").forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === "envelope"))
    );
    toast(result.action === "accept"
      ? `Accepted · validated server-side${result.checklist?.length ? ` · ${result.checklist.filter((c) => c.done).length}/${result.checklist.length} gates` : ""}`
      : `Server acknowledged: ${result.action}`);
    drawDialog();
    drawPayload();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Validation failed", true);
    drawDialog();
    drawPayload();
  } finally {
    button.innerHTML = 'Validate <span class="arr">→</span>';
    updateReadiness();
  }
});

$("#reset").addEventListener("click", () => {
  state.draft = {};
  state.ticked = new Set();
  state.autoCleared = new Set();
  state.serverErrors = {};
  state.submittedResult = null;
  drawDialog();
  drawPayload();
  drawStats();
});

/* ================= chrome ================= */

$("#action").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.action = button.dataset.v;
  document.querySelectorAll("#action button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b === button))
  );
  $("#actnote").textContent = ACTION_NOTES[state.action];
  drawPayload();
});

$("#tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.tab = button.dataset.tab;
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.setAttribute("aria-selected", String(b === button))
  );
  drawPayload();
});

$("#view-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.view = button.dataset.view;
  drawDialog();
});

$("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#payload").textContent);
    toast("Copied");
  } catch {
    toast("Clipboard unavailable; select and copy", true);
  }
});

$("#generate").addEventListener("click", () => generate());

/** Load a curated example: fills the box with the REAL request and generates. */
$("#random").addEventListener("click", () => {
  const examples = state.meta?.examples ?? [];
  if (!examples.length) return;
  const pick = examples[Math.floor(Math.random() * examples.length)];
  $("#prompt").value = pick.prompt;
  updateCount();
  generate(pick.practiceId);
});

/**
 * Write a brand new request with the model, in the voice of someone who does
 * not know how forms work. It only fills the box — the visitor decides whether
 * to send it.
 */
$("#invent").addEventListener("click", async () => {
  const button = $("#invent");
  button.disabled = true;
  button.textContent = "Writing…";
  try {
    const response = await fetch("/api/lab/random", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seen: state.seen }),
    });
    const result = await response.json();
    if (!response.ok || !result.request) throw new Error(result.error || "Could not invent one");
    $("#prompt").value = result.request;
    $("#prompt").focus();
    updateCount();
    if (result.source === "fallback") toast("Model unavailable — loaded a curated request instead", true);
    else toast(`${result.persona ?? "A new request"} · press Generate`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not invent one", true);
  } finally {
    button.disabled = false;
    button.textContent = "Invent one for me";
  }
});

$("#surprise").addEventListener("click", () => {
  const other = state.meta?.examples?.find((e) => e.advantage === "lighter") ?? state.meta?.examples?.[0];
  if (other) {
    $("#prompt").value = other.prompt;
    updateCount();
    generate(other.practiceId);
  }
});
$("#prompt").addEventListener("input", updateCount);
$("#prompt").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") generate();
});

/* ================= boot ================= */

/**
 * Load the directive engine before anything can render. If esm.sh is
 * unreachable, `renderSpec` still works — it falls back to literal prop
 * values — so a failed import degrades the views but never breaks the page.
 */
try {
  await initRenderer();
} catch (error) {
  console.warn("directive engine unavailable; views will show literal values", error);
}

try {
  const meta = await fetch("/api/lab/meta").then((r) => {
    if (!r.ok) throw new Error(`meta ${r.status}`);
    return r.json();
  });
  state.meta = meta;
  $("#model-tag").textContent = `${meta.model} · structured output`;
  const select = $("#practice");
  for (const practice of meta.practices ?? []) {
    const option = el("option", "", `${practice.name} · ${practice.city}`);
    option.value = practice.id;
    select.append(option);
  }
  drawExamples();
  // Deliberately leave the compose box empty: the placeholder is the prompt to act.
  updateCount();
} catch {
  toast("Could not load the lab metadata", true);
}

drawPayload();
