# toddtech-web-relay — Technical Guide

What the relay is built from, how a request moves through it, the security model, how it is deployed on orchid, and the decisions behind all of that. The README says *what and why*; this document says *how*. It describes the intended state of the service; where something is not built yet, it says so.

---

## 1. The problem, precisely

Bot-management layers (Akamai Bot Manager in the Kalamazoo case; Cloudflare Bot Management, Imperva, DataDome, and PerimeterX elsewhere) score requests before the origin sees them. The heaviest signal for a plain HTTP fetch is **source IP reputation**: known cloud and hosting ranges are denied outright with a network-edge page (`403 Access Denied`, a reference id), before any JavaScript challenge would apply. Headers, user agents, and even a headless browser do not change the verdict because they do not change the address.

Tested 2026-09-22 against the Kalamazoo advisory page, all with the same Node `fetch` and browser-like headers:

| Egress | Result |
|---|---|
| Home connection (residential ISP) | 200, full page |
| Vercel production function (AWS) | 403 Access Denied |
| GitHub Actions runner (Azure) | 403 Access Denied |
| Cloudflare Worker (plain fetch) | 403 Access Denied |
| Cloudflare Browser Rendering (headless Chrome) | expected 403; same address space |

Therefore: the fetch must originate from a residential address. Options were a paid residential-proxy API (recurring cost, opaque), or a service on the home network. This repo is the second option, built once so every project can use it.

## 2. Architecture in one picture

```
 app (Vercel, anywhere)
   │  GET https://orchid.<tailnet>.ts.net/fetch?url=…   Authorization: Bearer <tenant key>
   ▼
 Tailscale Funnel  ── public TLS endpoint managed by Tailscale; forwards ONLY this port
   │  → 127.0.0.1:8787 on orchid
   ▼
 web-relay container (Docker, bridge network, loopback-published port)
   ├─ auth: tenant key (hashed at rest) → tenant record
   ├─ policy: GET only · host on tenant allowlist · scheme https/http · port 80/443
   ├─ SSRF guard: resolve → refuse private/loopback/link-local/tailnet/docker ranges → pin the resolved IP
   ├─ limits: per-tenant rate · per-upstream-host global throttle · timeout · body cap · redirect cap
   ├─ upstream fetch with browser-like headers, from orchid's home egress
   └─ response passthrough + x-relay-* headers + one JSON log line
```

The relay is **pull-shaped**: the app calls the relay when it needs a page. The alternative, a push relay where orchid fetches on a schedule and posts pages to each app, was rejected because it needs an ingest endpoint and scheduling logic in every consuming app and a two-step protocol for follow-up pages (detail pages discovered only after parsing a list). Pull keeps the consumer's code identical to a direct fetch.

## 3. The HTTP contract

### `GET /fetch`

