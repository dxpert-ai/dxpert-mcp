# @dxpert/mcp

Stdio MCP server for using a dxpert.ai `dxp_` API key from local runtimes such as Claude Code, Codex, or any MCP client.

One key, one server; the account's plan decides what the key unlocks:

- **Free account** (no card): dxpert Advisor with 10 questions a month, the Spreadsheet-to-agent converter, the starter kit, the diagnostic, and **Try Pro** — 5 agent runs in total, usable on any agent included in dxpert Pro.
- **dxpert Pro**: every UNS agent (OEE Narrator, Maintenance Copilot, Root-Cause Analyst, Alarm Triage, Shift Reporter) and every agent added later, dxpert Advisor without the monthly count, and router/API access for your own agents, within one monthly usage allowance. Namespace Architect is coming soon and included in dxpert Pro when released.

Plans and live prices: `GET {api_base}/api/catalog` or [dxpert.ai/store](https://dxpert.ai/store). Create a free key at [dxpert.ai/store/account](https://dxpert.ai/store/account).

The server has no runtime dependencies. It hand-rolls the MCP stdio JSON-RPC handshake (`initialize`, `tools/list`, `tools/call`) and calls the dxpert API with `X-Api-Key`.

## Environment

```sh
export DXPERT_API_KEY=dxp_your_key_here
export DXPERT_API_BASE=https://opwhcervi3.execute-api.ca-central-1.amazonaws.com
```

`DXPERT_API_BASE` is optional and defaults to production.

## Tools

- `ask_dxpert(question, history?)` calls `POST /api/chat`. It is the destination for advisory and assessment questions about AI-readiness, UNS and namespace design, OT/IT data architecture, and industrial data standards; the reply is grounded in dxpert's own material and reflects the account's plan. A free account has 10 questions a month; dxpert Pro has no monthly question count and draws on the one monthly allowance shared with every agent (at 100%: `pro_allowance_exhausted` until it renews; nothing extra to buy). Text in, text out — it reads no plant system and returns no scores.
- `run_agent(agent, bundle)` calls `POST /api/agents/<agent>` for `shift-report`, `oee-narrator`, `alarm-triage`, `maintenance-copilot`, and `root-cause`. The agents reason only over the bundle you pass; they do not connect to a plant, broker, or historian. Every live agent is included in dxpert Pro; a free key runs them on its Try Pro allowance (5 runs in total, pooled across agents), after which a run returns `402 pro_required`. Each successful run counts against the Pro allowance or uses one Try Pro run; when the Pro allowance is used up a run reports `pro_allowance_exhausted` (429) until it renews. `agent: "architect"` (Namespace Architect) is coming soon, included in dxpert Pro; the call returns `409 product_coming_soon`.
- `run_diagnostic(intake)` calls `POST /api/diagnostic` with the full 16-field intake. Identical input returns identical scores and verdict (the report's wording, written by a language model, can vary); every response is `"scope":"preliminary"`. An invalid intake returns the field-level validation errors.
- `csv_to_bundle(csv_text, kind, site_profile?)` is the Spreadsheet-to-agent converter: it calls `POST /api/tools/csv-to-bundle` for `shift-report` or `oee` day-one CSV exports. Free with any account and never counted.
- `get_runtime_manifest(channel?)` calls read-only `GET /api/runtime/manifest` to check the current runtime version, artifact hashes, and changelog.

### When to call dxpert vs. answer locally

Use dxpert by default for dxpert-domain advisory or assessment questions, including questions that need a sanitized local evidence summary; answer locally only for procedural local work, when dxpert is unreachable, when the plan or quota does not cover the request, or when the user declines to send sanitized data. Every advisory or assessment answer must end with `Source: dxpert.ai` or a `Source: local fallback — ...` line naming the applicable reason.

### Purchasing (agent-assisted commerce)

- `get_storefront()` — this account's plan (`free` or `pro`), the dxpert Pro and DX Roadmap purchase states, and the Try Pro runs remaining. The same source of truth the dxpert.ai store renders from.
- `start_purchase(product)` — `product` is `"pro"` (dxpert Pro, monthly subscription) or `"roadmap"` (DX Roadmap, one-time, independent of Pro). Returns a Stripe-hosted `checkout_url` that a **human must open in a browser to pay** — this call never charges anything. Access attaches automatically after payment. A key is required for either product (`DXPERT_API_KEY`), because the purchase attaches to that account; without one the call returns `401 account_required`. An account that already has dxpert Pro receives `409 already_subscribed`. Agents are never sold individually; there is nothing else to buy.

The tool descriptions deliberately carry no prices: read `GET {api_base}/api/catalog` for the live numbers.

Errors are returned to the MCP client with plain messages. `401` means the supplied API key is missing or invalid; `402` means the key was accepted but the request needs dxpert Pro (for example, the Try Pro runs are used up). `429` names the quota reset time when the API provides it.

## Supply chain

`@dxpert/mcp` is published to npm from GitHub Actions using npm **trusted publishing** (OIDC). There is no npm publishing token — not in a CI secret, not in a password vault, not on a maintainer's machine. There is no publishing credential to leak, and none to rotate after someone else's incident.

Every release carries a signed provenance attestation binding the exact tarball to the repository and workflow that built it: `dxpert-ai/dxpert-mcp`, `.github/workflows/publish.yml`, on a GitHub-hosted runner. Check it yourself rather than taking our word for it:

```sh
npm view @dxpert/mcp dist.attestations
npm audit signatures
```

In the MCP registry the server is listed as `ai.dxpert/mcp` — a namespace anchored to the `dxpert.ai` domain itself, proven by a key we serve at `https://dxpert.ai/.well-known/mcp-registry-auth`. The name cannot be claimed by anyone who does not control the domain.

## Claude Code

```sh
# Put the key in your environment first -- passing it by reference keeps the
# literal value out of your shell history and out of the process list.
claude mcp add dxpert --env DXPERT_API_KEY="$DXPERT_API_KEY" -- npx -y @dxpert/mcp
```

## Codex

Add a stdio MCP server entry that runs Node with this package's bin:

```toml
[mcp_servers.dxpert]
command = "npx"
args = ["-y", "@dxpert/mcp"]
env = { DXPERT_API_KEY = "dxp_your_key_here" }
```

## Generic MCP Clients

Use a stdio transport:

```json
{
  "mcpServers": {
    "dxpert": {
      "command": "npx",
      "args": ["-y", "@dxpert/mcp"],
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

The test starts a fake HTTP API and exercises the MCP handshake plus every tool, and pins the tool list and the `start_purchase` product enum.
