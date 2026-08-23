import assert from 'assert';
import fs from 'fs';
import http from 'http';
import { spawn } from 'child_process';
import { once } from 'events';

let seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], auth: req.headers['authorization'], body: JSON.parse(body || '{}') });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/chat') res.end(JSON.stringify({ reply: 'hello', scope: 'preliminary' }));
    else if (req.url?.startsWith('/api/agents/')) res.end(JSON.stringify({ report_markdown: 'agent ok' }));
    else if (req.url === '/api/architect') res.end(JSON.stringify({ reply: 'architect ok' }));
    else if (req.url === '/api/diagnostic') res.end(JSON.stringify({ scores: { axes: {}, acatech_stage: 1, ai_readiness_gate: [], confidence: 0.8 }, report_markdown: 'diag ok' }));
    else if (req.url === '/api/tools/csv-to-bundle') res.end(JSON.stringify({ bundle: { production: [] }, mapped_columns: {}, unmapped_columns: [], warnings: [] }));
    else if (req.url === '/api/account/storefront') res.end(JSON.stringify({ products: { roadmap: { state: 'purchasable' } } }));
    else if (req.url === '/api/checkout/roadmap') res.end(JSON.stringify({ checkout_url: 'https://checkout.stripe.com/c/pay/cs_mcp_roadmap' }));
    else if (req.url === '/api/checkout/agents') res.end(JSON.stringify({ checkout_url: 'https://checkout.stripe.com/c/pay/cs_mcp_agents', fee_breakdown: [], total_monthly_usd: 940 }));
    else if (req.url === '/api/account/agents/add') res.end(JSON.stringify({ updated_agents: ['shift-report', 'oee-narrator'], fee_breakdown: [], total_monthly_usd: 940 }));
    else { res.statusCode = 404; res.end(JSON.stringify({ error: 'not_found' })); }
  });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

const child = spawn(process.execPath, ['bin/dxpert-mcp.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, DXPERT_API_KEY: 'dxp_test_key', DXPERT_API_BASE: `http://127.0.0.1:${port}` },
  stdio: ['pipe', 'pipe', 'inherit']
});

let buffer = Buffer.alloc(0);
const replies = [];
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const marker = buffer.indexOf('\r\n\r\n');
    if (marker < 0) return;
    const header = buffer.slice(0, marker).toString('ascii');
    const len = Number(/content-length:\s*(\d+)/i.exec(header)[1]);
    const start = marker + 4;
    if (buffer.length < start + len) return;
    replies.push(JSON.parse(buffer.slice(start, start + len).toString('utf8')));
    buffer = buffer.slice(start + len);
  }
});

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

async function nextReply() {
  for (let i = 0; i < 50; i++) {
    if (replies.length) return replies.shift();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for MCP reply');
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
let r = await nextReply();
assert.strictEqual(r.result.serverInfo.name, '@dxpert/mcp');

send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
r = await nextReply();
assert.deepStrictEqual(r.result.tools.map((t) => t.name).sort(), ['add_agents', 'ask_dxpert', 'csv_to_bundle', 'get_runtime_manifest', 'get_storefront', 'remove_agents', 'run_agent', 'run_diagnostic', 'start_agents_purchase', 'start_purchase']);
const startPurchase = r.result.tools.find((tool) => tool.name === 'start_purchase');
assert.deepStrictEqual(startPurchase.inputSchema.properties.product.enum, ['api', 'agents-all', 'roadmap', 'roadmap-bundle', 'shift-report', 'oee-narrator', 'alarm-triage', 'maintenance-copilot', 'root-cause', 'architect', 'topup-50', 'topup-100']);

send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_dxpert', arguments: { question: 'What next?' } } });
assert.match((await nextReply()).result.content[0].text, /hello/);

send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_agent', arguments: { agent: 'shift-report', bundle: { site_profile: {} } } } });
assert.match((await nextReply()).result.content[0].text, /agent ok/);

send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_agent', arguments: { agent: 'architect', message: 'How should we structure our namespace?' } } });
assert.match((await nextReply()).result.content[0].text, /architect ok/);

send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'run_diagnostic', arguments: { intake: { sector: 'discrete_mfg' } } } });
assert.match((await nextReply()).result.content[0].text, /diag ok/);

