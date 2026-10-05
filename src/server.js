import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE = 'https://opwhcervi3.execute-api.ca-central-1.amazonaws.com';
const EVENT_AGENTS = new Set(['shift-report', 'oee-narrator', 'alarm-triage', 'maintenance-copilot', 'root-cause']);
const AGENTS = new Set([...EVENT_AGENTS, 'architect']);
// The two things that can be bought (GET /api/catalog plans, minus the free
// plan, which needs no checkout). Agents are never bought individually: every
// agent is included in dxpert Pro. This list and the start_purchase enum below
// are pinned to the backend catalog by tests/regression/test_kit_tooling.py.
const PRODUCTS = ['pro', 'roadmap'];

const TOOLS = [
  {
    name: 'ask_dxpert',
    description: `Ask dxpert.ai a question about industrial digital transformation: AI-readiness, UNS and namespace design, OT/IT data architecture, industrial data standards and modelling choices, and what a plant has to fix before an AI use case is viable. Calls POST /api/chat and returns a text reply plus routing metadata.

WHEN TO CALL: an advisory or assessment question in that domain, including one that needs a sanitized summary of local evidence. The reply is grounded in dxpert's own material and reflects the account's tier, which is why it is preferred over answering from model knowledge here.

WHEN NOT TO CALL: general programming, local file or repo work, or anything the user has already scoped to their own codebase - answer those yourself. Do not re-ask the same question hoping for a different answer.

SCOPE: text in, text out. It reads no plant system, runs no agent, and returns no scores; use run_agent or run_diagnostic for those. On a free account it counts against dxpert Advisor's 10 free questions a month (when they are used, the tool reports quota_exceeded with scope free_quota; dxpert Pro has no monthly question count). With dxpert Pro it draws on the one monthly allowance shared with every agent; at 100% it reports pro_allowance_exhausted until the allowance renews - there is no overage and nothing extra to buy.

ATTRIBUTION: label an answer taken from this tool "Source: dxpert.ai". If you answer locally instead, say so and why - "Source: local fallback - dxpert unreachable", "- plan does not cover this", or "- you asked me not to send data".`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        history: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { role: { enum: ['user', 'assistant'] }, text: { type: 'string' } },
            required: ['role', 'text']
          }
        }
      },
      required: ['question']
    }
  },
  {
    name: 'run_agent',
    description: `Run one dxpert agent over data YOU supply, and get back a Markdown report. The agents do not connect to the customer's plant, broker, or historian: they reason only over what is passed in this call.

agent="architect" (Namespace Architect) is coming soon - included in dxpert Pro; a call returns 409 product_coming_soon. Do not offer it as available.

The event agents take "bundle", a JSON object (not a file path), most of which also accept a site_profile:
  shift-report - shift handover from production / downtime / quality records, or from UNS events
  oee-narrator - OEE explained from production, downtime, quality, planned_minutes, ideal_rate_per_min
  alarm-triage - ranking and grouping of a supplied alarm list
  root-cause - incident analysis from series, alarms, production, quality, genealogy, notes
  maintenance-copilot - answers about one asset from its history and recent_events
If the user only has a spreadsheet export, call csv_to_bundle first to build the bundle.

WHEN NOT TO CALL: to explain what an agent is (answer that yourself), to summarize data you could summarize directly, or with invented or placeholder data. Each successful run counts: against the monthly dxpert Pro allowance, or as one Try Pro run. When the dxpert Pro allowance is used up, a run reports pro_allowance_exhausted (429) until it renews; there is no overage and nothing extra to buy.

ACCESS: every live agent is included in dxpert Pro. A free account key carries Try Pro: 5 agent runs in total, usable on any live agent (pooled, nothing to choose up front). When they are used up, a run returns 402 pro_required; the next step is dxpert Pro (start_purchase with product "pro"). Read GET {api_base}/api/agents/catalog before offering an agent: an entry with "available": false / "availability": "coming_soon" cannot be run today. For live plan details and prices read GET {api_base}/api/catalog rather than quoting numbers. Report the result as "Source: dxpert.ai".`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { enum: Array.from(AGENTS) },
        bundle: { type: 'object' },
        message: { type: 'string', description: 'Only for agent "architect", which is coming soon (included in dxpert Pro; the call returns 409 product_coming_soon). Ignored for the event agents, which use bundle.' }
      },
      required: ['agent'],
      oneOf: [
        { properties: { agent: { const: 'architect' } }, required: ['message'] },
        { properties: { agent: { enum: Array.from(EVENT_AGENTS) } }, required: ['bundle'] }
      ]
    }
  },
  {
    name: 'run_diagnostic',
    description: `Run dxpert's preliminary industrial AI-readiness diagnostic over a self-reported intake. Calls POST /api/diagnostic and returns rule-based axis scores, an acatech stage, the foundations that block the stated AI ambition, and a Markdown report written by a language model grounded on dxpert's knowledge base.

"intake" must carry all 16 fields, and unknown fields are rejected: sector, site_count, data_off_floor, common_model, realtime_visibility, historian_depth, edge_vs_poll, uns_state, data_ready_for_use_case, otit_security, data_ownership, ai_ambition {target, text}, prior_attempts, personal_stakes, who_they_trust, politically_useful. Ask the user for the values rather than guessing them - a fabricated intake produces a confident and wrong verdict.

Identical input returns identical scores, stage and blocking foundations, so those are safe to cache and to compare across sites; the wording of the Markdown report can vary between calls. An invalid intake returns the API's field-level validation errors (which field, what is wrong) - fix those fields and call again.

SCOPE: it scores what the user reports about a site. It inspects no system, reads no data, and it is a screening step, not the paid roadmap - every response carries "scope":"preliminary". Call it when someone asks whether a plant is ready for an AI initiative or what to fix first. Do not call it to score a company you only know from public information.

Report the result as "Source: dxpert.ai".`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { intake: { type: 'object' } },
      required: ['intake']
    }
  },
  {
    name: 'csv_to_bundle',
    description: `The Spreadsheet-to-agent converter: turn a raw CSV export - a shift log, a production or downtime spreadsheet - into the bundle shape run_agent expects. Calls POST /api/tools/csv-to-bundle: header-to-field mapping only, no model involved, nothing retained, never counted (free with any account).

Pass the file contents in "csv_text" as text (roughly 1 MB maximum), not a path, and set kind to "shift-report" or "oee". Returns the bundle plus mapped_columns, unmapped_columns, and warnings. Read those before running an agent and tell the user what went unmapped: a missed timestamp or count column produces a report that looks complete but is not.

WHEN TO CALL: the user has a spreadsheet and no namespace yet. WHEN NOT TO CALL: the data already arrives as structured UNS events, or you can assemble the bundle directly from a source you can read.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        csv_text: { type: 'string' },
        kind: { enum: ['shift-report', 'oee'] },
        site_profile: { type: 'object' }
      },
      required: ['csv_text', 'kind']
    }
  },
  {
    name: 'get_storefront',
    description: `Read this account's plan and what it may buy right now: its plan ("free" or "pro"), the dxpert Pro state (active, canceling, canceled in period, lapsed, or none), the DX Roadmap purchase state, and the Try Pro runs remaining. Calls GET /api/account/storefront - read-only, no quota, no charge.

Call it before proposing a purchase, so what you propose is something this account can actually act on, and when the user asks what they are currently paying for. It returns the same state dxpert.ai's own store renders. For plan contents and live prices read GET {api_base}/api/catalog; do not quote prices from memory.

It reports state; it does not grant, buy, or cancel anything.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'get_runtime_manifest',
    description: `Read the public dxpert runtime update manifest for a channel ("stable" by default): current version, artifact hashes, and changelog. Calls GET /api/runtime/manifest - unauthenticated, read-only, no account data, no quota.

Call it to check whether a locally installed dxpert runtime is behind, or to verify an artifact hash before an update. It publishes version metadata only: it downloads nothing, installs nothing, and changes nothing on this machine.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { channel: { type: 'string', default: 'stable' } }
    }
  },
  {
    name: 'start_purchase',
    description: `Create a Stripe-hosted checkout URL for one dxpert product and return it. THIS CALL CHARGES NOTHING. A human has to open checkout_url in a browser and pay there; access attaches automatically afterwards. Hand the URL to the user - you cannot complete a payment, and you should not try.

Products:
  "pro" - dxpert Pro, a monthly subscription. Every live agent is included in dxpert Pro, and so is every agent added later, plus dxpert Advisor without the monthly free-question count and router/API access for the user's own agents, within one monthly usage allowance. Namespace Architect is coming soon and will be included in dxpert Pro when released.
  "roadmap" - DX Roadmap, a one-time, human-analyst-led, board-ready plan. Independent of dxpert Pro: it neither requires nor includes it.
There is nothing else to buy: agents are never sold individually. Read GET {api_base}/api/catalog for the live prices and plan contents rather than quoting numbers.

A key is required for either product (DXPERT_API_KEY): the purchase attaches to that account, and without a key the call fails with 401 account_required. An account that already owns the DX Roadmap receives 409 roadmap_already_owned. Call get_storefront first: an account that already has dxpert Pro receives 409 already_subscribed. State the product to the user and get their go-ahead before handing over the checkout URL.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        product: { enum: ['pro', 'roadmap'] }
      },
      required: ['product']
    }
  }
];

