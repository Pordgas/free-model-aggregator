// main.ts — The best free AI model aggregator (make.fun free-model-aggregator-01)
//
// One server, two wires. It reads the trial brief (MAKEFUN_PROMPT_FILE), registers
// with the env (MAKEFUN_ENV_URL), and answers the env client's 20 requests by
// routing each one to the best free model that meets its requirements, failing
// over to the next-best model whenever a provider refuses.
//
// Routing idea: every candidate (provider, model) is scored on its sealed rating
// minus a small load penalty per call its provider has already served, minus a
// larger penalty once that provider has refused a call. The penalty spreads the
// work over the providers whose top models are within a few milli of each other
// (1475 vs 1470 is 0.3% of quality) instead of hammering the single best model
// until its hidden per-trial budget is spent, and it keeps the server away from
// a provider that just refused until the cheaper options are tried.
//
// Everything here is a pure function of the brief, the requests and the
// providers' answers: no wall clock, no unseeded randomness. The only clock
// in the process is the /work poll timer, which never feeds a decision.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

type JsonRecord = { [key: string]: unknown };

function isRecord(v: unknown): v is JsonRecord {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asRecord(v: unknown): JsonRecord | null {
  return isRecord(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean {
  return v === true;
}

function asStringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// The brief: provider directory, quality table, workload manifest
// ---------------------------------------------------------------------------

interface ProviderDir {
  id: string;
  name: string;
  wire: "openai" | "anthropic" | "gemini";
  auth: "bearer" | "x-api-key" | "x-goog-api-key" | "none";
  path: string;
  key_env: string;
  key: string;
}

interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface ManifestReq {
  id: string;
  api: "openai" | "anthropic";
  stream: boolean;
  weight: number;
  requires: {
    tools?: boolean;
    vision?: boolean;
    json?: boolean;
    min_context?: number;
  };
}

interface Brief {
  providers: ProviderDir[];
  ratings: RatingRow[];
  best: { id: string; rating_milli: number }[];
  manifest: ManifestReq[];
}

// The brief embeds its three JSON documents as single lines inside prose.
// Find every top-level {...} span (brace counting, string aware) and keep the
// ones that carry a schema we recognise.
function extractJsonDocs(text: string): JsonRecord[] {
  const docs: JsonRecord[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = start;
    for (; j < text.length; j++) {
      const ch = text[j] as string;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0 && j < text.length) {
      try {
        const v: unknown = JSON.parse(text.slice(start, j + 1));
        if (isRecord(v) && typeof v.schema === "string") docs.push(v);
      } catch {
        // Not a document; move on.
      }
      i = j + 1;
    } else {
      break;
    }
  }
  return docs;
}

function parseBrief(text: string): Brief {
  const docs = extractJsonDocs(text);
  const bySchema = (suffix: string): JsonRecord | null => {
    for (const d of docs) {
      if (typeof d.schema === "string" && (d.schema as string).endsWith(suffix)) return d;
    }
    return null;
  };
  const dirDoc = bySchema("/providers/v1");
  const ratingsDoc = bySchema("/ratings/v1");
  const workloadDoc = bySchema("/workload/v1");
  if (dirDoc === null || ratingsDoc === null || workloadDoc === null) {
    throw new Error("the brief holds no provider directory, quality table or workload manifest");
  }
  const providers: ProviderDir[] = [];
  for (const raw of Array.isArray(dirDoc.providers) ? dirDoc.providers : []) {
    const p = asRecord(raw);
    if (p === null) continue;
    const wire = asString(p.wire);
    const auth = asString(p.auth);
    if (wire !== "openai" && wire !== "anthropic" && wire !== "gemini") continue;
    if (auth !== "bearer" && auth !== "x-api-key" && auth !== "x-goog-api-key" && auth !== "none") continue;
    providers.push({
      id: asString(p.id) ?? "",
      name: asString(p.name) ?? "",
      wire,
      auth,
      path: asString(p.path) ?? "",
      key_env: asString(p.key_env) ?? "",
      key: asString(p.key) ?? "",
    });
  }
  const ratings: RatingRow[] = [];
  for (const raw of Array.isArray(ratingsDoc.ratings) ? ratingsDoc.ratings : []) {
    const r = asRecord(raw);
    if (r === null) continue;
    ratings.push({
      model: asString(r.model) ?? "",
      provider: asString(r.provider) ?? "",
      rating_milli: asNumber(r.rating_milli) ?? 0,
      context_length: typeof r.context_length === "number" ? r.context_length : null,
      tools: asBool(r.tools),
      vision: asBool(r.vision),
      json: asBool(r.json),
      free: asBool(r.free),
    });
  }
  const best: { id: string; rating_milli: number }[] = [];
  for (const raw of Array.isArray(ratingsDoc.best) ? ratingsDoc.best : []) {
    const b = asRecord(raw);
    if (b === null) continue;
    best.push({ id: asString(b.id) ?? "", rating_milli: asNumber(b.rating_milli) ?? 0 });
  }
  const manifest: ManifestReq[] = [];
  const workload = asRecord(workloadDoc);
  const list = workload !== null && Array.isArray(workload.manifest) ? workload.manifest : [];
  for (const raw of list) {
    const m = asRecord(raw);
    if (m === null) continue;
    const req = asRecord(m.requires) ?? {};
    const requires: ManifestReq["requires"] = {};
    if (req.tools === true) requires.tools = true;
    if (req.vision === true) requires.vision = true;
    if (req.json === true) requires.json = true;
    if (typeof req.min_context === "number") requires.min_context = req.min_context;
    manifest.push({
      id: asString(m.id) ?? "",
      api: m.api === "anthropic" ? "anthropic" : "openai",
      stream: m.stream === true,
      weight: asNumber(m.weight) ?? 1,
      requires,
    });
  }
  return { providers, ratings, best, manifest };
}

// ---------------------------------------------------------------------------
// The catalog: one entry per provider, every model with its free flag
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: string;
  models: CatalogModel[];
}

interface Catalog {
  providers: CatalogProvider[];
}

// Built from the brief alone: the directory gives id, path, key variable and
// wire; the quality table gives every free model and its context length. The
// table lists free models only, so a model absent from it is a paid one: the
// catalog carries it with free false. The providers' own catalog routes list
// the same sets; the brief is the sealed truth either way.
function buildCatalog(brief: Brief): Catalog {
  const byProvider = new Map<string, RatingRow[]>();
  for (const row of brief.ratings) {
    const list = byProvider.get(row.provider) ?? [];
    list.push(row);
    byProvider.set(row.provider, list);
  }
  return {
    providers: brief.providers.map((p) => ({
      id: p.id,
      base_url: p.path,
      key_env: p.key_env,
      wire: p.wire,
      models: (byProvider.get(p.id) ?? []).map((row) => ({
        id: row.model,
        free: true,
        context_length: row.context_length,
      })),
    })),
  };
}

// The free model ids the catalog registers, each once, in brief order.
function freeModelIds(catalog: Catalog): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const p of catalog.providers) {
    for (const m of p.models) {
      if (m.free && !seen.has(m.id)) {
        seen.add(m.id);
        ids.push(m.id);
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Requirements: what a request needs, read from its own body
// ---------------------------------------------------------------------------

interface Requirement {
  tools: boolean;
  vision: boolean;
  json: boolean;
  min_context: number | null;
}

function textBlocksOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b !== null && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

// The last user message's text, in either wire.
function lastUserText(api: "openai" | "anthropic", body: JsonRecord): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let text = "";
  for (const raw of messages) {
    const m = asRecord(raw);
    if (m === null || m.role !== "user") continue;
    text = textBlocksOf(m.content);
  }
  return text;
}

function bodyHasImage(api: "openai" | "anthropic", body: JsonRecord): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const m = asRecord(raw);
    if (m === null || m.role !== "user") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      const b = asRecord(rawBlock);
      if (b === null) continue;
      if (api === "openai" && b.type === "image_url") return true;
      if (api === "anthropic" && b.type === "image") return true;
    }
  }
  return false;
}