send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'csv_to_bundle', arguments: { kind: 'shift-report', csv_text: 'timestamp,cell\n2026-07-04T01:00:00,press-1\n' } } });
assert.match((await nextReply()).result.content[0].text, /mapped_columns/);

send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_storefront', arguments: {} } });
assert.match((await nextReply()).result.content[0].text, /purchasable/);

send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'start_purchase', arguments: { product: 'roadmap' } } });
let purchase = (await nextReply()).result.content[0].text;
assert.match(purchase, /cs_mcp_roadmap/);
assert.match(purchase, /A human must open checkout_url/);

send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'start_agents_purchase', arguments: { site_name: 'Riverside', agents: ['shift-report'] } } });
assert.match((await nextReply()).result.content[0].text, /cs_mcp_agents/);

send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'add_agents', arguments: { site_name: 'Riverside', agents: ['oee-narrator'], account_token: 'tok_login_123' } } });
assert.match((await nextReply()).result.content[0].text, /updated_agents/);

assert.strictEqual(seen.length, 9);
assert.ok(seen.every((call) => call.key === 'dxp_test_key'));
assert.strictEqual(seen[0].url, '/api/chat');
assert.strictEqual(seen[1].url, '/api/agents/shift-report');
assert.strictEqual(seen[2].url, '/api/architect');
assert.deepStrictEqual(seen[2].body, { message: 'How should we structure our namespace?' });
assert.strictEqual(seen[3].url, '/api/diagnostic');
assert.strictEqual(seen[4].url, '/api/tools/csv-to-bundle');
assert.strictEqual(seen[5].url, '/api/account/storefront');
assert.strictEqual(seen[6].url, '/api/checkout/roadmap');
assert.strictEqual(seen[7].url, '/api/checkout/agents');
assert.strictEqual(seen[8].url, '/api/account/agents/add');
// Money-moving call carries the account LOGIN token, not just the API key.
assert.strictEqual(seen[8].auth, 'Bearer tok_login_123');
assert.ok(!seen[6].auth && !seen[7].auth, 'start-purchase calls must not need a login token');

const childExit = once(child, 'exit');
child.kill();
await childExit;

const packageDir = new URL('..', import.meta.url);
const configPath = new URL('dxpert.config.test.json', packageDir);
fs.writeFileSync(configPath, JSON.stringify({
  api_base: `http://127.0.0.1:${port}`,
  api_key: 'dxp_config_file_key'
}));

const configChild = spawn(process.execPath, ['bin/dxpert-mcp.js'], {
  cwd: packageDir,
  env: {
    ...process.env,
    DXPERT_API_KEY: '',
    DXPERT_API_BASE: '',
    DXPERT_CONFIG_FILE: 'dxpert.config.test.json'
  },
  stdio: ['pipe', 'pipe', 'inherit']
});

let configBuffer = Buffer.alloc(0);
const configReplies = [];
configChild.stdout.on('data', (chunk) => {
  configBuffer = Buffer.concat([configBuffer, chunk]);
  while (true) {
    const marker = configBuffer.indexOf('\r\n\r\n');
    if (marker < 0) return;
    const header = configBuffer.slice(0, marker).toString('ascii');
    const len = Number(/content-length:\s*(\d+)/i.exec(header)[1]);
    const start = marker + 4;
    if (configBuffer.length < start + len) return;
    configReplies.push(JSON.parse(configBuffer.slice(start, start + len).toString('utf8')));
    configBuffer = configBuffer.slice(start + len);
  }
});

function sendConfig(message) {
  const body = Buffer.from(JSON.stringify(message));
  configChild.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  configChild.stdin.write(body);
}

async function nextConfigReply() {
  for (let i = 0; i < 50; i++) {
    if (configReplies.length) return configReplies.shift();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for config-file MCP reply');
}

sendConfig({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_storefront', arguments: {} } });
assert.match((await nextConfigReply()).result.content[0].text, /purchasable/);
assert.strictEqual(seen[9].key, 'dxp_config_file_key');

const configChildExit = once(configChild, 'exit');
configChild.kill();
await configChildExit;
fs.unlinkSync(configPath);
server.close();
console.log('ok - MCP handshake and commerce/architect tools passed');