function env() {
  const configPath = process.env.DXPERT_CONFIG_FILE || 'dxpert.config.json';
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), configPath), 'utf8'));
  } catch {
    config = {};
  }
  const apiKey = process.env.DXPERT_API_KEY || config.api_key || '';
  if (!apiKey) throw new Error('DXPERT_API_KEY is required. Create a dxp_ key in your dxpert.ai account.');
  return { apiKey, base: (process.env.DXPERT_API_BASE || config.api_base || DEFAULT_BASE).replace(/\/+$/, '') };
}

async function request(method, path, body) {
  const { apiKey, base } = env();
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': apiKey };
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const reset = response.headers.get('x-quota-resets-at') || response.headers.get('retry-after') || payload?.detail?.resets_at || payload?.resets_at;
    if (response.status === 401) {
      if (!apiKey) {
        throw new Error('This needs a dxpert account. Set DXPERT_API_KEY (create a free key at https://dxpert.ai/store/account) and try again.');
      }
      throw new Error('dxpert rejected the API key. Check the local configuration, or create a free key at https://dxpert.ai/store/account.');
    }
    if (response.status === 402) {
      const message = payload?.detail?.message || payload?.message;
      throw new Error(message || 'This needs dxpert Pro. See https://dxpert.ai/store/product/pro, or call start_purchase with product "pro".');
    }
    if (response.status === 429) {
      const code = payload?.detail?.error || payload?.error;
      const when = reset || 'see account usage in https://dxpert.ai/store/account';
      if (code === 'pro_allowance_exhausted') {
        throw new Error(`dxpert Pro monthly allowance used up (pro_allowance_exhausted). It renews at: ${when}. There is no overage and nothing extra to buy.`);
      }
      const scope = payload?.detail?.scope ? ` (${payload.detail.scope})` : '';
      throw new Error(`dxpert quota exceeded${scope}. Reset time: ${when}.`);
    }
    if (response.status === 422 && Array.isArray(payload?.detail)) {
      // FastAPI validation errors: name each field and what is wrong with it,
      // so the caller can fix the input instead of guessing.
      const fields = payload.detail.map((item) => {
        const loc = Array.isArray(item?.loc) ? item.loc.filter((part) => part !== 'body').join('.') : '';
        return `${loc || 'body'}: ${item?.msg || item?.type || 'invalid'}`;
      });
      throw new Error(`dxpert API 422: invalid input - ${fields.join('; ')}`);
    }
    const detail = payload?.detail?.detail || payload?.detail?.message || payload?.message || payload?.detail?.error || payload?.error || response.statusText;
    const code = payload?.detail?.error || payload?.error;
    throw new Error(`dxpert API ${response.status}${code && code !== detail ? ` ${code}` : ''}: ${detail}`);
  }
  return payload;
}