| Input | Where | Notes |
|---|---|---|
| target URL | `url` query param, percent-encoded | absolute `https://` or `http://` only |
| tenant key | `Authorization: Bearer <key>` **or** `key` query param | the query form exists for clients that can only set a URL template (Hearth's proxy hook). Keys are never logged; Funnel does not log request URLs. |
| `render=1` | query (Phase 4) | headless-browser rendering for JS-only pages; off by default |
| `cache=<seconds>` | query (Phase 4) | serve from the relay's short-TTL cache if fresh |

**Response**: the upstream body, unchanged. Status code is the upstream status (a 404 upstream is a 404 from the relay). `content-type` is passed through. Added headers:

| Header | Meaning |
|---|---|
| `x-relay-upstream-status` | numeric status from the origin |
| `x-relay-upstream-server` | origin's `server` header, if any (Akamai identifies itself here) |
| `x-relay-elapsed-ms` | wall-clock for the upstream fetch |
| `x-relay-tenant` | tenant name, for the caller's own logs |
| `x-relay-blocked` | present when the relay refused the request; value names the rule (`host-not-allowed`, `private-address`, `rate-limited`, …) |

Relay-side refusals use 4xx codes the caller can distinguish from upstream ones: `401` bad or missing key, `403` policy (host, scheme, private address), `405` non-GET, `413` body cap, `429` rate limit, `502` upstream unreachable, `504` upstream timeout.

### `GET /healthz`

No key. Returns `{ ok, version, uptimeSeconds, tenants: <count> }`. Intended for a container healthcheck and for an external probe.

## 4. Tenants

A YAML file at `/srv/web-relay/tenants.yml` on orchid (template `tenants.example.yml` in the repo; the real file is never committed):

```yaml
tenants:
  hearth:
    key_sha256: "3f0c…"                 # sha256 of the plaintext key; plaintext lives only in the consumer's env
    allowed_hosts:
      - www.kalamazoocity.org
      - kalamazoocity.org
    rate_limit:
      per_minute: 10
    notes: "Water advisory watcher (hearth#331/#341)"
```

- **Keys are stored hashed.** The plaintext is generated once (`openssl rand -base64 32`), handed to the consuming app's environment, and only its SHA-256 sits on orchid. A read of the config file yields nothing usable. Comparison is constant-time.
- **Allowlists are exact hostnames.** No wildcards in v1; a subdomain is a separate entry. This is the single most important tenant control — a tenant with a narrow allowlist is harmless even if its key leaks.
- **Per-tenant rate limit** protects the relay from a runaway consumer. Separately, a **global per-upstream-host throttle** (Section 6) protects the *house IP's reputation* regardless of which tenant is calling.
- The file is re-read on change (Phase 1: SIGHUP or restart; Phase 4: watch).

Adding a project is: generate a key, add a tenant block with its hosts, restart or reload, put the key in that project's env. No code.

## 5. Security model

The relay is a public endpoint on a home network. Everything below assumes the key **will** leak someday and the service **will** be scanned.

### The rules (all enforced in code, all unit-tested)

1. **GET only.** Any other method is `405` before anything is parsed.
2. **Authentication before parsing.** A bad key never reaches URL handling.
3. **Allowlist only.** The target's hostname must be on the tenant's list — exact match, after lowercasing and trailing-dot removal. No tenant may have an empty or wildcard list.
4. **Scheme and port.** `https:` or `http:`; port 80 or 443 only (explicit or default).
5. **No private targets, ever.** After DNS resolution, every returned address is checked; any hit refuses the request. Denied ranges: `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12` (Docker bridges live here), `192.168.0.0/16` (the LAN), `169.254.0.0/16` and `fe80::/10` (link-local, cloud metadata), `100.64.0.0/10` (**the tailnet** — orchid can reach every house box over Tailscale), `fc00::/7`, `0.0.0.0/8`, multicast. The relay then **connects to the address it validated** (a custom lookup pinned to the resolved IP) so a DNS answer that changes between check and connect cannot rebind to a private address. Redirects are followed manually, up to 5, and every hop repeats rules 3–5.
6. **Bounded work.** 20 s upstream timeout; 5 MB body cap (streamed, aborted on overflow); response headers pass through only a small allowlist (`content-type`, `last-modified`, `etag`); `set-cookie` and everything else are dropped.
7. **Rate limits.** Per tenant (token bucket, config) and per upstream host (global minimum interval, default 3 s) so no combination of tenants can hammer one site from the house address.
8. **Bad-key lockout.** After N failed authentications from one source in a window, that source is ignored for a cooldown. Cheap, and it turns a scan into noise.
9. **Nothing sensitive in logs.** One JSON line per request: timestamp, tenant, upstream host, relay status, upstream status, elapsed ms, bytes, refusal rule. Never the key, never the full query string of the target.

### The container

Compose pins the image by digest and runs it as an unprivileged user with `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, a memory limit, `restart: unless-stopped`, a healthcheck against `/healthz`, JSON log driver with rotation, and the port published on **`127.0.0.1:8787` only**. The container sets its own DNS resolvers explicitly (Quad9) rather than inheriting orchid's `resolv.conf`: the relay must resolve public names even when the house resolver is down or blocks a domain, and it must never be able to ask the house resolver for `.lan` names.

The container is on a **user-defined bridge network**, not `host` network like orchid's other tenants (Home Assistant, Zigbee2MQTT, Music Assistant, ESPHome, Pi-hole all use host networking for mDNS or DHCP reasons the relay does not share). Bridge networking is what makes the loopback-only publish and the private-range refusal meaningful.

### The front door: Tailscale Funnel

Funnel publishes one port on one machine to the internet through Tailscale's relays, as `https://orchid.<tailnet>.ts.net`, with a certificate Tailscale issues and renews. Traffic path: internet → Tailscale ingress → `tailscaled` on orchid → `127.0.0.1:8787`. Nothing else on orchid or the LAN is reachable this way; the subnet route orchid advertises to the tailnet is irrelevant to Funnel traffic. Funnel is on the free personal plan.

What Funnel does **not** do: it has no IP allowlist and no authentication of its own. The relay's key, allowlists, and rate limits are the whole gate. That is why they are designed for the leaked-key case.

Alternative considered: **Cloudflare Tunnel + Cloudflare Access service tokens**, which authenticates at Cloudflare's edge before traffic reaches orchid. Better in principle; rejected for v1 because the consuming apps' URL-template hook cannot send the extra headers Access needs, and because Funnel needs no DNS changes. It remains the upgrade path if the relay ever fronts something more sensitive than public web pages.

## 6. Being a good citizen upstream

The relay exists to read public pages a little sooner than people otherwise would. It must not turn the house address into a scraper the target blocks:

- Global per-host throttle (rule 7) regardless of tenant.
- Realistic browser headers, one stable user-agent string, no rotation games.
- Conditional requests when the upstream supports them (`etag` / `last-modified` pass-through lets the caller send `If-None-Match`; Phase 4 cache does it automatically).
- No retries on 403/429 from upstream — the caller gets the status and decides; retrying is how an address earns a permanent block.

## 7. Deployment on orchid

Facts about the box that the deployment relies on (from `project-squirrel/Servers/Orchid.md`): Lenovo ThinkCentre M920x, Ubuntu Server 26.04 LTS, `192.168.1.148` on the LAN and `100.109.94.41` on the tailnet, timezone `America/Detroit`, Docker present, tenants keep state under `/srv/<name>`, compose files are versioned and deployed by hand with `docker compose up -d` (the house autodeploy watcher knows nothing about containers), Tailscale joined with key expiry to be kept disabled on headless boxes. House convention: write `.lan` names, never bare hostnames.

The relay follows the same shape — a versioned `compose.yaml`, state under `/srv/web-relay`, manual deploys — but as **its own checkout** (`~/toddtech-web-relay`), because it is not part of the house Merle stack and its lifecycle is independent.

### Layout on orchid

```
~/toddtech-web-relay/           git checkout (compose.yaml, docs)
/srv/web-relay/tenants.yml      tenant config — mode 600, owner todd, never in git
/srv/web-relay/.env             RELAY_* settings (port, limits) — optional
```

### Image

Built by GitHub Actions on every merge to `main` and pushed to **GHCR** (`ghcr.io/reclinerhead/toddtech-web-relay`), tagged by short SHA and `latest`. Orchid pulls; it never needs Node or a build toolchain. The compose file pins the tag being run; a deploy is "change the tag, `up -d`", the same release-notes-first discipline orchid uses for Music Assistant.

### Bring-up (once)

```bash
# orchid
git clone git@github.com:reclinerhead/toddtech-web-relay.git ~/toddtech-web-relay
sudo mkdir -p /srv/web-relay && sudo chown todd:todd /srv/web-relay
cp ~/toddtech-web-relay/tenants.example.yml /srv/web-relay/tenants.yml && chmod 600 /srv/web-relay/tenants.yml
# generate a tenant key on the desktop, put its sha256 in tenants.yml, hand the plaintext to the app
cd ~/toddtech-web-relay && docker compose up -d
curl -s http://127.0.0.1:8787/healthz

# Funnel (once): enable the funnel node attribute in the tailnet policy, HTTPS certs + MagicDNS on in the admin console, then
sudo tailscale funnel --bg 8787
tailscale funnel status
```

### Smoke test from anywhere

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <key>" \
  "https://orchid.<tailnet>.ts.net/fetch?url=https%3A%2F%2Fwww.kalamazoocity.org%2FResidents%2FWater-Sewer-Service%2FBoil-Water-Advisories"
```

Expect `200`. A `403` with `x-relay-blocked` is the relay refusing; a `403` with `x-relay-upstream-status: 403` is the origin refusing (which would mean the house address itself is now blocked — stop and think before retrying).

### Day-to-day

```bash
docker logs web-relay --tail 50          # JSON lines
docker compose -f ~/toddtech-web-relay/compose.yaml up -d      # after a tag bump
docker compose -f ~/toddtech-web-relay/compose.yaml restart web-relay   # after editing tenants.yml (Phase 1)
```

### Failure modes and what the consumer sees

| Situation | Consumer sees | Who notices |
|---|---|---|
| orchid down / Funnel down | connection error or 5xx from Tailscale | the consumer's own health alarm (Hearth: "watcher is blind" email after 2 failed runs) |
| relay container down | 502/503 from Funnel | same, plus the container healthcheck / `restart: unless-stopped` |
| house address blocked upstream | `403` with `x-relay-upstream-status: 403` | consumer alarm; relay log shows the run of 403s for that host |
| tenant misconfigured | `403 x-relay-blocked: host-not-allowed` | consumer alarm; log names the tenant and host |

Backups: `/srv/web-relay/` is one small file of hashed keys and allowlists — include it in orchid's `/srv` backup set; it is recreatable from this document in minutes either way.

## 8. Extensibility

Designed-in seams, in the order they are likely to be wanted:

1. **More tenants.** Config only. The relay is multi-project from the first commit; adding a consumer never touches code.
2. **Rendered pages** (`render=1`). Some walls are JavaScript challenges rather than IP rules, and some pages only exist after client-side rendering. A Playwright sidecar container (its own image, on the same bridge network, no published port) renders the page and returns the DOM; the relay applies the same allowlist, SSRF, and limits before handing the URL to it. Off by default, per-tenant opt-in, heavier rate limit. Not built in v1.
3. **Short-TTL cache** (`cache=<s>`). Two apps or one app's retries hitting the same URL share one upstream fetch. In-memory, keyed by tenant-independent URL, bounded. Not built in v1.
4. **Tenant management.** v1 is edit-the-YAML. A small CLI (`relay tenant add <name> --host …`) that prints the plaintext key once and writes the hash is the likely next step; an admin page is deliberately not planned — one more public surface on a home box is the wrong trade.
5. **Observability.** v1 is JSON logs. `/stats` (per-tenant counts, per-host last-status) is cheap when wanted; an external uptime probe against `/healthz` is the sensible first alert.
6. **Second front door.** Cloudflare Tunnel + Access if a consumer can send headers and wants edge authentication.

Non-goals, so they are not argued about later: POST/PUT passthrough, cookie jars or login sessions, request bodies, arbitrary header injection by the caller, wildcard tenants, a browser-facing UI.

## 9. Stack and repo conventions

- **Node 24 LTS, no framework.** `node:http` server, `undici` (Node's built-in fetch) with a custom `lookup` for IP pinning, `yaml` for config. Vitest for the pure parts — URL/host policy, private-range detection, tenant auth, rate limiter, redirect handling — with fixtures; the network path is verified by the smoke test.
- **Single-language choice.** Go would ship a smaller binary, but every other ToddTech project is TypeScript; one runtime to keep current on orchid.
- **Docker for isolation, not for portability theater.** The point is the non-root, read-only, capability-dropped, loopback-only container on a box that also runs the house's DNS and home automation.
- **Living docs.** This guide changes in the same PR as the code it describes; chronology lives in `git log` and issues.

## 10. Decisions and rejected alternatives

| Decision | Alternative rejected | Why |
|---|---|---|
| Home egress via orchid | Paid residential-proxy API | Recurring cost for one request every 30 minutes; opaque; the house already has an always-on box and a residential address |
| Pull relay (app calls relay) | Push relay (orchid posts pages to apps) | Push needs ingest endpoints, schedulers, and a two-step protocol per consumer; pull leaves consumer code identical to a direct fetch |
| Tailscale Funnel | Cloudflare Tunnel + Access; router port-forward | Funnel: one port, managed TLS, no DNS work, free. Cloudflare Access can't be used by URL-template clients. Port-forwarding exposes the router and needs dynamic DNS |
| Hashed tenant keys in YAML | Plaintext keys; a database | Plaintext on disk is the leak that matters; a database is more than a file of ten lines deserves |
| Exact-host allowlists | Wildcards or "any host" tenants | The allowlist is what makes a leaked key harmless |
| Bridge network + loopback publish | Host network like orchid's other tenants | The relay needs none of host networking's benefits (mDNS, DHCP) and all of bridge networking's containment |
| Explicit public DNS in the container | Inherit orchid's resolver (Pi-hole) | The relay must never resolve `.lan`, must not be affected by ad-blocking, and must work when the house resolver is down |
| Node, no framework | Go single binary; Express/Fastify | One language across projects; a framework adds surface to a service with two routes |
| Headless rendering as a later, opt-in sidecar | Rendering in v1 | Most walls are IP rules, not JS; rendering is heavy and a bigger attack surface; add it when a real target needs it |

## 11. Consumers

| Project | Tenant | Hosts | Notes |
|---|---|---|---|
| Hearth — water advisory watcher | `hearth` | `www.kalamazoocity.org` | Hearth's `WATER_ADVISORY_FETCH_PROXY_URL` template + `use_fetch_proxy: true` on the Kalamazoo source; Kalamazoo currently watches WMUK's feed as an interim and moves back to the city page once the relay is live |
