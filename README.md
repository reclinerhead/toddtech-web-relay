# toddtech-web-relay

A small, self-hosted **fetch relay**: an HTTP service that retrieves a public web page on behalf of an application and hands the body back unchanged. It runs on a home connection, so the page sees a residential visitor rather than a cloud data center.

Status: **deployed and in service** since 2026-09-24, relaying Hearth's water-advisory checks — see the [epic](https://github.com/reclinerhead/toddtech-web-relay/issues/1) for what comes next and the [Technical Guide](docs/TechnicalGuide.md) for how it works.

## Why this exists

Cloud-hosted apps increasingly cannot read public government and civic web pages. Bot-management products such as Akamai score the *source address*, and the address ranges of AWS, Azure, Google Cloud, Cloudflare, and GitHub Actions are pre-flagged. The first casualty was [Hearth](https://github.com/reclinerhead/hearth)'s water-advisory watcher: the City of Kalamazoo's boil-water-advisory page returns `403 Access Denied` to every serverless platform we tested, and `200` to a laptop on the couch. The same wall has come up in other projects.

The relay puts one small, locked-down service on the home network. Apps call it with a URL; it fetches the page from here and returns it. Nothing about the calling app changes except where its fetch goes.

## How an app uses it

One endpoint, one contract:

```
GET https://<relay-host>/fetch?url=<encoded target URL>
Authorization: Bearer <tenant key>        (or ?key=<tenant key> for clients that can only set a URL)
```

The response is the upstream body with the upstream status code and content type, plus a few `x-relay-*` headers saying what happened (upstream status, upstream `server` header, elapsed time). A `GET /healthz` answers without a key.

Hearth, for example, sets one environment variable — a URL template with a `{url}` placeholder — and marks the sources that need the relay:

```
WATER_ADVISORY_FETCH_PROXY_URL=https://<relay-host>/fetch?key=<hearth key>&url={url}
```

Every app gets its **own tenant**: its own key, its own allowlist of upstream hosts, its own rate limit, its own name in the logs. A tenant can only fetch the hosts it was granted. Revoking one tenant never touches another.

## What it deliberately is not

- **Not an open proxy.** GET only. Allowlisted hosts only. Private and tailnet address ranges are refused after DNS resolution, on every redirect.
- **Not a scraping framework.** It returns bytes. Parsing, classification, and storage stay in the calling app.
- **Not a way around a site's terms.** It reads public pages the way a browser would, at a polite rate, for apps that surface public information faster than the publisher does.

## Where it runs

On **orchid**, the basement Ubuntu server, as a Docker container with a non-root user, a read-only filesystem, dropped capabilities, and a port bound to loopback only. The public entry point is **Tailscale Funnel**, which publishes exactly that one port under a `*.ts.net` hostname with TLS managed by Tailscale. The LAN is not exposed; the relay's own rules are what stand between the internet and the box. Details, threat model, and the runbook are in the [Technical Guide](docs/TechnicalGuide.md).

## Repository layout

```
src/                 the service — Node, no framework
tenants.example.yml  tenant config template (real file lives at /srv/web-relay/tenants.yml on orchid, never in git)
compose.yaml         the container as it runs on orchid
Dockerfile
docs/TechnicalGuide.md
.github/workflows/   tests on PR; container image build to GHCR on main
```

## Development workflow

Same discipline as the other ToddTech repos: every non-trivial change starts as a GitHub issue (templates under `.github/ISSUE_TEMPLATE/`), work happens on a feature branch, a PR closes the issue, and the Technical Guide is updated in the same change set as the code it describes.
