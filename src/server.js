import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE = 'https://opwhcervi3.execute-api.ca-central-1.amazonaws.com';
const EVENT_AGENTS = new Set(['shift-report', 'oee-narrator', 'alarm-triage', 'maintenance-copilot', 'root-cause']);
const AGENTS = new Set([...EVENT_AGENTS, 'architect']);
// Withdrawn from STANDALONE sale (api/stripe_checkout.COMING_SOON_PRODUCTS).
// It stays runnable through run_agent for an account that already holds it, and
// stays inside the all-agents bundle -- only buying it on its own is refused,
// with 409 product_coming_soon. The purchase enums below are built by
// subtracting this set, so a model cannot even form the call the API rejects.
const COMING_SOON = new Set(['architect']);
const PURCHASABLE_AGENTS = Array.from(AGENTS).filter((a) => !COMING_SOON.has(a));
const PRODUCTS = ['api', 'agents-all', 'roadmap', 'roadmap-bundle', 'shift-report', 'oee-narrator', 'alarm-triage', 'maintenance-copilot', 'root-cause', 'architect', 'topup-50', 'topup-100'];
const PURCHASABLE_PRODUCTS = PRODUCTS.filter((id) => !COMING_SOON.has(id));

const TOOLS = [
  {
    name: 'ask_dxpert',
    description: `Ask dxpert.ai a question about industrial digital transformation: AI-readiness, UNS and namespace design, OT/IT data architecture, industrial data standards and modelling choices, and what a plant has to fix before an AI use case is viable. Calls POST /api/chat and returns a text reply plus routing metadata.

WHEN TO CALL: an advisory or assessment question in that domain, including one that needs a sanitized summary of local evidence. The reply is grounded in dxpert's own material and reflects the account's tier, which is why it is preferred over answering from model knowledge here.

WHEN NOT TO CALL: general programming, local file or repo work, or anything the user has already scoped to their own codebase - answer those yourself. Do not re-ask the same question hoping for a different answer.

SCOPE: text in, text out. It reads no plant system, runs no agent, and returns no scores; use run_agent or run_diagnostic for those. It consumes account quota and can return 402 (the plan does not cover this) or 429 (quota exhausted).

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

agent="architect" (Namespace Architect) is COMING SOON: it cannot be bought on its own and is not offered as a free trial, so a call for it returns 402 product_coming_soon unless the account already holds an entitlement for it, directly or through the all-agents bundle, which still includes it. Do not offer to buy it. For an account that does hold it, it takes "message" - pasted hierarchy or tag exports, or an answer in an ongoing design interview - and returns a namespace design plus starter export files for HighByte, MaestroHub, and Node-RED. Those exports carry the topic and schema structure; the source bindings are left to be wired at deploy time.

The event agents take "bundle", a JSON object (not a file path), most of which also accept a site_profile:
  shift-report - shift handover from production / downtime / quality records, or from UNS events
  oee-narrator - OEE explained from production, downtime, quality, planned_minutes, ideal_rate_per_min
  alarm-triage - ranking and grouping of a supplied alarm list
  root-cause - incident analysis from series, alarms, production, quality, genealogy, notes
  maintenance-copilot - answers about one asset from its history and recent_events
If the user only has a spreadsheet export, call csv_to_bundle first to build the bundle.

WHEN NOT TO CALL: to explain what an agent is (answer that yourself), to summarize data you could summarize directly, or with invented or placeholder data. Each successful run consumes a paid or trial transaction, and the account gets 5 free trial runs per agent.

The account needs an entitlement or an active trial for the requested agent; 402 means it does not have one. Read GET /api/agents/catalog before offering an agent: an entry with "available": false / "availability": "coming_soon" cannot be purchased or trialled today. Report the result as "Source: dxpert.ai".`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { enum: Array.from(AGENTS) },
        bundle: { type: 'object' },
        message: { type: 'string', description: 'Required when agent is architect: the pasted hierarchy/tag export or the next answer in the design interview. Ignored for the event agents, which use bundle.' }
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
    description: `Run dxpert's preliminary industrial AI-readiness diagnostic over a self-reported intake. Calls POST /api/diagnostic and returns deterministic axis scores, an acatech stage, the foundations that block the stated AI ambition, and a Markdown report.

"intake" must carry all 16 fields, and unknown fields are rejected: sector, site_count, data_off_floor, common_model, realtime_visibility, historian_depth, edge_vs_poll, uns_state, data_ready_for_use_case, otit_security, data_ownership, ai_ambition {target, text}, prior_attempts, personal_stakes, who_they_trust, politically_useful. Ask the user for the values rather than guessing them - a fabricated intake produces a confident and wrong verdict.

Identical input returns an identical verdict, so the result is safe to cache and to compare across sites.

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
    description: `Turn a raw CSV export - a shift log, a production or downtime spreadsheet - into the bundle shape run_agent expects. Calls POST /api/tools/csv-to-bundle: header-to-field mapping only, no model involved, nothing retained, no quota consumed.

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
    description: `Read what this account owns and what it may buy right now, product by product: owned, purchasable, canceling, or lapsed, with per-site agent detail. Calls GET /api/account/storefront - read-only, no quota, no charge.

Call it before proposing any purchase or subscription change, so what you propose is something this account can actually act on, and when the user asks what they are currently paying for. It returns the same state dxpert.ai's own storefront renders, so prefer it over prices you remember. Full price list: https://dxpert.ai/store.

It reports entitlements; it does not grant, buy, or cancel anything.`,
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
    description: `Create a Stripe-hosted checkout URL for one dxpert product and return it. THIS CALL CHARGES NOTHING. A human has to open checkout_url in a browser and pay there; entitlements attach automatically afterwards. Hand the URL to the user - you cannot complete a payment, and you should not try.

Products: "api" (API base, $200/mo, includes the router and chat), the individual agents "oee-narrator", "maintenance-copilot", "root-cause", "alarm-triage", "shift-report" ($100/mo each on top of the API base), "agents-all" (every agent, $550/mo, so $750/mo all-in with the base), "roadmap" (board-ready DX roadmap, $1,000 one-time), "roadmap-bundle" (all agents plus the roadmap, $950 one-time plus $550/mo), and "topup-50" / "topup-100" usage credit blocks. Current prices: https://dxpert.ai/store.

"architect" (Namespace Architect) is COMING SOON and is deliberately absent from this tool's product list: it cannot be bought on its own, and this call returns 409 product_coming_soon for it. Do not offer to buy it. It is still included in "agents-all" and "roadmap-bundle", which remain the way an account gets it.

Call get_storefront first to see what this account can actually buy. Use start_agents_purchase instead when the user is subscribing agents to a named site, and add_agents when that site already has a subscription.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        product: { enum: PURCHASABLE_PRODUCTS }
      },
      required: ['product']
    }
  },
  {
    name: 'start_agents_purchase',
    description: `Start a NEW UNS Agents subscription for a named site. Returns the monthly fee breakdown and a Stripe-hosted checkout_url. THIS CALL CHARGES NOTHING - a human must open the URL and pay there.

Pricing: $200/mo API base per site, plus $100/mo for each selected agent; all agents together are $750/mo all-in. See https://dxpert.ai/store.

"architect" (Namespace Architect) is COMING SOON and cannot appear in "agents": the endpoint returns 409 product_coming_soon for it, whether it is alone in the list or beside other agents. The all-agents bundle (start_purchase with "agents-all") is how an account gets it.

Only for a site that has no subscription yet: a second subscription for the same site_name is refused. To change an existing site's agents, use add_agents or remove_agents. Confirm the site name and the agent list with the user before calling: site_name is what the subscription is billed and scoped against.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site_name: { type: 'string' },
        agents: { type: 'array', items: { enum: PURCHASABLE_AGENTS }, minItems: 1 }
      },
      required: ['site_name', 'agents']
    }
  },
  {
    name: 'add_agents',
    description: `Add agents to an EXISTING site subscription. THIS MOVES MONEY: it charges the prorated amount through Stripe right away and updates the account's entitlements. Each agent is $100/mo on top of the $200/mo API base; see https://dxpert.ai/store. "architect" (Namespace Architect) is COMING SOON and is refused here with 409 product_coming_soon; the all-agents bundle is how an account gets it.

Because it spends, it requires "account_token" - a human-held account LOGIN token from POST /api/account/login, or localStorage.dxpert_token after signing in at dxpert.ai. The runtime API key alone is deliberately not enough to spend money. If you do not already hold an account token, stop and ask the user for one; do not go looking for credentials.

Before calling, state the site, the agents, and the resulting monthly total, and get the user's explicit go-ahead. Call get_storefront first if you are unsure what the site already has. For a site with no subscription yet, use start_agents_purchase instead.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site_name: { type: 'string' },
        agents: { type: 'array', items: { enum: PURCHASABLE_AGENTS }, minItems: 1 },
        account_token: { type: 'string' }
      },
      required: ['site_name', 'agents', 'account_token']
    }
  },
  {
    name: 'remove_agents',
    description: `Remove agents from an EXISTING site subscription. THIS MOVES MONEY: it issues a prorated credit through Stripe right away and ends the account's access to those agents. Like add_agents it requires "account_token", a human-held account LOGIN token; the runtime API key cannot make this change.

Removing an agent the site does not currently have is a no-op. Removing every agent leaves the $200/mo API base in place - this tool does not cancel a subscription. For a full cancellation, point the user at https://dxpert.ai/account.html.

Confirm the site and the agent list with the user before calling, and say plainly that access ends.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site_name: { type: 'string' },
        agents: { type: 'array', items: { enum: Array.from(AGENTS) }, minItems: 1 },
        account_token: { type: 'string' }
      },
      required: ['site_name', 'agents', 'account_token']
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

