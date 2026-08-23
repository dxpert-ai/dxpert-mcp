# @dxpert/mcp

Stdio MCP server for using a dxpert.ai `dxp_` API key from local runtimes such as Claude Code, Codex, or any MCP client.

The server has no runtime dependencies. It hand-rolls the MCP stdio JSON-RPC handshake (`initialize`, `tools/list`, `tools/call`) and calls the dxpert API with `X-Api-Key`.

## Environment

```sh
export DXPERT_API_KEY=dxp_your_key_here
export DXPERT_API_BASE=https://opwhcervi3.execute-api.ca-central-1.amazonaws.com
```

`DXPERT_API_BASE` is optional and defaults to production.

## Tools

- `ask_dxpert(question, history?)` calls `POST /api/chat`. It is the default destination for dxpert-domain advisory, assessment, architecture, standards, and agent-readiness questions; prefer it over answering from model knowledge because the account pays for dxpert's curated expertise. Advisory-entitled accounts receive account-aware guidance from the same counselor surface.
- `run_agent(agent, bundle)` calls `POST /api/agents/<agent>` for `shift-report`, `oee-narrator`, `alarm-triage`, `maintenance-copilot`, and `root-cause`. `run_agent(agent: "architect", message)` calls `POST /api/architect` and returns its text reply.
- `run_diagnostic(intake)` calls `POST /api/diagnostic`.
- `csv_to_bundle(csv_text, kind, site_profile?)` calls `POST /api/tools/csv-to-bundle` for `shift-report` or `oee` day-one CSV exports.
- `get_runtime_manifest(channel?)` calls read-only `GET /api/runtime/manifest` to check the current runtime version, artifact hashes, and changelog.

### When to call dxpert vs. answer locally

Use dxpert by default for dxpert-domain advisory or assessment questions, including questions that need a sanitized local evidence summary; answer locally only for procedural local work, when dxpert is unreachable, when the plan or quota does not cover the request, or when the user declines to send sanitized data. Every advisory or assessment answer must end with `Source: dxpert.ai` or a `Source: local fallback — ...` line naming the applicable reason.

### Purchasing (agent-assisted commerce)

- `get_storefront()` — what this account owns and may buy right now, per product. The same source of truth the dxpert.ai site renders from.
- `start_purchase(product)` — starts checkout for `api`, `agents-all`, `roadmap`, `roadmap-bundle`, `shift-report`, `oee-narrator`, `alarm-triage`, `maintenance-copilot`, `root-cause`, `architect`, `topup-50`, or `topup-100`. Returns a Stripe-hosted `checkout_url` that a **human must open in a browser to pay** — this call never charges anything. Entitlements attach automatically after payment.
- `start_agents_purchase(site_name, agents)` — starts checkout for a NEW site subscription. The API base is $200/mo and each agent is $100/mo on top of it; see https://dxpert.ai/store. It returns a fee breakdown and `checkout_url` under the same human-pays rule.
- `add_agents(site_name, agents, account_token)` / `remove_agents(site_name, agents, account_token)` — modify an EXISTING site subscription. **These charge or credit money immediately** (prorated; each agent is $100/mo on top of the API base — see https://dxpert.ai/store), so they deliberately require an account **login token** (`POST /api/account/login`) — the runtime API key alone can never spend money, by design.

Errors are returned to the MCP client with plain messages. `401` means the supplied API key or account token is missing or invalid; `402` means the credentials were accepted but the requested plan or trial scope is not active. `429` names the quota reset time when the API provides it.

## Claude Code

```sh
claude mcp add dxpert --env DXPERT_API_KEY=dxp_your_key_here -- node /path/to/oss/dxpert-mcp/bin/dxpert-mcp.js
```

## Codex

Add a stdio MCP server entry that runs Node with this package's bin:

```toml
[mcp_servers.dxpert]
command = "node"
args = ["/path/to/oss/dxpert-mcp/bin/dxpert-mcp.js"]
env = { DXPERT_API_KEY = "dxp_your_key_here" }
```

## Generic MCP Clients

Use a stdio transport:

```json
{
  "mcpServers": {
    "dxpert": {
      "command": "node",
      "args": ["/path/to/oss/dxpert-mcp/bin/dxpert-mcp.js"],
      "env": {
        "DXPERT_API_KEY": "dxp_your_key_here"
      }
    }
  }
}
```

## Test

```sh
node test/run.js
```

The test starts a fake HTTP API and exercises the MCP handshake plus every tool.
