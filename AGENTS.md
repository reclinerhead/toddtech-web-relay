# AGENTS.md

Guidance for AI coding agents working in this repository. Read it together
with the [README](README.md), which says what the relay is and why, and the
[Technical Guide](docs/TechnicalGuide.md), which says how it is built and
deployed. Read the guide section relevant to a task before writing code; that
is a standing precondition here, whether or not the prompt mentions it.

## The box is documented elsewhere

The relay runs on **orchid**. Everything about orchid as a machine (hardware,
OS, addresses, the other tenants and their ports, Tailscale, backups, incident
history) lives in the private infrastructure repo
`reclinerhead/toddtech-infrastructure`, in `servers/Orchid.md`. When a local
clone of that repo is available to the session, read that runbook before any
change that touches deployment, ports, container networking, or Tailscale
Funnel. When it is not, say so rather than guessing at the box.

Never copy content from that repo into this one. This repository is public;
that one is private for a reason.

## What this repo owns, and what the runbook owns

**This repo** owns everything the relay puts on the box: the service and its
HTTP contract, `compose.yaml` and the `Dockerfile`, the tenant config template,
the names (never the values) of environment variables and secrets, the deploy
steps, the security model, and the Technical Guide.

**The runbook** owns one tenant row for the relay in orchid's "what runs here"
table (the loopback port, that it is published through Tailscale Funnel, a
link back here) plus anything that stays true of orchid even if the relay were
deleted. The Funnel exposure itself is a fact about the house network and is
recorded in the infrastructure repo's network docs, not here.

The test: if the relay were deleted tomorrow, would the sentence still be true
of orchid? If yes, it belongs in the runbook. If no, it belongs here.

A PR that changes how the relay is deployed on orchid (port, network mode,
Funnel, data paths) also updates the runbook row. That is a second PR in the
infrastructure repo; link the two.

## Public repository rules

Do not commit addresses, tailnet hostnames, MAC addresses, key material,
tenant keys (plaintext or hashed), or anything that identifies a physical
location. Machine hostnames such as `orchid` are fine. The real
`tenants.yml` is never committed; only the template is.

## Things that are load-bearing

- **The private-target refusal in Guide § 5.** The relay can reach every
  house machine over the LAN and the tailnet, and that denylist is the only
  reason it is safe to expose to the internet. Never loosen it for
  convenience, and never add a bypass for a "trusted" caller.
- **Loopback-only publish and bridge networking (Guide § 7).** The other
  tenants on orchid use host networking for reasons the relay does not share.
  Do not switch the relay to host networking to make something easier.
- **Keys are hashed at rest.** A change that needs the plaintext key on
  orchid is the wrong change.

## Working here

Development follows the issue → branch → PR loop: every non-trivial change
starts as a GitHub issue, work happens on a `feature/N-…` or `fix/N-…`
branch, and the PR closes the issue. A PR that changes a feature, integration,
data flow, or decision updates the Technical Guide in the same commit set.
Pure logic (URL validation, the private-range check, redirect handling, rate
limiting) gets unit tests beside the source; I/O at the boundary does not.