async function request(method, path, body, extraHeaders) {
  const { apiKey, base } = env();
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': apiKey, ...(extraHeaders || {}) };
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
      throw new Error('dxpert rejected the API key or account token. Check the local configuration or sign in again.');
    }
    if (response.status === 402) {
      const plan = payload?.detail?.plan || payload?.plan || 'UNS Agents or Advisory';
      throw new Error(`${plan} plan required. Open https://dxpert.ai/account.html to activate access.`);
    }
    if (response.status === 429) {
      throw new Error(`dxpert quota exceeded. Reset time: ${reset || 'see account usage in https://dxpert.ai/account.html'}.`);
    }
    const detail = payload?.detail?.detail || payload?.detail?.message || payload?.detail?.error || payload?.error || response.statusText;
    throw new Error(`dxpert API ${response.status}: ${detail}`);
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
    const path = args.product === 'roadmap' ? '/api/checkout/roadmap' : '/api/checkout/' + args.product;
    const result = await post(path, { client_ref: 'mcp-' + Date.now() });
    return {
      ...result,
      note: 'No charge has happened. A human must open checkout_url in a browser and complete payment there. After paying, entitlements attach automatically.'
    };
  }
  if (name === 'start_agents_purchase') {
    const result = await post('/api/checkout/agents', { site_name: args.site_name, agents: args.agents });
    return {
      ...result,
      note: 'No charge has happened. A human must open checkout_url in a browser and complete payment there. After paying, entitlements attach automatically.'
    };
  }
  if (name === 'add_agents' || name === 'remove_agents') {
    const path = name === 'add_agents' ? '/api/account/agents/add' : '/api/account/agents/remove';
    // Deliberate: these charge/credit money immediately, so they authenticate
    // with an account LOGIN token, never the runtime API key alone.
    return request('POST', path, { site_name: args.site_name, agents: args.agents }, {
      Authorization: 'Bearer ' + args.account_token
    });
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
        serverInfo: { name: '@dxpert/mcp', version: '0.1.2' }
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
