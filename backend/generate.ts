import type OpenAI from "openai";
import { DIRECTIVE_REFERENCE } from "../lab/bindings.ts";
import { type Chat, normalizePlan, type Plan, systemPrompt } from "../lab/model.ts";
import { CATALOG_REFERENCE, ELEMENT_TYPES } from "./catalog.ts";

/**
 * The practices a request can be routed to. The model may only pick one of
 * these ids — it can never invent a practice.
 */
export const PRACTICES = [
  { id: "legal-aid", name: "Metro Legal Aid", city: "Boston", focus: "housing, benefits" },
  { id: "pro-bono-clinic", name: "Pro Bono Clinic", city: "Chicago", focus: "family, immigration" },
  { id: "ssa-advocacy", name: "Benefits Advocacy Project", city: "Austin", focus: "Social Security, disability" },
  { id: "workers-rights", name: "Workers' Rights Center", city: "New York", focus: "employment" },
  { id: "self-help-center", name: "Court Self-Help Center", city: "São Paulo", focus: "pro se litigants" },
];

const MODEL = "gpt-5.6-luna";

const fieldSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "title"],
  properties: {
    type: { type: "string", enum: ["string", "boolean", "number", "integer"] },
    title: { type: "string" },
    description: { type: "string" },
    enum: { type: "array", items: { type: "string" } },
    enumNames: { type: "array", items: { type: "string" } },
    minimum: { type: "number" },
    maximum: { type: "number" },
    minLength: { type: "number" },
    maxLength: { type: "number" },
    format: { type: "string", enum: ["email", "uri", "date", "date-time"] },
    default: { type: ["string", "number", "boolean"] },
    control: {
      type: "string",
      enum: ["textarea", "select", "radio", "chips", "switch", "segmented", "date", "slider", "stepper", "number"],
    },
    source: { type: "string" },
    options: { type: "array", items: { type: "string" } },
  },
} as const;

/** JSON Schema handed to the model as response_format — outputs are constrained. */
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "message", "department", "specialty", "priority", "tags", "sections", "fields", "required", "checklist"],
  properties: {
    title: { type: "string" },
    message: { type: "string" },
    department: { type: "string" },
    specialty: { type: "string" },
    priority: { type: "string", enum: ["routine", "urgent", "emergent"] },
    tags: { type: "array", items: { type: "string" } },
    practiceId: { type: ["string", "null"], enum: [...PRACTICES.map((p) => p.id), null] },
    requiresView: { type: "boolean" },
    novel: { type: "string" },
    caseFacts: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["headline", "source", "known", "gaps"],
      properties: {
        headline: { type: "string" },
        source: { type: "string" },
        known: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label"],
            properties: { label: { type: "string" }, field: { type: "string" } },
          },
        },
        gaps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label"],
            properties: { label: { type: "string" }, why: { type: "string" } },
          },
        },
      },
    },
    view: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["kind", "title", "spec"],
      properties: {
        kind: { type: "string", enum: ["dashboard", "summary", "scorecard", "timeline"] },
        title: { type: "string" },
        spec: {
          type: "object",
          additionalProperties: false,
          required: ["root", "elements"],
          properties: {
            root: { type: "string" },
            // The element map is deliberately loose: props vary per component and
            // strict schemas cannot express that. `validateSpec` is the real gate.
            elements: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: false,
                required: ["type", "props", "children"],
                properties: {
                  type: { type: "string", enum: ELEMENT_TYPES },
                  props: { type: "object", additionalProperties: true },
                  children: { type: "array", items: { type: "string" } },
                  valueFrom: {
                    type: "object",
                    additionalProperties: false,
                    required: ["field"],
                    properties: {
                      field: { type: "string" },
                      directive: { type: "object", additionalProperties: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "fields"],
        properties: { title: { type: "string" }, fields: { type: "array", items: { type: "string" } } },
      },
    },
    fields: { type: "object", additionalProperties: fieldSchema },
    required: { type: "array", items: { type: "string" } },
    checklist: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          detail: { type: "string" },
          requires: { type: "string" },
          when: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        },
      },
    },
  },
} as const;

export type Draft = {
  plan: Plan;
  model: string;
  ms: number;
  tokens: number | null;
  transcript: Chat[];
  source: "ai";
};

export type DraftFailure = { error: string; hint?: string; transcript: Chat[]; source: "error" };

/**
 * OpenAI client per runtime. On Val Town (Deno) use the shared proxy — no API
 * key needed; on a common Node server use the standard SDK, which reads
 * OPENAI_API_KEY (and optional OPENAI_BASE_URL) from the environment. The
 * Val Town import stays dynamic so Node never tries to resolve the https URL.
 */
