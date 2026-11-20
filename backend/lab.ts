import { Hono } from "hono";
import { normalizePlan, validateResponse } from "../lab/model.ts";
import { readJsonBody } from "./http_util.ts";

/**
 * Validation endpoint.
 *
 * Val Town isolates do not keep memory between requests, so a plan drafted in
 * one request is not guaranteed to be in a registry here. The client therefore
 * sends the generated plan back with its answer, and the server re-normalises
 * it before validating — the schema still comes from the model's output, but
 * every field is re-checked against the normaliser's rules rather than trusted.
 */
export const labApi = new Hono();

labApi.post("/plans/:id/respond", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c);
  if (body === null) return c.json({ error: "invalid JSON body" }, 400);
  const supplied = body.plan;
  if (!supplied || typeof supplied !== "object") {
    return c.json({ error: "plan is required: send the generated plan alongside the response" }, 400);
  }
  const plan = normalizePlan(supplied, String((supplied as Record<string, unknown>).title ?? "plan"));
  if (plan.id !== c.req.param("id")) {
    return c.json({ error: "plan id does not match the requested id" }, 409);
  }
  const ticked = Array.isArray(body.ticked) ? body.ticked.map(String) : [];
  const result = validateResponse(plan, body, ticked);
  return c.json(result, result.valid ? 200 : 422);
});

// This HTTP demo is not an interactive MCP transport: it cannot hold a request
// open waiting for a human. It answers with a pointer to the UI instead of
// fabricating an acceptance.
labApi.post("/rpc", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, 400);
  }
  const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  if (body.method !== "elicitation/create") {
    return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }, 400);
  }
  const params = body.params as Record<string, unknown> | undefined;
  const schema = params?.requestedSchema as Record<string, unknown> | undefined;
  if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
    return c.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "params.requestedSchema.properties is required" } }, 400);
  }
  const base = new URL(c.req.url).origin;
  return c.json({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: "Interactive MCP transport is not implemented; no response was collected.",
      data: { ui_url: `${base}/lab`, respond_url: `${base}/api/lab/plans/{plan.id}/respond` },
    },
  }, 501);
});
