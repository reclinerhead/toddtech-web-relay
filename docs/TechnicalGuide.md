# toddtech-web-relay — Technical Guide

What the relay is built from, how a request moves through it, the security model, how it is deployed on orchid, and the decisions behind all of that. The README says *what and why*; this document says *how*. It describes the current state of the service; where something is not built yet, it says so. As of 2026-09-24 the relay runs on orchid behind Tailscale Funnel and serves Hearth's water-advisory watcher (Phase 2 of the epic); Phase 3 hardening has not started.

This repository is public. Facts about orchid as a machine live in the private `toddtech-infrastructure` repo (`servers/Orchid.md`) and are never copied here; see `AGENTS.md` for the line between the two.

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

The key is read from the header when the header is present; the query param is used only when the header is absent. A header that is present but not a Bearer token is a failed authentication, not a fallback. The only caller headers forwarded upstream are `If-None-Match` and `If-Modified-Since`.

**Response**: the upstream body, unchanged and never wrapped, with the upstream status code (a 404 upstream is a 404 from the relay; an upstream `403` or `429` is passed through as-is, with no retry). Upstream `content-type`, `etag`, and `last-modified` pass through; every other upstream header, including `set-cookie`, is dropped. Added headers:

| Header | Meaning |
|---|---|
| `x-relay-upstream-status` | numeric status from the origin; on a refusal, the last origin status seen (omitted when there was none) |
| `x-relay-upstream-server` | origin's `server` header (Akamai identifies itself here); omitted when the origin sent none |
| `x-relay-elapsed-ms` | wall-clock for the upstream fetch, all hops included; `0` when no fetch was attempted |
| `x-relay-tenant` | tenant name, for the caller's own logs; omitted when unauthenticated |
| `x-relay-blocked` | present only when the relay refused the request; value is the code below |

A relay refusal is `application/json` `{ "error": "<code>" }`. Codes and statuses:

| Status | `x-relay-blocked` | When |
|---|---|---|
| `401` | `auth-failed` | missing, malformed, or unknown key |
| `401` | `locked-out` | invalid key from a source in lockout cooldown (§ 5 rule 8) |
| `403` | `bad-url` | not an absolute `http:`/`https:` URL, or has userinfo |
| `403` | `port-not-allowed` | port other than 80 or 443 |
| `403` | `host-not-allowed` | hostname not on the tenant's allowlist |
| `403` | `private-address` | any resolved address is in a denied range (§ 5 rule 5) |
| `404` | `not-found` | path other than `/fetch` or `/healthz` |
| `405` | `method-not-allowed` | any method other than `GET`, decided before the URL or key is read |
| `413` | `body-too-large` | origin declared or streamed more than 5 MiB; no partial body is returned |
| `429` | `rate-limited` | the tenant's token bucket is empty |
| `429` | `host-throttled` | the global per-host gate refused (one fetch per host per 3 s) |
| `502` | `dns-failed` | the name resolved to nothing |
| `502` | `upstream-unreachable` | connection or protocol failure |
| `502` | `redirect-limit` | a sixth redirect |
| `504` | `upstream-timeout` | the 20 s deadline passed |
| `500` | `internal-error` | a bug; the log line and stderr have the detail |

Codes in the `403` group after `bad-url` apply to redirect hops as well as the initial target.

### `GET /healthz`

No key, no rate limit, no lockout. Returns `{ ok, version, uptimeSeconds, tenants: <count> }`, with `version` from `package.json`. Intended for the container healthcheck and, in Phase 3, an external probe. It is logged like any other request.

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