async function client(): Promise<OpenAI> {
  if (typeof (globalThis as { Deno?: unknown }).Deno !== "undefined") {
    const { ValTownOpenAI } = await import("https://esm.town/v/std/openai/main.ts");
    return new ValTownOpenAI({}) as unknown as OpenAI;
  }
  const { default: OpenAISDK } = await import("openai");
  return new OpenAISDK();
}

export async function draftPlan(prompt: string, practiceId?: string): Promise<Draft | DraftFailure> {
  const transcript: Chat[] = [
    {
      role: "system",
      content: systemPrompt(PRACTICES, {
        components: CATALOG_REFERENCE,
        directives: DIRECTIVE_REFERENCE,
      }),
    },
    { role: "user", content: practiceId ? `${prompt}\n\nRoute to practice id: ${practiceId}.` : prompt },
  ];
  const started = Date.now();
  try {
    const response = await (await client()).chat.completions.create({
      model: MODEL,
      max_completion_tokens: 4000,
      messages: transcript as never,
      response_format: {
        type: "json_schema",
        json_schema: { name: "elicitation_plan", strict: false, schema: PLAN_SCHEMA as never },
      },
    });
    const text = response.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      return { error: "The model returned an empty plan.", hint: "Try a more specific prompt.", transcript, source: "error" };
    }
    const raw = JSON.parse(text) as Record<string, unknown>;
    const plan = normalizePlan(
      { ...raw, request: prompt, practice: PRACTICES.find((p) => p.id === raw.practiceId) ?? null },
      prompt,
    );
    return {
      plan,
      model: MODEL,
      ms: Date.now() - started,
      tokens: response.usage?.total_tokens ?? null,
      transcript,
      source: "ai",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const limited = /rate|quota|429|limit/i.test(message);
    return {
      error: limited ? "Val Town's daily OpenAI quota is exhausted for now." : `Drafting failed: ${message}`,
      hint: limited
        ? "Set your own OPENAI_API_KEY on this val to lift the 100 requests/day proxy limit."
        : "The request never reached the form builder. Try again or pick a starter plan.",
      transcript,
      source: "error",
    };
  }
}

export type ExamplePrompt = {
  /** Card title — short, human. */
  tag: string;
  /** The explanation a visitor reads. NEVER sent to the model. */
  shows: string;
  /** The actual request placed in the compose box and sent. */
  prompt: string;
  /** Which capability this example demonstrates; used for grouping only. */
  advantage: "fields" | "view" | "lighter" | "suggest" | "validate" | "steps";
  practiceId?: string;
};

/**
 * Curated requests, each written as something a real person would actually
 * send — not a description of the feature. Between them they exercise every
 * widget (chips, select, segmented, switch, slider, stepper, date, textarea),
 * every directive ($math, $format, $pluralize, $join, $count), and all six
 * things this demo can show.
 */
export const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  {
    tag: "“Other” intake",
    advantage: "lighter",
    practiceId: "legal-aid",
    shows:
      "The applicant ticked “Other” and wrote a paragraph. The facts are mined and pre-filled, so only the real gaps get asked — five fields instead of a forty-field intake.",
    prompt:
      "I filled in your form but there wasn't a right box so I put Other. My landlord filed " +
      "something at the court and we have to be there on 19 November. I have two kids, 7 and 4, " +
      "and I paid October already, I have the money order stub. I don't know what he filed or what " +
      "I'm supposed to bring. I've never been to court before and I don't want to lose the apartment.",
  },
  {
    tag: "Internal filing",
    advantage: "validate",
    practiceId: "workers-rights",
    shows:
      "An employee reporting her own case. Watch the form flag what's inconsistent — a dated event in the future, a written warning claimed but not attached — and correct it with a warning rather than letting it through.",
    prompt:
      "I need to file an internal complaint about my manager. I was let go on 14 March and I think " +
      "it was because I asked about overtime pay. He gave me a written warning but I don't have it " +
      "with me, and honestly I think it was written after they decided. My last day was 14 March, " +
      "and my meeting about the warning was 2 April. I have texts from a coworker who saw it happen.",
  },
  {
    tag: "Blank fields",
    advantage: "suggest",
    practiceId: "pro-bono-clinic",
    shows:
      "The client left most of the intake empty. Instead of nagging, the form offers candidate answers as tickable suggestions drawn from what was written — the person confirms rather than types.",
    prompt:
      "I started this for my sister and I don't really know her details. All I know is she has a " +
      "hearing about her son and someone from the state came to the house. She doesn't speak much " +
      "English. I don't know the dates or the case number. Can someone call her instead?",
  },
  {
    tag: "Social Security",
    advantage: "fields",
    practiceId: "ssa-advocacy",
    shows:
      "An older client at the end of her working life. The questions change shape entirely — retirement age, months of contributions, whether she can still work — and the widget choice follows the question.",
    prompt:
      "I am 63 and I would like to stop working. I have been paying into Social Security since " +
      "1979 but I took four years off when my mother was sick. I want to know if I can take " +
      "retirement now or if I should wait. My last job ended in June and I am living on savings. " +
      "I don't understand the difference between retirement and disability and nobody at the " +
      "office would explain it.",
  },
  {
    tag: "Pro se steps",
    advantage: "steps",
    practiceId: "self-help-center",
    shows:
      "Someone representing themselves who has missed a step. The plan adds a timeline of what should have happened and a gate for the filing they skipped — the missing step becomes the thing the form asks about.",
    prompt:
      "I am representing myself in a small claims case. I filed the complaint and paid the fee, " +
      "I think. The other side filed an answer. I never sent them a copy of anything and I don't " +
      "know if I was supposed to. There is a case management conference on 3 December and I have " +
      "never done this before. I don't know what a case management conference even is.",
  },
  {
    tag: "Supervisor view",
    advantage: "view",
    practiceId: "pro-bono-clinic",
    shows:
      "Not a form at all. The same answers rendered as a one-screen dashboard — deadline pressure, capacity, risk — built from the answers, an object nobody designed for this case.",
    prompt:
      "This is for my supervisor, not for the client. She has eighty open matters and needs to see " +
      "at a glance which ones are about to blow up. For this one: how many days until the deadline, " +
      "how much preparation is still needed, whether we have a conflict, and how bad the outcome " +
      "would be if we drop it. Show it as one screen, not a memo.",
  },
];