async function post(path, body) {
  return request('POST', path, body);
}

async function callTool(name, args) {
  if (name === 'ask_dxpert') {
    return post('/api/chat', { message: args.question, history: args.history || [] });
  }
  if (name === 'run_agent') {
    if (!AGENTS.has(args.agent)) throw new Error('agent must be one of: ' + Array.from(AGENTS).join(', '));
    if (args.agent === 'architect') {
      if (!args.message) throw new Error('message is required for architect');
      return post('/api/architect', { message: args.message });
    }
    return post('/api/agents/' + args.agent, args.bundle || {});
  }
  if (name === 'run_diagnostic') {
    return post('/api/diagnostic', args.intake || {});
  }
  if (name === 'csv_to_bundle') {
    return post('/api/tools/csv-to-bundle', {
      csv_text: args.csv_text,
      kind: args.kind,
      site_profile: args.site_profile
    });
  }
  if (name === 'get_storefront') {
    return request('GET', '/api/account/storefront');
  }
  if (name === 'get_runtime_manifest') {
    return request('GET', '/api/runtime/manifest?channel=' + encodeURIComponent(args.channel || 'stable'));
  }
  if (name === 'start_purchase') {
    if (!PRODUCTS.includes(args.product)) throw new Error('product must be one of: ' + PRODUCTS.join(', '));
    const result = await post('/api/checkout/' + args.product, { client_ref: 'mcp-' + Date.now() });
    return {
      ...result,
      note: 'No charge has happened. A human must open checkout_url in a browser and complete payment there. After paying, access attaches automatically.'
    };
  }
  throw new Error('unknown tool: ' + name);
}