- **Keys are stored hashed.** The plaintext is generated once (`openssl rand -base64 32`), handed to the consuming app's environment, and only its SHA-256 sits on orchid (`printf '%s' '<key>' | sha256sum`). A read of the config file yields nothing usable. The presented key is hashed and compared with `crypto.timingSafeEqual` against every tenant, with no early exit.
- **Allowlists are exact hostnames.** No wildcards in v1; a subdomain is a separate entry. Entries are lowercased and lose one trailing dot at load. This is the single most important tenant control — a tenant with a narrow allowlist is harmless even if its key leaks.
- **Per-tenant rate limit** protects the relay from a runaway consumer. Separately, a **global per-upstream-host throttle** (Section 6) protects the *house IP's reputation* regardless of which tenant is calling.
- **Validated at load, or the relay refuses to listen.** `key_sha256` must be 64 hex characters and unique across tenants; `allowed_hosts` must be a non-empty list of bare hostnames with no wildcards; `rate_limit.per_minute` a positive integer; `notes` optional; any other field is an error (so a typo cannot silently widen a tenant). Error messages name the tenant and field and never echo a hash.
- **Read once at process start**, from `RELAY_TENANTS_FILE` (default `./tenants.yml`; compose sets `/config/tenants.yml`). A change is picked up by restarting the container. Reload without restart (SIGHUP or a file watch) is Phase 3.

Adding a project is: generate a key, add a tenant block with its hosts, restart the container, put the key in that project's env. No code.

## 5. Security model

The relay is a public endpoint on a home network. Everything below assumes the key **will** leak someday and the service **will** be scanned.

### The rules (all enforced in code, all unit-tested)

1. **GET only.** Any other method is `405` before the URL or the key is read.
2. **Authentication before parsing.** A bad key never reaches URL handling. The pipeline order is fixed: method → route → key (with lockout) → URL policy → tenant bucket → host gate → DNS and the private-range check → fetch.
3. **Allowlist only.** The target's hostname must be on the tenant's list — exact match, after lowercasing and trailing-dot removal. No tenant may have an empty or wildcard list. Userinfo in the URL is refused.
4. **Scheme and port.** `https:` or `http:`; port 80 or 443 only (explicit or default).
5. **No private targets, ever.** The name is resolved through the container's resolver (A and AAAA, not `getaddrinfo`, so `/etc/hosts` cannot steer it) and every returned address is checked; any hit refuses the request. Denied ranges: `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12` (Docker bridges live here), `192.168.0.0/16` (the LAN), `169.254.0.0/16` and `fe80::/10` (link-local, cloud metadata), `100.64.0.0/10` (**the tailnet** — orchid can reach every house box over Tailscale), `fc00::/7`, `0.0.0.0/8`, `240.0.0.0/4`, multicast (`224.0.0.0/4`, `ff00::/8`), the unspecified `::`, and the IPv4-mapped IPv6 form (`::ffff:a.b.c.d`) of every IPv4 range above. An IP-literal target is checked the same way. The relay then **connects to the address it validated**: the first IPv4 address, else the first IPv6, through an undici `Agent` whose `lookup` returns only that address, so a DNS answer that changes between check and connect cannot rebind to a private address. The hostname still drives SNI, certificate verification, and the `Host` header. Redirects (`301`, `302`, `303`, `307`, `308` with a `Location`) are followed manually, at most 5, and every hop repeats rules 3–5; the sixth is `502 redirect-limit`.
6. **Bounded work.** One 20 s deadline covers every hop and the body read (`504 upstream-timeout`). 5 MiB body cap: a larger declared `content-length` is refused without reading, and a stream that exceeds the cap is cancelled and refused, in both cases `413 body-too-large` with no partial body. The outbound `Accept-Encoding` is `identity`, so the buffered body is uncompressed and the dropped `content-encoding` header loses nothing. Response headers pass through only a small allowlist (`content-type`, `last-modified`, `etag`); `set-cookie` and everything else are dropped.
7. **Rate limits.** Per tenant: a token bucket whose capacity and per-minute refill are both `rate_limit.per_minute` (`429 rate-limited`). Per upstream host, across all tenants: at most one admitted fetch per hostname per `RELAY_HOST_MIN_INTERVAL_MS` (default 3000), with the slot reserved at admission (`429 host-throttled`). No combination of tenants can hammer one site from the house address.
8. **Bad-key lockout.** `RELAY_LOCKOUT_FAILURES` (default 10) failed authentications from one source inside `RELAY_LOCKOUT_WINDOW_MS` (default 300000) put that source in cooldown for `RELAY_LOCKOUT_COOLDOWN_MS` (default 900000); during cooldown an invalid key is `401 locked-out` with no DNS or fetch. **A valid key is never locked out.** The source is the socket peer address, and behind Funnel every client shares one peer, so ignoring that peer would blackhole a legitimate tenant along with the scanner. Phase 3 confirms what Funnel forwards and decides whether the bypass stays.
9. **Nothing sensitive in logs.** One JSON line per request on stdout: `ts`, `tenant`, `host` (hostname only), `relayStatus`, `upstreamStatus`, `elapsedMs`, `bytes`, `blocked`. The raw request line, the key, and the target's path and query string are not fields, so they cannot appear. One extra `event: "listening"` line at startup.