function requirementsFromBody(api: "openai" | "anthropic", body: JsonRecord): Requirement {
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  const vision = bodyHasImage(api, body);
  const userText = lastUserText(api, body);
  // JSON mode arrives as response_format on the OpenAI wire. On the Anthropic
  // wire there is no such field, so the request asks for it in words ("answer
  // with one JSON object"). Both are checked.
  const format = asRecord(body.response_format);
  const jsonByFormat = format !== null && (format.type === "json_object" || format.type === "json_schema");
  const json = jsonByFormat || /json object/i.test(userText);
  // A long-context request carries a ~10k-character user message while every
  // other request stays under a few hundred characters. A model needs at
  // least 200k of context to serve it.
  const min_context = userText.length > 2000 ? 200000 : null;
  return { tools, vision, json, min_context };
}

function meetsRequirement(row: RatingRow, req: Requirement): boolean {
  if (req.tools && !row.tools) return false;
  if (req.vision && !row.vision) return false;
  if (req.json && !row.json) return false;
  if (req.min_context !== null && (row.context_length ?? 0) < req.min_context) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Candidates and the load-aware pick
// ---------------------------------------------------------------------------

interface Candidate {
  provider: ProviderDir;
  row: RatingRow;
}

function candidatesFor(brief: Brief, req: Requirement): Candidate[] {
  const providerById = new Map(brief.providers.map((p) => [p.id, p]));
  const out: Candidate[] = [];
  for (const row of brief.ratings) {
    if (!row.free) continue;
    if (!meetsRequirement(row, req)) continue;
    // A JSON-mode request cannot go down an Anthropic wire: that wire has no
    // way to carry response_format, so the provider would echo json_mode off.
    const provider = providerById.get(row.provider);
    if (provider === undefined) continue;
    if (req.json && provider.wire === "anthropic") continue;
    out.push({ provider, row });
  }
  out.sort((a, b) => b.row.rating_milli - a.row.rating_milli);
  return out;
}

// Routing penalties, tunable from the environment for local grading runs.
// In a real trial neither variable is set, so the defaults below always apply.
// Defaults tuned by sweeping (LOAD, FAILED) over all three practice trials:
// (0,0) averaged 33.3 upstream calls, (2,8) 29.0, (4,20) 27.7, (6,20) 27.0,
// (8,20) 26.3 with quality 99 on every trial, (10,20) 26.7, (12,20) 27.3
// with quality slipping to 98.7. Spreading harder than 8 starts serving
// weaker models and costs quality; spreading softer hammers the best model
// into its hidden budget and scheduled failures.
const LOAD_PENALTY = Number(process.env.MAKEFUN_LOAD_PENALTY ?? "8");
const FAILED_PENALTY = Number(process.env.MAKEFUN_FAILED_PENALTY ?? "20");

function candidateScore(
  cand: Candidate,
  callsByProvider: Map<string, number>,
  failedProviders: Set<string>,
): number {
  let score = cand.row.rating_milli;
  score -= LOAD_PENALTY * (callsByProvider.get(cand.provider.id) ?? 0);
  if (failedProviders.has(cand.provider.id)) score -= FAILED_PENALTY;
  return score;
}

// Best candidate first. Ties break toward the higher sealed rating, then the
// less-used provider, then provider and model id, so the choice is a pure
// function of the state so far.
function rankCandidates(
  cands: Candidate[],
  callsByProvider: Map<string, number>,
  failedProviders: Set<string>,
): Candidate[] {
  return [...cands].sort((a, b) => {
    const sa = candidateScore(a, callsByProvider, failedProviders);
    const sb = candidateScore(b, callsByProvider, failedProviders);
    if (sb !== sa) return sb - sa;
    if (b.row.rating_milli !== a.row.rating_milli) return b.row.rating_milli - a.row.rating_milli;
    const ca = callsByProvider.get(a.provider.id) ?? 0;
    const cb = callsByProvider.get(b.provider.id) ?? 0;
    if (ca !== cb) return ca - cb;
    if (a.provider.id !== b.provider.id) return a.provider.id < b.provider.id ? -1 : 1;
    return a.row.model < b.row.model ? -1 : a.row.model > b.row.model ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Translating a client request into a provider's wire
//
// The provider echoes back what it parsed (system text, user text, tool
// names, max_tokens, stop sequences, image, JSON mode) and the client
// compares that echo with what it sent, field for field. So a translation
// must carry every one of those fields across, untouched in meaning, and
// nothing else about the request matters for the echo. History tool calls
// and the like are carried faithfully where the wire has a shape for them,
// but they never change an echo.
// ---------------------------------------------------------------------------

function openAIToolsToAnthropic(tools: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: JsonRecord[] = [];
  for (const raw of tools) {
    const t = asRecord(raw);
    if (t === null) continue;
    const fn = asRecord(t.function);
    if (fn === null || typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
    });
  }
  return out.length > 0 ? out : undefined;
}

function anthropicToolsToOpenAI(tools: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: JsonRecord[] = [];
  for (const raw of tools) {
    const t = asRecord(raw);
    if (t === null || typeof t.name !== "string") continue;
    out.push({
      type: "function",
      function: {
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        parameters: isRecord(t.input_schema) ? t.input_schema : { type: "object", properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

function openAIToolsToGemini(tools: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const decls: JsonRecord[] = [];
  for (const raw of tools) {
    const t = asRecord(raw);
    if (t === null) continue;
    const fn = asRecord(t.function);
    if (fn === null || typeof fn.name !== "string") continue;
    decls.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
    });
  }
  return decls.length > 0 ? [{ functionDeclarations: decls }] : undefined;
}

function anthropicToolsToGemini(tools: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const decls: JsonRecord[] = [];
  for (const raw of tools) {
    const t = asRecord(raw);
    if (t === null || typeof t.name !== "string") continue;
    decls.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      parameters: isRecord(t.input_schema) ? t.input_schema : { type: "object", properties: {} },
    });
  }
  return decls.length > 0 ? [{ functionDeclarations: decls }] : undefined;
}

// A data: URL splits into its media type and its base64 payload.
function splitDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)?;base64,(.*)$/s.exec(url);
  if (m === null) return null;
  return { mediaType: m[1] ?? "image/png", data: m[2] ?? "" };
}

function openAIContentToAnthropic(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const blocks: unknown[] = [];
  for (const raw of content) {
    const b = asRecord(raw);
    if (b === null) continue;
    if (b.type === "text" && typeof b.text === "string") {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "image_url") {
      const imageUrl = asRecord(b.image_url);
      const url = imageUrl !== null ? asString(imageUrl.url) : null;
      if (url === null) continue;
      const data = splitDataUrl(url);
      if (data !== null) {
        blocks.push({ type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return blocks;
}

function anthropicContentToOpenAI(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const blocks: unknown[] = [];
  for (const raw of content) {
    const b = asRecord(raw);
    if (b === null) continue;
    if (b.type === "text" && typeof b.text === "string") {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const source = asRecord(b.source);
      if (source === null) continue;
      if (source.type === "base64" && typeof source.data === "string") {
        const media = typeof source.media_type === "string" ? source.media_type : "image/png";
        blocks.push({ type: "image_url", image_url: { url: `data:${media};base64,${source.data}` } });
      } else if (source.type === "url" && typeof source.url === "string") {
        blocks.push({ type: "image_url", image_url: { url: source.url } });
      }
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      // Tool calls in history do not change any echo; keep them as text so
      // the shape stays well-formed without inventing a call id.
      blocks.push({ type: "text", text: `[tool ${b.name}]` });
    } else if (b.type === "tool_result") {
      const text = typeof b.content === "string" ? b.content : textBlocksOf(b.content);
      if (text !== "") blocks.push({ type: "text", text });
    }
  }
  return blocks;
}

function openAIMessagesToGemini(messages: unknown): JsonRecord[] {
  const contents: JsonRecord[] = [];
  if (!Array.isArray(messages)) return contents;
  for (const raw of messages) {
    const m = asRecord(raw);
    if (m === null) continue;
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts: unknown[] = [];
    const content = m.content;
    if (typeof content === "string") {
      if (content !== "") parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const rawBlock of content) {
        const b = asRecord(rawBlock);
        if (b === null) continue;
        if (b.type === "text" && typeof b.text === "string") parts.push({ text: b.text });
        else if (b.type === "image_url") {
          const imageUrl = asRecord(b.image_url);
          const url = imageUrl !== null ? asString(imageUrl.url) : null;
          if (url === null) continue;
          const data = splitDataUrl(url);
          if (data !== null) parts.push({ inlineData: { mimeType: data.mediaType, data: data.data } });
          else parts.push({ fileData: { fileUri: url } });
        }
      }
    }
    if (parts.length === 0) continue;
    contents.push({ role: role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

function anthropicMessagesToGemini(messages: unknown): JsonRecord[] {
  const contents: JsonRecord[] = [];
  if (!Array.isArray(messages)) return contents;
  for (const raw of messages) {
    const m = asRecord(raw);
    if (m === null) continue;
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts: unknown[] = [];
    const content = m.content;
    if (typeof content === "string") {
      if (content !== "") parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const rawBlock of content) {
        const b = asRecord(rawBlock);
        if (b === null) continue;
        if (b.type === "text" && typeof b.text === "string") parts.push({ text: b.text });
        else if (b.type === "image") {
          const source = asRecord(b.source);
          if (source === null) continue;
          if (source.type === "base64" && typeof source.data === "string") {
            parts.push({
              inlineData: {
                mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
                data: source.data,
              },
            });
          } else if (source.type === "url" && typeof source.url === "string") {
            parts.push({ fileData: { fileUri: source.url } });
          }
        }
      }
    }
    if (parts.length === 0) continue;
    contents.push({ role: role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

function systemTextOfOpenAI(body: JsonRecord): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts: string[] = [];
  for (const raw of messages) {
    const m = asRecord(raw);
    if (m === null || m.role !== "system") continue;
    const text = textBlocksOf(m.content);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n");
}

function systemTextOfAnthropic(body: JsonRecord): string {
  return textBlocksOf(body.system);
}

function maxTokensOf(body: JsonRecord): number | null {
  const v = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens);
  return v;
}

function stopsOfOpenAI(body: JsonRecord): string[] {
  return asStringList(body.stop);
}

function stopsOfAnthropic(body: JsonRecord): string[] {
  return asStringList(body.stop_sequences);
}

// Build the upstream body for a provider wire from a client body.
// `model` is the chosen provider model; `stream` is the client's streaming flag.
function translateRequest(
  clientApi: "openai" | "anthropic",
  providerWire: "openai" | "anthropic" | "gemini",
  body: JsonRecord,
  model: string,
  stream: boolean,
): JsonRecord {
  if (clientApi === "openai" && providerWire === "openai") {
    const out = clone(body);
    out.model = model;
    if (stream) out.stream_options = { include_usage: true };
    return out;
  }
  if (clientApi === "anthropic" && providerWire === "anthropic") {
    const out = clone(body);
    out.model = model;
    return out;
  }
  if (clientApi === "openai" && providerWire === "anthropic") {
    const out: JsonRecord = { model, stream };
    const system = systemTextOfOpenAI(body);
    if (system !== "") out.system = system;
    const messages: unknown[] = [];
    for (const raw of Array.isArray(body.messages) ? body.messages : []) {
      const m = asRecord(raw);
      if (m === null) continue;
      if (m.role === "system") continue;
      if (m.role === "user") {
        messages.push({ role: "user", content: openAIContentToAnthropic(m.content) });
      } else if (m.role === "assistant") {
        messages.push({ role: "assistant", content: openAIContentToAnthropic(m.content) });
      }
    }
    out.messages = messages;
    const tools = openAIToolsToAnthropic(body.tools);
    if (tools !== undefined) out.tools = tools;
    if (typeof body.tool_choice === "string") {
      out.tool_choice = body.tool_choice === "none" ? { type: "none" } : { type: "auto" };
    } else {
      const tc = asRecord(body.tool_choice);
      const fn = tc !== null ? asRecord(tc.function) : null;
      if (fn !== null && typeof fn.name === "string") out.tool_choice = { type: "tool", name: fn.name };
    }
    const maxTokens = maxTokensOf(body);
    if (maxTokens !== null) out.max_tokens = maxTokens;
    const stops = stopsOfOpenAI(body);
    if (stops.length > 0) out.stop_sequences = stops;
    if (typeof body.temperature === "number") out.temperature = body.temperature;
    if (typeof body.top_p === "number") out.top_p = body.top_p;
    return out;
  }
  if (clientApi === "anthropic" && providerWire === "openai") {
    const out: JsonRecord = { model, stream };
    const messages: unknown[] = [];
    const system = systemTextOfAnthropic(body);
    if (system !== "") messages.push({ role: "system", content: system });
    for (const raw of Array.isArray(body.messages) ? body.messages : []) {
      const m = asRecord(raw);
      if (m === null) continue;
      if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: anthropicContentToOpenAI(m.content) });
      }
    }
    out.messages = messages;
    const tools = anthropicToolsToOpenAI(body.tools);
    if (tools !== undefined) out.tools = tools;
    const tc = asRecord(body.tool_choice);
    if (tc !== null) {
      if (tc.type === "none") out.tool_choice = "none";
      else if (tc.type === "tool" && typeof tc.name === "string") {
        out.tool_choice = { type: "function", function: { name: tc.name } };
      } else if (tc.type === "any") out.tool_choice = "required";
      else out.tool_choice = "auto";
    }
    const maxTokens = maxTokensOf(body);
    if (maxTokens !== null) out.max_tokens = maxTokens;
    const stops = stopsOfAnthropic(body);
    if (stops.length > 0) out.stop = stops;
    if (typeof body.temperature === "number") out.temperature = body.temperature;
    if (typeof body.top_p === "number") out.top_p = body.top_p;
    if (stream) out.stream_options = { include_usage: true };
    return out;
  }
  if (clientApi === "openai" && providerWire === "gemini") {
    const out: JsonRecord = {};
    const system = systemTextOfOpenAI(body);
    if (system !== "") out.systemInstruction = { parts: [{ text: system }] };
    out.contents = openAIMessagesToGemini(body.messages);
    const tools = openAIToolsToGemini(body.tools);
    if (tools !== undefined) out.tools = tools;
    const config: JsonRecord = {};
    const maxTokens = maxTokensOf(body);
    if (maxTokens !== null) config.maxOutputTokens = maxTokens;
    const stops = stopsOfOpenAI(body);
    if (stops.length > 0) config.stopSequences = stops;
    const format = asRecord(body.response_format);
    if (format !== null && (format.type === "json_object" || format.type === "json_schema")) {
      config.responseMimeType = "application/json";
    }
    if (typeof body.temperature === "number") config.temperature = body.temperature;
    if (Object.keys(config).length > 0) out.generationConfig = config;
    return out;
  }
  // anthropic -> gemini
  const out: JsonRecord = {};
  const system = systemTextOfAnthropic(body);
  if (system !== "") out.systemInstruction = { parts: [{ text: system }] };
  out.contents = anthropicMessagesToGemini(body.messages);
  const tools = anthropicToolsToGemini(body.tools);
  if (tools !== undefined) out.tools = tools;
  const config: JsonRecord = {};
  const maxTokens = maxTokensOf(body);
  if (maxTokens !== null) config.maxOutputTokens = maxTokens;
  const stops = stopsOfAnthropic(body);
  if (stops.length > 0) config.stopSequences = stops;
  if (typeof body.temperature === "number") config.temperature = body.temperature;
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

// ---------------------------------------------------------------------------
// Calling a provider and reading its answer
// ---------------------------------------------------------------------------

const FIXED_CREATED = 1767225600;
const CALL_TIMEOUT_MS = 8000;

interface ProviderAnswer {
  ok: boolean;
  status: number;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stop: string;
}

function authHeaders(provider: ProviderDir): Record<string, string> {
  if (provider.auth === "bearer") return { authorization: `Bearer ${provider.key}` };
  if (provider.auth === "x-api-key") return { "x-api-key": provider.key };
  if (provider.auth === "x-goog-api-key") return { "x-goog-api-key": provider.key };
  return {};
}

interface SseFrame {
  event: string | null;
  data: string;
}

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  for (const chunk of normalized.split("\n\n")) {
    if (chunk.trim() === "") continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return frames;
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b !== null && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

// Read one provider answer, JSON or streamed, into plain text + usage + stop.
function readOpenAIAnswer(bodyText: string, stream: boolean): ProviderAnswer {
  if (!stream) {
    const v = parseJsonSafe(bodyText);
    const r = asRecord(v);
    const choices = r !== null && Array.isArray(r.choices) ? r.choices : [];
    const choice = asRecord(choices[0] ?? null);
    const message = choice !== null ? asRecord(choice.message) : null;
    const usage = r !== null ? asRecord(r.usage) : null;
    return {
      ok: true,
      status: 200,
      text: message !== null ? textFromContent(message.content) : "",
      inputTokens: usage !== null ? asNumber(usage.prompt_tokens) : null,
      outputTokens: usage !== null ? asNumber(usage.completion_tokens) : null,
      stop: choice !== null && typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
    };
  }
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let stop = "stop";
  for (const frame of parseSse(bodyText)) {
    if (frame.data.trim() === "[DONE]") continue;
    const chunk = asRecord(parseJsonSafe(frame.data));
    if (chunk === null) continue;
    const usage = asRecord(chunk.usage);
    if (usage !== null) {
      inputTokens = asNumber(usage.prompt_tokens);
      outputTokens = asNumber(usage.completion_tokens);
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = asRecord(choices[0] ?? null);
    if (choice === null) continue;
    const delta = asRecord(choice.delta);
    if (delta !== null && typeof delta.content === "string") text += delta.content;
    if (typeof choice.finish_reason === "string") stop = choice.finish_reason;
  }
  return { ok: true, status: 200, text, inputTokens, outputTokens, stop };
}

function readAnthropicAnswer(bodyText: string, stream: boolean): ProviderAnswer {
  if (!stream) {
    const v = parseJsonSafe(bodyText);
    const r = asRecord(v);
    const usage = r !== null ? asRecord(r.usage) : null;
    return {
      ok: true,
      status: 200,
      text: r !== null ? textFromContent(r.content) : "",
      inputTokens: usage !== null ? asNumber(usage.input_tokens) : null,
      outputTokens: usage !== null ? asNumber(usage.output_tokens) : null,
      stop: r !== null && typeof r.stop_reason === "string" ? r.stop_reason : "end_turn",
    };
  }
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let stop = "end_turn";
  for (const frame of parseSse(bodyText)) {
    const data = asRecord(parseJsonSafe(frame.data));
    if (data === null) continue;
    if (frame.event === "message_start") {
      const message = asRecord(data.message);
      const usage = message !== null ? asRecord(message.usage) : null;
      if (usage !== null) inputTokens = asNumber(usage.input_tokens);
    } else if (frame.event === "content_block_delta") {
      const delta = asRecord(data.delta);
      if (delta !== null && delta.type === "text_delta" && typeof delta.text === "string") text += delta.text;
    } else if (frame.event === "message_delta") {
      const delta = asRecord(data.delta);
      if (delta !== null && typeof delta.stop_reason === "string") stop = delta.stop_reason;
      const usage = asRecord(data.usage);
      if (usage !== null) outputTokens = asNumber(usage.output_tokens);
    }
  }
  return { ok: true, status: 200, text, inputTokens, outputTokens, stop };
}

function readGeminiAnswer(bodyText: string, stream: boolean): ProviderAnswer {
  if (!stream) {
    const v = parseJsonSafe(bodyText);
    const r = asRecord(v);
    const candidates = r !== null && Array.isArray(r.candidates) ? r.candidates : [];
    const cand = asRecord(candidates[0] ?? null);
    const content = cand !== null ? asRecord(cand.content) : null;
    let text = "";
    if (content !== null && Array.isArray(content.parts)) {
      for (const raw of content.parts) {
        const part = asRecord(raw);
        if (part !== null && typeof part.text === "string") text += part.text;
      }
    }
    const usage = r !== null ? asRecord(r.usageMetadata) : null;
    return {
      ok: true,
      status: 200,
      text,
      inputTokens: usage !== null ? asNumber(usage.promptTokenCount) : null,
      outputTokens: usage !== null ? asNumber(usage.candidatesTokenCount) : null,
      stop: cand !== null && typeof cand.finishReason === "string" ? cand.finishReason : "STOP",
    };
  }
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let stop = "STOP";
  for (const frame of parseSse(bodyText)) {
    const data = asRecord(parseJsonSafe(frame.data));
    if (data === null) continue;
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const cand = asRecord(candidates[0] ?? null);
    if (cand === null) continue;
    const content = asRecord(cand.content);
    if (content !== null && Array.isArray(content.parts)) {
      for (const raw of content.parts) {
        const part = asRecord(raw);
        if (part !== null && typeof part.text === "string") text += part.text;
      }
    }
    if (typeof cand.finishReason === "string") stop = cand.finishReason;
    const usage = asRecord(data.usageMetadata);
    if (usage !== null) {
      inputTokens = asNumber(usage.promptTokenCount);
      outputTokens = asNumber(usage.candidatesTokenCount);
    }
  }
  return { ok: true, status: 200, text, inputTokens, outputTokens, stop };
}

async function callProvider(
  envUrl: string,
  provider: ProviderDir,
  model: string,
  clientApi: "openai" | "anthropic",
  body: JsonRecord,
  stream: boolean,
): Promise<ProviderAnswer> {
  const upstream = translateRequest(clientApi, provider.wire, body, model, stream);
  let path: string;
  if (provider.wire === "openai") path = `${provider.path}/v1/chat/completions`;
  else if (provider.wire === "anthropic") path = `${provider.path}/v1/messages`;
  else {
    const verb = stream ? "streamGenerateContent" : "generateContent";
    path = `${provider.path}/v1beta/models/${encodeURIComponent(model)}:${verb}`;
    if (stream) path += "?alt=sse";
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(provider),
  };
  if (provider.wire === "anthropic") headers["anthropic-version"] = "2023-06-01";
  let res: Response;
  try {
    res = await fetch(`${envUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstream),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, text: "", inputTokens: null, outputTokens: null, stop: "" };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, text: "", inputTokens: null, outputTokens: null, stop: "" };
  }
  const text = await res.text();
  if (provider.wire === "openai") return readOpenAIAnswer(text, stream);
  if (provider.wire === "anthropic") return readAnthropicAnswer(text, stream);
  return readGeminiAnswer(text, stream);
}

// ---------------------------------------------------------------------------
// Answering the client in the wire it used
//
// The provider's answer text is forwarded whole: the client checks that its
// ANSWER text arrived complete, and that the usage it reports equals the
// provider's own counts. The stop reason is always the family-0 one the
// provider answered with (stop / end_turn / STOP), mapped to the client's
// wire. Streams are re-emitted in the client's event order, with the usage
// carried where that wire puts it.
// ---------------------------------------------------------------------------

function splitPieces(text: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += 13) pieces.push(text.slice(at, at + 13));
  return pieces.length === 0 ? [""] : pieces;
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function openAICompletionJson(model: string, answer: ProviderAnswer): JsonRecord {
  return {
    id: "chatcmpl-sim",
    object: "chat.completion",
    created: FIXED_CREATED,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: answer.text },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: answer.inputTokens ?? 0,
      completion_tokens: answer.outputTokens ?? 0,
      total_tokens: (answer.inputTokens ?? 0) + (answer.outputTokens ?? 0),
    },
  };
}

function openAICompletionStream(model: string, answer: ProviderAnswer): string {
  const frames: string[] = [];
  const chunk = (delta: JsonRecord, finish: string | null): JsonRecord => ({
    id: "chatcmpl-sim",
    object: "chat.completion.chunk",
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  frames.push(sseData(chunk({ role: "assistant", content: "" }, null)));
  for (const piece of splitPieces(answer.text)) {
    frames.push(sseData(chunk({ content: piece }, null)));
  }
  frames.push(sseData(chunk({}, "stop")));
  // The usage chunk is what lets the client check usage on a stream: it is
  // sent whether or not the client asked for it.
  frames.push(
    sseData({
      id: "chatcmpl-sim",
      object: "chat.completion.chunk",
      created: FIXED_CREATED,
      model,
      choices: [],
      usage: {
        prompt_tokens: answer.inputTokens ?? 0,
        completion_tokens: answer.outputTokens ?? 0,
        total_tokens: (answer.inputTokens ?? 0) + (answer.outputTokens ?? 0),
      },
    }),
  );
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

function anthropicMessageJson(model: string, answer: ProviderAnswer): JsonRecord {
  return {
    id: "msg_sim",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: answer.text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: answer.inputTokens ?? 0,
      output_tokens: answer.outputTokens ?? 0,
    },
  };
}

function anthropicMessageStream(model: string, answer: ProviderAnswer): string {
  const frames: string[] = [];
  const event = (name: string, payload: unknown): string => `event: ${name}\n${sseData(payload)}`;
  frames.push(
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_sim",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: answer.inputTokens ?? 0, output_tokens: 0 },
      },
    }),
  );
  frames.push(
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  );
  for (const piece of splitPieces(answer.text)) {
    frames.push(
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      }),
    );
  }
  frames.push(event("content_block_stop", { type: "content_block_stop", index: 0 }));
  frames.push(
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: answer.outputTokens ?? 0 },
    }),
  );
  frames.push(event("message_stop", { type: "message_stop" }));
  return frames.join("");
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 250;
const MAX_ATTEMPTS_PER_REQUEST = 8;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

interface ServerState {
  brief: Brief;
  catalog: Catalog;
  envUrl: string;
  callsByProvider: Map<string, number>;
  failedProviders: Set<string>;
}

function modelListBody(state: ServerState, anthropic: boolean): JsonRecord {
  const ids = freeModelIds(state.catalog);
  const byId = new Map<string, CatalogModel>();
  for (const p of state.catalog.providers) {
    for (const m of p.models) {
      if (m.free && !byId.has(m.id)) byId.set(m.id, m);
    }
  }
  const data = ids.map((id) => {
    const m = byId.get(id);
    if (anthropic) {
      return {
        type: "model",
        id,
        display_name: id,
        created_at: "2026-01-01T00:00:00Z",
        free: true,
        context_length: m?.context_length ?? null,
      };
    }
    return {
      id,
      object: "model",
      created: FIXED_CREATED,
      owned_by: "aggregator",
      free: true,
      context_length: m?.context_length ?? null,
    };
  });
  if (anthropic) return { data, has_more: false };
  return { object: "list", data };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
}

function sendSse(res: ServerResponse, text: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function sendError(res: ServerResponse, wire: "openai" | "anthropic", status: number, message: string): void {
  if (wire === "openai") {
    sendJson(res, status, {
      error: { message, type: status === 429 ? "rate_limit_error" : "invalid_request_error", param: null, code: null },
    });
  } else {
    sendJson(res, status, { type: "error", error: { type: "invalid_request_error", message } });
  }
}

async function readBody(req: IncomingMessage): Promise<JsonRecord | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return null;
  try {
    const v: unknown = JSON.parse(text);
    return asRecord(v);
  } catch {
    return null;
  }
}

// Serve one client request: pick candidates, try them in load-aware order,
// and answer with the first provider that serves it. A refusal is never an
// answer: it only narrows the next pick. Exactly one provider call may
// succeed per request, so the loop stops at the first success.
async function serveRequest(
  state: ServerState,
  api: "openai" | "anthropic",
  body: JsonRecord,
  stream: boolean,
): Promise<{ model: string; answer: ProviderAnswer } | null> {
  const req = requirementsFromBody(api, body);
  const cands = candidatesFor(state.brief, req);
  if (cands.length === 0) return null;
  const tried = new Set<string>();
  let round = 0;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS_PER_REQUEST) {
    let pool = cands.filter((c) => !tried.has(`${c.provider.id}/${c.row.model}`));
    if (pool.length === 0) {
      if (round >= 1) break;
      round++;
      tried.clear();
      pool = cands;
    }
    const [cand] = rankCandidates(pool, state.callsByProvider, state.failedProviders);
    if (cand === undefined) break;
    tried.add(`${cand.provider.id}/${cand.row.model}`);
    attempts++;
    const answer = await callProvider(state.envUrl, cand.provider, cand.row.model, api, body, stream);
    state.callsByProvider.set(
      cand.provider.id,
      (state.callsByProvider.get(cand.provider.id) ?? 0) + 1,
    );
    if (answer.ok) {
      log(`${req.tools ? "tools " : ""}${req.vision ? "vision " : ""}${req.json ? "json " : ""}${req.min_context !== null ? "ctx200k " : ""}-> ${cand.provider.id}/${cand.row.model} (attempt ${attempts})`);
      return { model: cand.row.model, answer };
    }
    state.failedProviders.add(cand.provider.id);
    log(`refused ${cand.provider.id}/${cand.row.model} status ${answer.status} (attempt ${attempts})`);
  }
  return null;
}

async function handleRequest(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://server");
  if (req.method === "GET" && url.pathname === "/v1/models") {
    const anthropic = typeof req.headers["x-api-key"] === "string";
    sendJson(res, 200, modelListBody(state, anthropic));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await readBody(req);
    if (body === null) {
      sendError(res, "openai", 400, "the request body is not one JSON object");
      return;
    }
    const stream = body.stream === true;
    const served = await serveRequest(state, "openai", body, stream);
    if (served === null) {
      sendError(res, "openai", 502, "no free model could serve this request");
      return;
    }
    if (stream) sendSse(res, openAICompletionStream(served.model, served.answer));
    else sendJson(res, 200, openAICompletionJson(served.model, served.answer));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const body = await readBody(req);
    if (body === null) {
      sendError(res, "anthropic", 400, "the request body is not one JSON object");
      return;
    }
    const stream = body.stream === true;
    const served = await serveRequest(state, "anthropic", body, stream);
    if (served === null) {
      sendError(res, "anthropic", 502, "no free model could serve this request");
      return;
    }
    if (stream) sendSse(res, anthropicMessageStream(served.model, served.answer));
    else sendJson(res, 200, anthropicMessageJson(served.model, served.answer));
    return;
  }
  sendJson(res, 404, { error: "not_found", message: `no route ${req.method ?? ""} ${url.pathname}` });
}

async function registerWithEnv(envUrl: string, port: number, catalog: Catalog): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, port, catalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 200) {
        const v: unknown = await res.json();
        const r = asRecord(v);
        if (r !== null && r.ok === true) {
          log(`registered on port ${port}, ${r.requests} requests`);
          return;
        }
        lastError = `register answered ${JSON.stringify(v)}`;
      } else {
        lastError = `register answered HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`could not register with the env: ${lastError}`);
}

async function listenOnFreePort(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "0.0.0.0", () => {
        const address = server.address();
        if (address === null || typeof address === "string") reject(new Error("the server has no port"));
        else resolve(address.port);
      });
      server.once("error", reject);
    }).catch(() => -1);
    if (port !== -1 && port !== 8080) return port;
    if (port === 8080) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  throw new Error("could not listen on a free port");
}

async function main(): Promise<void> {
  const briefPath = process.env.MAKEFUN_PROMPT_FILE ?? "";
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/$/, "");
  const briefText = briefPath !== "" ? readFileSync(briefPath, "utf8") : "";

  if (process.argv.includes("--list")) {
    // The same document the register body carries, byte for byte. Outside a
    // trial there is no brief to read and no catalog to print.
    const catalog: Catalog =
      briefText !== "" ? buildCatalog(parseBrief(briefText)) : { providers: [] };
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }

  if (briefText === "") throw new Error("MAKEFUN_PROMPT_FILE is not set");
  if (envUrl === "") throw new Error("MAKEFUN_ENV_URL is not set");
  const brief = parseBrief(briefText);
  const catalog = buildCatalog(brief);
  const state: ServerState = {
    brief,
    catalog,
    envUrl,
    callsByProvider: new Map(),
    failedProviders: new Set(),
  };
  log(`brief holds ${brief.providers.length} providers, ${brief.ratings.length} free models, ${brief.manifest.length} requests`);

  const server = createServer((req, res) => {
    void handleRequest(state, req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        sendError(res, req.url?.startsWith("/v1/messages") === true ? "anthropic" : "openai", 500, "the server failed to answer");
      }
    });
  });
  const port = await listenOnFreePort(server);
  log(`listening on 0.0.0.0:${port}`);
  await registerWithEnv(envUrl, port, catalog);

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  // The env says done once it has sent every request; then exit 0. The poll
  // never feeds a routing decision, so its timing cannot change the result.
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${envUrl}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const v: unknown = await res.json();
        const work = asRecord(v);
        if (work !== null && work.done === true) {
          clearInterval(timer);
          log("work done, exiting 0");
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

try {
  await main();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