export function pickPrompt(seen: string[]): string {
  const pool = EXAMPLE_PROMPTS.map((p) => p.prompt).filter((p) => !seen.includes(p));
  const list = pool.length ? pool : EXAMPLE_PROMPTS.map((p) => p.prompt);
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * One invented request from a person who does not know how to fill in forms.
 *
 * Deliberately a separate, tiny call rather than a mode of `draftPlan`: it
 * returns only prose, so it can never accidentally build a plan, and it is
 * cheap enough to press repeatedly. The output is treated as untrusted text —
 * it goes into the compose box, and the visitor decides whether to send it.
 */
const REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["request", "persona", "domain"],
  properties: {
    request: { type: "string" },
    persona: { type: "string" },
    domain: {
      type: "string",
      enum: PRACTICES.map((p) => p.id),
    },
  },
} as const;

const REQUEST_SYSTEM = `You write one short, realistic message from a member of the public who needs legal help but does not understand legal forms or process.

Rules:
- 60-110 words, first person, plain language. No headings, no lists, no legal jargon unless the person would mis-use it.
- The person does NOT know what to call their problem. They describe events, dates, documents and feelings, not legal categories.
- Include 2-4 concrete facts (a date, a number of children, an amount paid, a deadline) and at least one thing they are confused or worried about.
- Include one small inconsistency, missing detail, or misunderstanding that a careful intake would need to resolve.
- Never mention forms, fields, schemas, or this lab. Never give legal advice.
- Use fictional details only. Do not use real names of people, courts or agencies.
- Do not resolve the story; end while the person is still unsure what to do.`;

export type RandomRequest = { request: string; persona: string; domain: string };

/** Ask the model for one new request. Falls back to a curated example on failure. */
export async function inventRequest(seen: string[] = []): Promise<RandomRequest & { source: "ai" | "fallback" }> {
  const transcript: Chat[] = [
    { role: "system", content: REQUEST_SYSTEM },
    {
      role: "user",
      content: seen.length
        ? `Write a new one. Do not reuse these situations:\n${seen.slice(-6).map((s) => `- ${s.slice(0, 90)}`).join("\n")}`
        : "Write one.",
    },
  ];
  try {
    const response = await (await client()).chat.completions.create({
      model: MODEL,
      max_completion_tokens: 400,
      messages: transcript as never,
      response_format: {
        type: "json_schema",
        json_schema: { name: "legal_request", strict: false, schema: REQUEST_SCHEMA as never },
      },
    });
    const text = response.choices?.[0]?.message?.content ?? "";
    const raw = JSON.parse(text) as Record<string, unknown>;
    const request = typeof raw.request === "string" ? raw.request.trim() : "";
    if (!request) throw new Error("empty request");
    const domain = PRACTICES.some((p) => p.id === raw.domain) ? String(raw.domain) : "legal-aid";
    return {
      request,
      persona: typeof raw.persona === "string" ? raw.persona.trim() : "a member of the public",
      domain,
      source: "ai",
    };
  } catch {
    // Never leave the button dead: hand back a curated prompt instead.
    const pick = EXAMPLE_PROMPTS[Math.floor(Math.random() * EXAMPLE_PROMPTS.length)];
    return {
      request: pick.prompt,
      persona: "a member of the public",
      domain: pick.practiceId ?? "legal-aid",
      source: "fallback",
    };
  }
}