### The container

Compose runs `ghcr.io/reclinerhead/toddtech-web-relay:latest` (a digest pin is Phase 3) as the image's unprivileged `node` user with `read_only: true` (plus a tmpfs at `/tmp`), `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `mem_limit: 256m`, `restart: unless-stopped`, a `wget` healthcheck against `/healthz`, the json-file log driver with rotation (`10m` × 3), the tenants file bind-mounted read-only at `/config/tenants.yml`, an optional `/srv/web-relay/.env`, and the port published on **`127.0.0.1:8787` only**. The image is `node:24-alpine` rather than distroless so that healthcheck has `wget`; it contains only production dependencies and compiled output.

The container sets its own DNS resolvers explicitly (Quad9, `9.9.9.9` and `149.112.112.112`) rather than inheriting orchid's `resolv.conf`: the relay must resolve public names even when the house resolver is down or blocks a domain, and it must never be able to ask the house resolver for `.lan` names. (Docker's embedded DNS would drop orchid's loopback resolver in any case; without the explicit list the container would silently fall back to Docker's defaults.)

The container is on a **user-defined bridge network**, not `host` network like orchid's other tenants (Home Assistant, Zigbee2MQTT, Music Assistant, ESPHome, Pi-hole all use host networking for mDNS or DHCP reasons the relay does not share). Bridge networking is what makes the loopback-only publish and the private-range refusal meaningful.

### The front door: Tailscale Funnel

Funnel publishes one port on one machine to the internet through Tailscale's relays, as `https://orchid.<tailnet>.ts.net`, with a certificate Tailscale issues and renews. Traffic path: internet → Tailscale ingress → `tailscaled` on orchid → `127.0.0.1:8787`. Nothing else on orchid or the LAN is reachable this way; the subnet route orchid advertises to the tailnet is irrelevant to Funnel traffic. Funnel is on the free personal plan.

What Funnel does **not** do: it has no IP allowlist and no authentication of its own. The relay's key, allowlists, and rate limits are the whole gate. That is why they are designed for the leaked-key case.

Alternative considered: **Cloudflare Tunnel + Cloudflare Access service tokens**, which authenticates at Cloudflare's edge before traffic reaches orchid. Better in principle; rejected for v1 because the consuming apps' URL-template hook cannot send the extra headers Access needs, and because Funnel needs no DNS changes. It remains the upgrade path if the relay ever fronts something more sensitive than public web pages.

## 6. Being a good citizen upstream

The relay exists to read public pages a little sooner than people otherwise would. It must not turn the house address into a scraper the target blocks:

- Global per-host throttle (rule 7) regardless of tenant.
- Realistic browser headers: one stable Chrome-on-Windows user-agent constant in `src/headers.ts`, a browser `Accept`, `Accept-Language`, and `Sec-Fetch-*` set; no rotation games. `Accept-Encoding: identity` (rule 6).
- Conditional requests when the upstream supports them (`etag` / `last-modified` pass-through lets the caller send `If-None-Match` / `If-Modified-Since`, which are the only caller headers forwarded; Phase 4 cache does it automatically).
- No retries on 403/429 from upstream — the caller gets the status and decides; retrying is how an address earns a permanent block.

