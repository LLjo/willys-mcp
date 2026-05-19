# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Context:** This is a fork of `jimmystridh/willys-mcp` deployed inside a larger Home Assistant Docker stack at `/home/dasheister/homeassistant/`. See the parent [CLAUDE.md](../CLAUDE.md) for the overall system. The notes below in **"Local Modifications"** describe how this fork diverges from upstream. Everything *after* that section is the upstream guide and may not reflect current behavior — trust the modifications first.

## Local Modifications (deployed-as-HA-MCP fork)

This fork runs as a Docker service inside the parent HA stack and is consumed by Home Assistant as an MCP server (via `mcp-proxy` → SSE → HA's MCP integration). Several non-trivial changes were made on top of upstream:

### Runtime / packaging
- **Custom `Dockerfile`** (top-level). Base: `node:22-bookworm-slim`. Installs Python + `mcp-proxy` (pipx), Chromium for Puppeteer, builds the Node app. ENTRYPOINT runs `mcp-proxy --port=8096 --host=0.0.0.0 --pass-environment -- npx tsx mcp-server.ts`.
- **`.dockerignore`** excludes `.credentials`, `node_modules`, `willys-cache.db*` etc. Credentials are mounted at runtime, never baked in.
- **`better-sqlite3` upgraded** in `package.json` from `^12.6.2` → `^12.10.0` for Node 26 compatibility. (Older versions fail to compile against Node 26's V8 API.)
- Compose mounts: `./willys-mcp/.credentials:/app/.credentials:ro` and a `willys-mcp-data` volume at `/app/data`.

### Persistent cache (must-know)
- **DB lives at `/app/data/willys-cache.db`** — `lib/database.ts` honors `WILLYS_DATA_DIR` env (set to `/app/data` in compose). Survives `docker compose up --build --force-recreate`. Before this was wired, the DB lived in the container's writable layer at `/app/willys-cache.db` and got wiped on every rebuild — that's why the cache used to look empty.
- **Auto-backfill on startup.** `mcp-server.ts:backfillFromOrderHistoryIfEmpty()` runs once after auto-login if the `orders` table is empty. Walks `mcpGetOrders` → `fetchOrderDetails` for up to `BACKFILL_MAX_ORDERS=50` orders with a 500 ms inter-call delay, populating `orders`/`order_products`/`products`/`categories`. Fire-and-forget — never blocks the MCP transport. Log line to grep: `"Backfill done: N orders ingested"`.
- **Search results are cached.** `mcpSearchProducts` writes every returned product into `products` via `cacheProductsFromSearch()`. So even a search for something we've never ordered (e.g. a new "havregryn" query) builds up the cache for future `get_smart_product_matches` calls.
- **Stale-code self-healing on `add_to_cart`.** If `mcpAddToCart` gets a non-OK response for a cached code, it:
  1. Marks the code stale (`products.stale_at = now`) so `smart`/`hybrid`/`vector` search stops returning it.
  2. Re-searches by the cached product name.
  3. Retries `add_to_cart` against the top fresh result and (on success) returns a message telling the LLM which code was substituted.
  4. If the fresh search returns the *same* code, the stale marker is cleared (failure was transient, not staleness — e.g. auth glitch or out-of-stock).
  Set `options.allowFallback = false` to suppress this for tests.
- **Vector embeddings remain off by default.** `products.name_embedding` stays NULL because `lib/embeddings.ts` needs an OpenAI key (`OPENAI_API_KEY` env). `smartSearchProducts` text-LIKE search works fine without it; `hybridSearchProducts` quietly downgrades when `vectorSupport=false`.

### Preferred-items system

A curated subset of `products` flagged with `preferred_at IS NOT NULL`. The LLM consults preferred FIRST when the user says "add X to cart" — preferred items are the *specific* product (right brand, right milkfat %, right size) the user actually wants, so the model can skip a live Willys search most of the time.

Schema:
- `products.preferred_at INTEGER` — NULL = not preferred; timestamp = when it was added.
- `products.category TEXT` — auto-populated for ordered products from `order_products`/`categories` and from `categoryName` on every `cacheProductsFromSearch` / `addPreferred` call. Used by the category-LIKE layer of `resolvePreferred`.
- `products.description TEXT` + `description_fetched_at` — full produktinformation text. Currently NULL on every row: `mcpGetProductDetail` is broken (stale hardcoded Next.js `buildId` + unencoded path segments in `lib/mcp-orders.ts:1095-1097` return 400/404). Embeddings fall back to name+manufacturer+category. Fix the buildId by scraping it from the Willys homepage HTML if you need descriptions to flow.
- `products.name_embedding BLOB` + `embedding_generated_at INTEGER` — 384-dim multilingual-e5-small vector.
- `product_vectors` (vec0 virtual table, 384 dims) — actually drives k-NN. Auto-recreates if dim mismatches at startup (in `createVectorSchema`).
- `product_aliases(alias UNIQUE, product_code, created_at)` — user-language → product code map.
- `cart_history(id, product_code, name, added_at)` — append-only log written by `mcpAddToCart` after every successful add (incl. substituted codes from the stale-retry path).

DB helpers (`lib/database.ts`): `addPreferred`, `removePreferred`, `clearAllPreferred`, `listPreferred`, `searchPreferred`, `resolvePreferred`, `filterPreferredByCodes`, `addAlias`, `removeAlias`, `listAliases`, `storeProductDescription`, `storeProductEmbedding`, `listPreferredMissingEmbedding`, `vectorSearchPreferred`, `logCartAddition`, `getLastCartAddition`. `addPreferred` honors `{overwriteTimestamp: false}` so the bulk "update from cart" flow is insert-only.

#### Tools (14 total preferred-related)

Management:
- `mcp__willys_preferred_list` — browsing-only: show full list.
- `mcp__willys_preferred_search query` — browsing-only: same alias/name/category/vector resolution as `_add` but without the willys-fallback or auto-add. Tool description steers LLM toward `_add` for actual additions.
- `mcp__willys_preferred_mark productCode name?` — mark a specific product as preferred. LLM picks the code from conversation context (the item we just added, a numbered search result, etc.). `name` only required if product isn't in local cache. Replaced the older `_add_last_cart_item` (which silently relied on the cart_history log).
- `mcp__willys_preferred_remove productCode`
- `mcp__willys_preferred_replace_with_cart confirm:true` — **destructive**: wipe preferred, refill from current cart. Refuses without `confirm:true`, refuses if cart is empty. Description tells the LLM to ask the user first.
- `mcp__willys_preferred_update_from_cart` — non-destructive insert from cart.

Aliases:
- `mcp__willys_preferred_alias_add alias productCode` — UNIQUE constraint on alias. Validates that the productCode exists in `products`.
- `mcp__willys_preferred_alias_remove alias`
- `mcp__willys_preferred_alias_list productCode?`

Daily voice flow:
- `mcp__willys_preferred_add query qty? productCode?` — **the primary tool** for "add X to cart" requests. See resolution layers below. Tool description is strongly worded to keep the LLM from doing `_search` + `_search` + `_add_to_cart` workflows.

#### `preferred_add` resolution layers

In order; auto-add only fires on a confident local hit. Every layer logs to stderr with the `[preferred_add]` prefix — `docker logs willys-mcp 2>&1 | grep preferred_add` shows the full decision trail per query.

1. **`resolvePreferred()` — alias → name → category** (all stale-skipped):
   - Exact alias match against `product_aliases.alias = LOWER(query)`.
   - `products.name_normalized LIKE %query%` for preferred rows.
   - `products.category LIKE %query%` for preferred rows. Categories were auto-backfilled from order history on first startup-after-migration.
2. **Semantic vector layer** (fires only if layer 1 was empty). Calls `willys-embeddings` sidecar for the query embedding, then `vectorSearchPreferred()` for k-NN within the preferred subset. Two knobs:
   - `WILLYS_VECTOR_THRESHOLD` (default `0.70`) — minimum similarity for a hit to count. Below this, fall through.
   - `WILLYS_VECTOR_GAP` (default `0.010`) — minimum top1−top2 margin to call the top hit unambiguous and auto-add. Without this rule everything ends up "ask user" because multilingual-e5-small produces tight score clusters on grocery text. Tuned against a real 18-item preferred list — see commit history if you want the calibration data.
3. **Live Willys-search ∩ preferred** (fires only if layers 1–2 were empty). Calls `mcpSearchProducts(query)` against the live Willys API and intersects the returned codes with preferred via `filterPreferredByCodes`. Lets Willys' own search index handle compositional/cross-lingual cases ("baking butter", "3% milk") that vector misses. **Never auto-adds** — even a 1-match intersection returns the numbered list and asks the user, because the chain of inference (Willys index → match → user intent) is too lossy.

Behavior by outcome:
- **Local layer (alias/name/category/vector), unambiguous** → auto-add, return `✅ Added Nx "name" [code] (via <layer>)`.
- **Local layer with cluster** OR **Willys-fallback (any count)** → return numbered list with `[codes]`, ask LLM to confirm with user, call again with `productCode`.
- **All layers empty** → return hint pointing at `mcp__willys_search` + `mcp__willys_add_to_cart` (with user-confirmation step) for non-preferred lookups.

Tools that read `products` already skip stale rows (`stale_at IS NOT NULL`); the preferred tools also skip stale. So a preferred item that goes stale via `add_to_cart` failure will naturally disappear from `preferred_list` / `preferred_search` / `preferred_add` resolution until the search-cache flow revives or replaces it.

#### Embedding sidecar

`../willys-embeddings/` runs `intfloat/multilingual-e5-small` (384 dims, multilingual, retrieval-tuned) via sentence-transformers on CPU. Model is baked into the image. POST `/embed` with `{texts: [...], kind: "query"|"passage"}`; returns `{embeddings: [[...]], dim: 384}`. Use `kind: "query"` for the user's text at search time and `kind: "passage"` when indexing catalogue items — e5 models care about the prefix and symmetric similarity without it is measurably worse.

`lib/embeddings.ts` exports `generateQueryEmbedding`, `generatePassageEmbeddingsBatch`, `embeddingToBlob`, `blobToEmbedding`, `cosineSimilarity`. URL comes from `WILLYS_EMBED_URL` (default `http://willys-embeddings:8097` — compose-network hostname). The old OpenAI dep is no longer used; the file's `openai` import was removed.

Enrichment hooks (in `mcp-server.ts`):
- `enrichPreferredItem(sessionId, productCode, name)` — fetches description (currently no-op due to broken `mcpGetProductDetail`), generates embedding, writes both to DB.
- `enrichPreferredBacklog()` — walks `listPreferredMissingEmbedding()` and enriches each. Fire-and-forget. Runs on every startup + after `replace_with_cart` / `update_from_cart`. Inline enrich on every `preferred_mark`.

### Logging hygiene (critical for stdio MCP)
- **All `console.log` calls in `lib/*.ts` were rewritten to `console.error`.** stdio MCP servers reserve **stdout for JSON-RPC** — any stdout write breaks the protocol. Keep this discipline when adding new logs.

### Auth flow
- **Auto-login at startup** in `mcp-server.ts`. `autoLoginIfConfigured()` reads `.credentials` (line 1 = email, line 2 = password; path overridable via `WILLYS_CREDENTIALS_PATH` env var) and pre-authenticates using a fixed `DEFAULT_SESSION_ID = "default"`.
- **`sessionId` removed from every non-auth tool's `inputSchema`** (was in `properties`, now stripped). All handlers default `sessionId` to `DEFAULT_SESSION_ID` when not provided. This is essential: with `sessionId` visible in the schema, LLMs refuse to call the tools ("I don't have a sessionId").
- The `mcp__willys_login` tool still exists but its description now says it's not normally needed.

### Response formatting (`lib/mcp-formatters.ts`)
- New file containing voice-friendly formatters for every chatty tool (`formatSearchResults`, `formatCart`, `formatOrders`, `formatDeliverySlots`, etc.). They emit concise prose with product codes tucked into a single `[codes: ...]` line at the end.
- All handlers in `mcp-server.ts` were updated to call these instead of `JSON.stringify(...)`. **Do not** add a new tool handler that dumps raw JSON — write a formatter for it.
- The companion Ollama instruction (set in HA's Ollama agent config) tells the model "never speak or write anything in `[brackets]`" so codes don't leak to TTS but remain available for follow-up `add_to_cart` calls.

### What didn't change
- `lib/database.ts`, `lib/puppeteer-auth.ts`, `lib/mcp-orders.ts` (API calls), `lib/mcp-auth.ts`, `lib/mcp-session-store.ts` — only the `console.log → console.error` rewrite, no logic changes.
- The Next.js web app (`app/`, `actions/`, `components/`) is unmodified and unused in the HA deployment but kept intact for upstream merge compatibility.

### Operating

```bash
# rebuild + redeploy this service (from /home/dasheister/homeassistant/)
docker compose up -d --build --force-recreate willys-mcp

# check auto-login + proxy startup
docker logs --tail=50 willys-mcp

# probe the SSE endpoint
curl -sS -m 3 -i http://localhost:8096/sse | head
```

### Upstream merge guidance

If pulling upstream into this fork:
- Be careful around `mcp-server.ts` (heavy local changes) and `lib/mcp-formatters.ts` (new file, no upstream).
- The `console.error` discipline must survive — re-run `grep -rn "console.log" lib/` after merging.
- If upstream restructures schemas, re-strip `sessionId` from non-auth tools.

---

## Development Commands (upstream content below — may not match the HA-deployed fork)

If you need to use the server, you run it yourself on port 3009. Be sure to inspect the output to see if everything works.

**Development Server:**
```bash
PORT=3009 npm run dev        # Start development server with Turbopack
```

**Code Quality:**
```bash
npm run lint       # Check code with Biome
npm run format     # Format code with Biome
```

**Testing:**
```bash
# Run comprehensive test suite
node test-search-with-auth.js

# Test individual components
node test-offers.js
node test-search-direct.js
node test-common-products.js
```


### E2E Testing

Always use the end-to-end testing file to test the server. It will test the server and the web UI.

### Integration Testing

Also write e2e tests for code paths, these tests should be isolated and not rely on the web UI.

## High-Level Architecture

This is a **Willys MCP (Model Context Protocol) Server** that provides programmatic access to Willys grocery operations through both an MCP server interface and a Next.js web application.

### Core Components

1. **MCP Server** (`app/api/mcp/[transport]/route.ts`)
   - Main entry point with 17 registered tools
   - Session-based authentication using SQLite-backed mcpSessionStore
   - All tools require sessionId parameter for authentication
   - Implements comprehensive Willys API operations

2. **Session Management** (`lib/mcp-session-store.ts`)
   - SQLite-based session store with 24-hour expiration
   - Persistent storage with automatic cleanup
   - Maps sessionId to authentication cookies
   - Integrates with order cache for efficient cleanup

3. **Authentication Layer** (`lib/mcp-auth.ts`)
   - Puppeteer-based login automation
   - Cookie extraction and session management
   - Session validation and cleanup

4. **Database Layer** (`lib/database.ts`)
   - SQLite database with WAL mode for better performance
   - Persistent storage for sessions and order cache
   - Automatic schema initialization and cleanup
   - Foreign key constraints for data integrity

5. **Order Cache System** (`lib/mcp-order-cache.ts`, `lib/order-details-fetcher.ts`)
   - SQLite-backed order details caching
   - Shared caching between MCP and web interfaces
   - Batch fetching with respectful API rate limiting
   - 24-hour cache expiration with automatic cleanup

6. **API Operations** (`lib/mcp-orders.ts`)
   - All Willys API integrations (orders, cart, products, etc.)
   - CSRF token handling for secure operations
   - Proper Swedish character support for search
   - Integrated order caching for performance optimization

7. **Web Interface** (`app/`)
   - Next.js App Router structure
   - Server actions for API calls (`actions/`)
   - Pages for orders, offers, and cart management
   - Shared caching infrastructure with MCP server

### MCP Tools Available

**Authentication (3 tools):**
- `mcp__willys_login` - Login with credentials, returns sessionId
- `mcp__willys_logout` - Clear session
- `mcp__willys_check_auth` - Verify authentication status

**Shopping & Cart (4 tools):**
- `mcp__willys_get_cart` - Get cart contents
- `mcp__willys_add_to_cart` - Add products by product code
- `mcp__willys_remove_from_cart` - Remove products
- `mcp__willys_checkout` - Initiate checkout

**Orders (2 tools):**
- `mcp__willys_get_orders` - Get order history
- `mcp__willys_get_order_details` - Get detailed order info

**Customer & Profile (1 tool):**
- `mcp__willys_get_customer_info` - Get customer profile and bonus info

**Delivery & Pickup (3 tools):**
- `mcp__willys_get_delivery_slots` - Get delivery slots by postal code
- `mcp__willys_get_pickup_slots` - Get pickup slots by store ID
- `mcp__willys_select_slot` - Book delivery/pickup slots

**Search & Discovery (3 tools):**
- `mcp__willys_search` - Full product search with pagination
- `mcp__willys_search_suggestions` - Autocomplete suggestions
- `mcp__willys_get_offers` - Current promotions

**Advanced Features (3 tools):**
- `mcp__willys_get_common_products` - Personalized recommendations
- `mcp__willys_get_product_detail` - Detailed product information
- `mcp__willys_get_smart_product_matches` - AI-powered product matching with caching

### Key Technical Details

**Authentication Flow:**
1. Call `mcp__willys_login` with credentials to get sessionId
2. Use sessionId in all subsequent tool calls
3. Sessions expire after 24 hours automatically

**Product Codes:**
- Use format like `101175556_ST` for products
- Product codes are required for cart operations

**Swedish Language Support:**
- Full UTF-8 support for Swedish characters (ö, ä, å)
- Search terms work best with Swedish characters

**API Integration:**
- Base URL: `https://www.willys.se/axfood/rest/`
- Cookie-based session management with SQLite persistence
- CSRF token protection for state-changing operations
- NewRelic tracking headers for API compatibility
- Order details caching for improved performance

**Storage Architecture:**
- SQLite database (`willys-cache.db`) for all persistent data
- WAL mode for better concurrent performance
- Sessions table with 24-hour expiration
- Order cache table with foreign key constraints
- Automatic cleanup of expired data

**Credentials Setup:**
- Create `.credentials` file in project root
- Format: username on line 1, password on line 2

### Development Notes

**File Structure:**
- `lib/database.ts` - SQLite database layer and schema management
- `lib/mcp-session-store.ts` - SQLite-backed session management
- `lib/mcp-order-cache.ts` - Order caching interface
- `lib/order-details-fetcher.ts` - Shared order fetching with caching
- `lib/mcp-orders.ts` - Core MCP logic and API integrations
- `app/api/mcp/[transport]/route.ts` - MCP server entry point
- `actions/` - Next.js server actions with caching
- `components/` - React components
- `docs/` - Detailed API documentation

**Important Patterns:**
- All MCP functions are prefixed with `mcp`
- Session authentication is required for all operations
- SQLite database handles all persistent storage
- Order caching is automatic and transparent
- Shared infrastructure between MCP and web interfaces
- Error handling includes detailed error messages
- TypeScript types are defined in `lib/types.ts`

**Documentation:**
- Always update documentation after a development iteration, to make sure everything is up-to-date.

**Testing Approach:**
- Direct API testing files in project root (`test-*.js`)
- Comprehensive test coverage for all 17 MCP tools
- Real authentication and API testing
- Performance testing for cached vs uncached operations

**Performance Optimizations:**
- SQLite WAL mode for concurrent access
- Order details caching reduces API calls by 80-90%
- Smart matching now performs 5-10x faster
- Batch fetching for multiple orders
- Automatic cleanup prevents database bloat

This codebase demonstrates a complete MCP server implementation with production-ready features including persistent SQLite storage, intelligent caching, session management, CSRF protection, and comprehensive error handling.