// MCP stdio is newline-delimited JSON. Content-Length (LSP-style) framing is
// still accepted for older clients; each reply uses the framing of its request.
function encode(message, framing = 'line') {
  const json = JSON.stringify(message);
  if (framing === 'line') return json + '\n';
  const body = Buffer.from(json, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

const WHITESPACE = new Set([0x09, 0x0a, 0x0d, 0x20]);

// Pops one complete message off the front of `buffer`, or returns null if it
// is not all here yet. A message starting with `{` is newline-delimited.
function nextMessage(buffer) {
  let start = 0;
  while (start < buffer.length && WHITESPACE.has(buffer[start])) start++;
  if (start === buffer.length) return { raw: null, rest: Buffer.alloc(0) };
  if (buffer[start] === 0x7b) {
    const end = buffer.indexOf(0x0a, start);
    if (end < 0) return null;
    return { raw: buffer.slice(start, end).toString('utf8'), rest: buffer.slice(end + 1), framing: 'line' };
  }
  const marker = buffer.indexOf('\r\n\r\n', start);
  if (marker < 0) return null;
  const header = buffer.slice(start, marker).toString('ascii');
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) throw new Error('missing Content-Length header');
  const bodyStart = marker + 4;
  const bodyEnd = bodyStart + Number(match[1]);
  if (buffer.length < bodyEnd) return null;
  return { raw: buffer.slice(bodyStart, bodyEnd).toString('utf8'), rest: buffer.slice(bodyEnd), framing: 'header' };
}

function content(result) {
  const text = result?.report_markdown || result?.reply || JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text }] };
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(message) {
  if (message.id === undefined || message.id === null) return null;
  try {
    if (message.method === 'initialize') {
      return response(message.id, {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { version: '0.2.0', name: '@dxpert/mcp' }
      });
    }
    if (message.method === 'tools/list') return response(message.id, { tools: TOOLS });
    if (message.method === 'tools/call') {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      return response(message.id, content(result));
    }
    return errorResponse(message.id, -32601, 'method not found');
  } catch (err) {
    return errorResponse(message.id, -32000, err instanceof Error ? err.message : String(err));
  }
}

export function startServer(input = process.stdin, output = process.stdout) {
  let buffer = Buffer.alloc(0);
  let framing = 'line';
  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain().catch((err) => {
      output.write(encode(errorResponse(null, -32000, err instanceof Error ? err.message : String(err)), framing));
    });
  });

  async function drain() {
    while (true) {
      const next = nextMessage(buffer);
      if (!next) return;
      buffer = next.rest;
      if (next.raw === null) return;
      framing = next.framing;
      const reply = await handle(JSON.parse(next.raw));
      if (reply) output.write(encode(reply, next.framing));
    }
  }
}