## 7. Deployment on orchid

Deployed 2026-09-24. Everything about orchid as a machine — addresses, hardware, OS, the other tenants and their ports, Tailscale, backups — is in the private `toddtech-infrastructure` repo, `servers/Orchid.md`, which carries the relay's row in its "what runs here" table and a short section of orchid-side facts. Read it before touching ports, networking, or Funnel. What this repo relies on from it: Docker is present, containers keep state under `/srv/<name>`, compose files are versioned and deployed by hand with `docker compose up -d`, the relay's port `8787` is orchid's only bridge-network tenant, and orchid's own resolver is a loopback Pi-hole (which is why the container sets its own DNS, § 5).

The relay follows the same shape as orchid's other tenants — a versioned `compose.yaml`, state under `/srv/web-relay`, manual deploys — but as **its own checkout** (`~/toddtech-web-relay`), because it is not part of the house stack and its lifecycle is independent. The Funnel hostname is a fact about the house network and lives in the infrastructure repo's network docs, in Hearth's Vercel environment, and nowhere in this repo.

### Layout on orchid

```
~/toddtech-web-relay/           git checkout (compose.yaml, docs)
/srv/web-relay/tenants.yml      tenant config — mode 600, owner todd, never in git; mounted read-only at /config/tenants.yml
/srv/web-relay/.env             RELAY_* settings — optional; compose loads it if present
```

### Settings

Every knob is optional; `.env.example` in the repo lists them with these defaults. The timeout (20 s), body cap (5 MiB), and redirect cap (5) are fixed by the contract and are not knobs.

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_PORT` | `8787` | listen port (the image sets it too) |
| `RELAY_BIND` | `127.0.0.1` (image: `0.0.0.0`) | listen address; inside the container it must be reachable from the bridge, and compose publishes it on loopback only |
| `RELAY_TENANTS_FILE` | `./tenants.yml` (compose: `/config/tenants.yml`) | tenants file, read at start |
| `RELAY_HOST_MIN_INTERVAL_MS` | `3000` | global per-host gate |
| `RELAY_LOCKOUT_FAILURES` | `10` | failures per window that trigger lockout |
| `RELAY_LOCKOUT_WINDOW_MS` | `300000` | lockout window |
| `RELAY_LOCKOUT_COOLDOWN_MS` | `900000` | lockout cooldown |

An invalid value, or an invalid tenants file, makes the process exit with a message on stderr instead of listening.

### Image

Built by GitHub Actions (`.github/workflows/ci.yml`) on every push to `main`, after the test job passes, and pushed to **GHCR** (`ghcr.io/reclinerhead/toddtech-web-relay`), tagged by short SHA and `latest`. Pull requests run typecheck and tests only. Orchid pulls; it never needs Node or a build toolchain. The compose file names the tag being run (`latest` in Phase 1; Phase 3 pins by digest); a deploy is "pull, `up -d`". The package is **public**, like the repo: the image holds nothing secret, and a public package means orchid pulls with no registry login and no token to rotate.

### Bring-up (done 2026-09-24; this is the procedure for a rebuild)

```bash
# orchid — the repo is public, so HTTPS needs no GitHub key on the box
git clone https://github.com/reclinerhead/toddtech-web-relay.git ~/toddtech-web-relay
sudo mkdir -p /srv/web-relay && sudo chown todd:todd /srv/web-relay      # interactive: sudo wants a password here
cp ~/toddtech-web-relay/tenants.example.yml /srv/web-relay/tenants.yml && chmod 600 /srv/web-relay/tenants.yml
# on the desktop: KEY=$(openssl rand -base64 32); echo "$KEY"; printf '%s' "$KEY" | sha256sum
# put the hash in tenants.yml, hand the plaintext to the consuming app's environment
docker compose -f ~/toddtech-web-relay/compose.yaml up -d
curl -s http://127.0.0.1:8787/healthz          # {"ok":true,...,"tenants":1}
docker exec web-relay nslookup orchid.lan      # must be NXDOMAIN: the container cannot see the house resolver

