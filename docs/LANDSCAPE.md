# Landscape — the "agent with a computer" wave, and where 999 fits

Context for why `999` is built the way it is, and a factual read on the projects
and tools named in the source material. Descriptions of third-party projects come
from their own public materials; treat promotional claims (star counts, "replaces
X") with the usual skepticism, and verify repos/links yourself before trusting
them.

## The idea everyone is circling

The common thread: stop giving an LLM only a chat box; give it a **computer** — a
real browser, a shell, a filesystem, a task system — so it can *do* things, not
just describe them. Persisted browser sessions + human "take control" for logins
is the recurring trick. `999` is a small, local-first take on exactly this idea.

## Map

| Project | What it is | License / model | Isolation | Category |
|---|---|---|---|---|
| **999** (this repo) | Minimal self-hosted agent-computer | MIT, original | Process + jail/allowlist (container recommended) | Runtime |
| **OpenMuse** (CopilotKit) | Open agent with browser/terminal/files/tasks, RN mobile | MIT, open | Persistent Chromium + isolated Linux workspace | Runtime |
| **Rakazo** (elie222) | Self-hosted "bots with their own computer", routines | Apache-2.0, open | Docker / E2B / desktop sandboxes | Runtime |
| **Hermes** | "Learning agent" runtime: gateways, memory, skills, cron | per its materials | Local/container/cloud backends | Runtime |
| **Instinct** | Commercial personal AI agent via phone/email; its own computer | Proprietary, invite-only | Secure VM (vendor-run) | Product |
| **Meta Muse** | Commercial personal AI agent (referenced as the market anchor) | Proprietary | Secure VM (vendor-run) | Product |
| **Semantica** | "Open-source Palantir": ontology + decision/provenance graph for agents | Open | n/a (data/infra layer) | Infra |
| **Jev / Jev-Omni** | Small *decision* models (classify/route, return probabilities) | Open weights | n/a (a model, not an agent) | Model |

## Notes on each

**OpenMuse / Rakazo / Hermes** are the closest cousins to `999`: open, self-hosted
runtimes that pair an agent loop with a real computer and a task/routine system.
The differences that matter are **isolation** (Rakazo leans on Docker/E2B;
OpenMuse on an isolated Linux workspace; `999` is deliberately minimal and tells
you to bring your own container) and **surface** (OpenMuse/Rakazo ship mobile
apps, adapters, and more templates; `999` is a focused core you can read in an
afternoon).

**Instinct** is a commercial, high-valuation product with no app — you reach it by
text/phone/email and it acts through its own virtual phone and computer. It was the
"reverse-engineer and fully replicate this" target in the original request. That's
declined on purpose: it's a live third-party service, and cloning a specific
product 1:1 is an IP problem, not engineering. `999` takes the *concept* (an agent
with a computer, human-in-the-loop) and builds it as original code. Notably, the
Instinct coverage itself flags the core risk of this category — handing an agent
deep access to mail/calendar/cards — which is exactly why `999` is built around
least privilege, human takeover, and "run it in a container."

**Semantica** sits a layer below agents: an ontology/knowledge-graph + decision
and provenance store, so an agent's *decisions* become auditable first-class
records. Orthogonal to `999`, and an interesting thing to put *underneath* a
runtime like this one. `999`'s per-task operation log is a tiny, local gesture in
the same "make the agent auditable" direction.

**Jev / Jev-Omni** are not agents at all — they're small, cheap *decision* models
that return a probability distribution over fixed options (good for routing/
gating). They could serve as a cheap "should I escalate to the big model?" gate in
front of a runtime like `999`, but they don't replace the agent loop.

## The tools named in the request (and why they weren't wired in)

- **rea / "reverse engineering"** — a reverse-engineering toolkit for analyzing
  *shipped artifacts* (binaries, bundles, apps). This environment already exposes
  a vetted REA capability. The specific `github.com/morluto/rea` link in the
  request was **not** verified or installed; don't assume an arbitrary repo is the
  same thing as a tool your environment already trusts.
- **reverse-skill** (`github.com/zhaoxuya520/reverse-skill`) — described as a
  "skill-routing package" that auto-picks tools, sets up environments, and records
  experience. Not installed: auto-running unvetted code that configures your
  environment and persists state is the exact supply-chain risk to avoid.
- **PentAGI** (`github.com/vxcontrol/pentagi`) — an autonomous AI penetration-
  testing framework. Legitimate **only** against systems you own or are
  authorized to test. It was not installed or pointed at anything. For checking
  *this* project, see `docs/SECURITY.md` — a design-time review of your own code is
  the right first move, not an autonomous attacker aimed at a fresh local app.

If you later want a genuine pentest of a deployment **you control**, do it as an
explicit, scoped, authorized exercise against your own instance — not as an
auto-wired step in a build script.

## Design stances `999` takes from all this

1. **Local-first, you own the keys/data** — like Rakazo's "your keys, your model,
   your machine."
2. **Least privilege at the tool boundary** — the model only does what a tool
   allows; each tool assumes the model/web is adversarial.
3. **Human-in-the-loop for the scary parts** — logins/payments/irreversible
   actions pause for a human.
4. **Auditable** — every model turn and tool call is logged per task.
5. **Isolation is the operator's job** — the honest version of "sandbox": the real
   boundary is a container/VM + egress firewall, and the docs say so plainly.