# Funnel (once): in the admin console, HTTPS certificates on, MagicDNS on, the `funnel` nodeAttr in the policy
# (Access controls → Funnel → "Add Funnel to policy"), and orchid's key expiry disabled (house rule). Then:
sudo tailscale funnel --bg 8787
tailscale funnel status
```

The container runs as uid 1000 (`node`); `todd` is uid 1000 on orchid, which is why the mode-600 tenants file is readable through the bind mount. On a box where that differs, set `user:` in compose or chown the file.

**Gotchas from the first bring-up.**

- **The Funnel's public DNS record may not appear.** Tailscale documents up to ten minutes; on 2026-09-24 the name's public address was withdrawn and nothing replaced it for 25 minutes. `sudo systemctl restart tailscaled` published the Funnel relay addresses within a minute (a known backend quirk, tailscale/tailscale#7103). Check with `nslookup <funnel-name> ns1.dnsimple.com`, the authoritative server: an empty answer means not yet published.
- **Test Funnel from a client that is not on the tailnet.** MagicDNS on a member resolves the name straight to orchid's tailnet address, so a curl from a tailnet machine succeeds without ever touching Funnel. Disconnect the Tailscale client on the desktop (or use a phone on cellular) for the real test.
- **Caddy already owns port 443 on orchid**, so tailscaled logs `localListener failed to listen on <tailnet addr>:443 ... address already in use` every few seconds. Funnel and tailnet peers are served through tailscaled's own network stack and are unaffected; the noise is only in the journal. Recorded in the runbook.
- **Windows PowerShell aliases `curl` to Invoke-WebRequest.** Use `curl.exe` for the smoke commands below.

### Smoke test from outside the house

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <key>" \
  "https://<funnel-name>/fetch?url=https%3A%2F%2Fwww.kalamazoocity.org%2FResidents%2FWater-Sewer-Service%2FBoil-Water-Advisories"
```

Expect `200` with `x-relay-upstream-status: 200` and `x-relay-tenant: hearth`. A `403` with `x-relay-blocked` is the relay refusing; a `403` with `x-relay-upstream-status: 403` is the origin refusing (which would mean the house address itself is now blocked — stop and think before retrying). The other checks: no key → `401 auth-failed`; a POST → `405 method-not-allowed`; a host off the tenant's list → `403 host-not-allowed`. Note that a LAN or tailnet address is refused as `host-not-allowed` too, because the allowlist runs before DNS; the `private-address` path is what stops an allowlisted name that resolves inward, and the unit tests plus `docker exec web-relay nslookup orchid.lan` cover it.

### Day-to-day

```bash
docker logs web-relay --tail 50          # JSON lines
docker compose -f ~/toddtech-web-relay/compose.yaml pull && docker compose -f ~/toddtech-web-relay/compose.yaml up -d   # new image
docker compose -f ~/toddtech-web-relay/compose.yaml restart web-relay   # after editing tenants.yml
```

### Failure modes and what the consumer sees

| Situation | Consumer sees | Who notices |
|---|---|---|
| orchid down / Funnel down | connection error or 5xx from Tailscale | the consumer's own health alarm (Hearth: "watcher is blind" email after 2 failed runs) |
| relay container down | 502/503 from Funnel | same, plus the container healthcheck / `restart: unless-stopped` |
| house address blocked upstream | `403` with `x-relay-upstream-status: 403` | consumer alarm; relay log shows the run of 403s for that host |
| tenant misconfigured | `403 x-relay-blocked: host-not-allowed` | consumer alarm; log names the tenant and host |

Backups: `/srv/web-relay/` is one small file of hashed keys and allowlists. It is in orchid's `/srv` backup list in the runbook; it is recreatable from this document in minutes either way, at the cost of issuing each consumer a new key.

### Consumer-side pacing

A consumer that fetches several pages per run must respect the relay's two limits (§ 5 rule 7): one fetch per upstream host per 3 s across all tenants, and its own `per_minute` bucket. Hearth's OpenCities adapter fetches a list page and then, for advisories it has not stored, their detail pages; through the relay it paces those at 3.2 s apart and caps them at 8 per run (hearth#353). A burst would be refused with `429 host-throttled`, and Hearth never re-fetches a stored URL, so the tenant's `per_minute` is set with the seed run in mind.

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

- **Node 24 LTS, no framework.** `node:http` server, the `undici` package (the same engine as Node's built-in fetch, imported directly so an `Agent` with a custom `lookup` can pin the connection), `yaml` for config, `net.BlockList` for the denied ranges. TypeScript compiled by `tsc` into `dist/` for the image; in development `node --watch src/server.ts` runs the source directly through Node's type stripping, which is why the source uses `.ts` import specifiers (`rewriteRelativeImportExtensions` turns them into `.js` on build) and only erasable syntax. ESM throughout.
- **Modules** (`src/`): `server.ts` (pipeline and `main`), `config.ts` (env and tenants), `auth.ts`, `policy.ts` (URL and allowlist), `private-ranges.ts`, `rate-limit.ts` (tenant bucket, host gate, lockout), `upstream.ts` (resolve, pin, redirects, body cap, deadline), `headers.ts` (outbound set and response allowlist), `log.ts`. Each pure module has a sibling `*.test.ts`.
- **Tests.** Vitest, fixtures only, no network: policy, private-range detection (v4, v6, mapped, mixed answers), auth (header/query precedence, constant-time compare), config validation, both rate limiters and lockout, redirect re-validation, body cap, deadline, and the header allowlist. `upstream.ts` takes its resolver, fetch, and dispatcher factory as injectable dependencies for this reason. The network path is verified by the Phase 2 smoke test. `pnpm test` runs once; `pnpm typecheck` runs `tsc` over source and tests; CI runs both on every PR.
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
| Tenants read once at start; restart to reload | SIGHUP or a file watch in Phase 1 | The runbook already restarts the container after an edit; reload without restart is Phase 3 work with its own failure modes (a bad edit must not take down a running relay) |
| A valid key bypasses lockout | Lock out the source entirely | Behind Funnel every client shares one socket peer; locking the peer would blackhole Hearth along with a scanner. Revisit in Phase 3 once the forwarded client address is confirmed |
| Buffer the body (up to the cap) before responding | Stream it through | The contract promises no partial body on a `413`, which needs the whole body first; 5 MiB is cheap |
| `node:24-alpine` | distroless | The compose healthcheck needs `wget` in the image; the non-root, read-only, capability-dropped constraints are the same either way |
| Resolve with `dns.resolve4/6`, not `dns.lookup` | `getaddrinfo` | The resolver path honors the container's explicit DNS and ignores `/etc/hosts`; the check and the pinned connect then agree on where the name points |
| Public GHCR package | Private package plus a registry token on orchid | The source is public and the image holds nothing secret; a private package would add a PAT to store and rotate on the box for no gain |

## 11. Consumers

| Project | Tenant | Hosts | Notes |
|---|---|---|---|
| Hearth — water advisory watcher | `hearth` | `www.kalamazoocity.org`, `kalamazoocity.org` | Live since 2026-09-24 (hearth#353): `WATER_ADVISORY_FETCH_PROXY_URL` template in Vercel + `use_fetch_proxy: true` on the Kalamazoo source, which is back on the city's own page. `per_minute: 15`, sized for a seed run (one list fetch plus up to eight paced detail fetches). Cron every 30 minutes; one request per run in steady state |
