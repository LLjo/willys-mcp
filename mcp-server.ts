#!/usr/bin/env npx tsx
/**
 * Willys MCP Server - Stdio Transport
 *
 * A standalone MCP server that communicates via stdio for use with Claude Code.
 * Provides access to Willys grocery operations.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readCredentialsFile } from "./lib/credentials";
import { willysDatabase } from "./lib/database";
import {
  generatePassageEmbeddingsBatch,
  generateQueryEmbedding,
} from "./lib/embeddings";
import { mcpGetWillysCookies } from "./lib/mcp-auth";
import { fetchOrderDetails } from "./lib/order-details-fetcher";

const DEFAULT_SESSION_ID = "default";
import {
  mcpAuthenticateWithWillys,
  mcpIsAuthenticated,
  mcpLogout,
} from "./lib/mcp-auth";
import {
  extractProductDescription,
  mcpAddToCart,
  mcpCheckout,
  mcpGetCart,
  mcpGetCommonProducts,
  mcpGetCustomerInfo,
  mcpGetDeliverySlots,
  mcpGetOffers,
  mcpGetOrderDetails,
  mcpGetOrders,
  mcpGetPickupSlots,
  mcpGetProductDetail,
  mcpGetSearchSuggestions,
  mcpGetSmartProductMatches,
  mcpRemoveFromCart,
  mcpSearchProducts,
  mcpSelectSlot,
} from "./lib/mcp-orders";
import {
  formatAliases,
  formatCart,
  formatCommonProducts,
  formatCustomerInfo,
  formatDeliverySlots,
  formatOffers,
  formatOrderDetails,
  formatOrders,
  formatPickupSlots,
  formatPreferredList,
  formatProductDetail,
  formatSearchResults,
  formatSearchSuggestions,
} from "./lib/mcp-formatters";
import { mcpSessionStore } from "./lib/mcp-session-store";

const server = new Server(
  {
    name: "willys-checklist",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Define all tools
const tools = [
  {
    name: "mcp__willys_login",
    description:
      "Manually log in to Willys with a username and password. NOT normally needed — the server auto-logs in from a credentials file at startup, and all other tools work without any extra setup. Only call this to switch accounts or re-authenticate after a failure.",
    inputSchema: {
      type: "object" as const,
      properties: {
        username: { type: "string", description: "Willys username/email" },
        password: { type: "string", description: "Willys password" },
      },
      required: ["username", "password"],
    },
  },
  {
    name: "mcp__willys_logout",
    description:
      "Clear the active Willys authentication session. Rarely needed — auto-login restores it on next request.",
    inputSchema: {
      type: "object" as const,
      properties: {
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_check_auth",
    description:
      "Check whether the auto-login session is currently active. Used for diagnostics.",
    inputSchema: {
      type: "object" as const,
      properties: {
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_get_orders",
    description:
      "Get order history from Willys. Returns list of past orders with details.",
    inputSchema: {
      type: "object" as const,
      properties: {
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_get_order_details",
    description:
      "Get detailed information about a specific order including all items.",
    inputSchema: {
      type: "object" as const,
      properties: {
        orderId: {
          type: "string",
          description: "The order ID to get details for",
        },
      },
      required: ["orderId"],
    },
  },
  {
    name: "mcp__willys_get_cart",
    description: "Get current shopping cart contents",
    inputSchema: {
      type: "object" as const,
      properties: {
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_add_to_cart",
    description:
      "Add a product to the shopping cart by EXACT product code. WARNING: do not call this immediately after mcp__willys_search — Willys's search returns many imperfect matches and auto-adding the first one is usually wrong. For 'add X to cart' requests use mcp__willys_preferred_add (the one-shot tool that resolves intent against the user's preferred list). Only call this directly when (a) the user has just confirmed a numbered choice from a search result, or (b) you are 100% sure of the product code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productCode: {
          type: "string",
          description: "Product code (e.g., '101175556_ST')",
        },
        quantity: {
          type: "number",
          description: "Quantity to add (default: 1)",
        },
      },
      required: ["productCode"],
    },
  },
  {
    name: "mcp__willys_remove_from_cart",
    description: "Remove a product from the shopping cart",
    inputSchema: {
      type: "object" as const,
      properties: {
        productCode: { type: "string", description: "Product code to remove" },
      },
      required: ["productCode"],
    },
  },
  {
    name: "mcp__willys_checkout",
    description: "Initiate checkout process for the current cart",
    inputSchema: {
      type: "object" as const,
      properties: {
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_get_customer_info",
    description: "Get customer profile and bonus information",
    inputSchema: {
      type: "object" as const,
      properties: {
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_get_delivery_slots",
    description: "Get available delivery time slots for a postal code",
    inputSchema: {
      type: "object" as const,
      properties: {
        postalCode: {
          type: "string",
          description: "Postal code for delivery (default: '12345')",
        },
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_get_pickup_slots",
    description: "Get available pickup time slots for a store",
    inputSchema: {
      type: "object" as const,
      properties: {
        storeId: {
          type: "string",
          description: "Store ID for pickup (default: '2288')",
        },
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_select_slot",
    description: "Select a delivery or pickup time slot",
    inputSchema: {
      type: "object" as const,
      properties: {
        slotCode: { type: "string", description: "The slot code to select" },
        isTmsSlot: {
          type: "boolean",
          description: "Whether this is a TMS slot (default: false)",
        },
      },
      required: ["slotCode"],
    },
  },
  {
    name: "mcp__willys_search",
    description: "Search for products in the Willys catalog",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        page: { type: "number", description: "Page number (default: 0)" },
        size: { type: "number", description: "Results per page (default: 30)" },
      },
      required: ["query"],
    },
  },
  {
    name: "mcp__willys_search_suggestions",
    description: "Get autocomplete suggestions for a search query",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Partial search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "mcp__willys_get_offers",
    description: "Get current promotions and offers",
    inputSchema: {
      type: "object" as const,
      properties: {
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_get_common_products",
    description:
      "Get personalized product recommendations based on purchase history",
    inputSchema: {
      type: "object" as const,
      properties: {
      },
      required: [],
    },
  },
  {
    name: "mcp__willys_get_product_detail",
    description: "Get detailed information about a specific product",
    inputSchema: {
      type: "object" as const,
      properties: {
        productCode: { type: "string", description: "Product code" },
        productName: {
          type: "string",
          description: "Product name (optional, for URL construction)",
        },
      },
      required: ["productCode"],
    },
  },
  {
    name: "mcp__willys_get_smart_product_matches",
    description:
      "AI-powered product matching using purchase history and semantic search",
    inputSchema: {
      type: "object" as const,
      properties: {
        searchTerm: { type: "string", description: "Product to search for" },
        limit: { type: "number", description: "Maximum results (default: 5)" },
      },
      required: ["searchTerm"],
    },
  },
  {
    name: "mcp__willys_preferred_list",
    description:
      "Browsing-only: show every item in the preferred list. Use when the user asks 'what's in my preferred list' or 'show my preferred items'. NEVER use this as the first step of 'add X to cart' — call mcp__willys_preferred_add for that.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "mcp__willys_preferred_search",
    description:
      "Browsing-only: show preferred items matching a keyword (with alias/name/category/vector resolution). Use when the user asks 'do I have X in my preferred list?'. For 'add X to cart' requests use mcp__willys_preferred_add — it does the same search AND adds in one call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Product name to look up" },
        limit: { type: "number", description: "Maximum results (default: 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "mcp__willys_preferred_remove",
    description: "Remove one product from the preferred list by its product code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productCode: { type: "string", description: "Product code to remove" },
      },
      required: ["productCode"],
    },
  },
  {
    name: "mcp__willys_preferred_mark",
    description:
      "Mark a specific product as preferred. Use this when the user says 'remember this' / 'add to preferred' / 'mark X as preferred', picking the productCode from earlier in the conversation (e.g. the item we just added to cart, or one of the numbered search results). If the product isn't in our local cache yet you must also pass its name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productCode: {
          type: "string",
          description: "Product code to mark preferred (from conversation context)",
        },
        name: {
          type: "string",
          description: "Product name — required only if the product isn't already in the local cache.",
        },
      },
      required: ["productCode"],
    },
  },
  {
    name: "mcp__willys_preferred_replace_with_cart",
    description:
      "DESTRUCTIVE: wipe the entire preferred list and replace it with the current Willys cart contents. Always ask the user 'are you sure?' first and only call this with confirm=true after they answer yes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean",
          description: "Must be true. Without it the tool returns an error explaining the destructive intent.",
        },
      },
      required: ["confirm"],
    },
  },
  {
    name: "mcp__willys_preferred_update_from_cart",
    description:
      "Insert every cart item that is not already preferred into the preferred list. Existing preferred rows are left untouched (their preferred_at timestamp is preserved). Non-destructive.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "mcp__willys_preferred_add",
    description:
      "PRIMARY TOOL for 'add X to cart' requests (milk, coffee, eggs, etc.). Always call this FIRST. Resolution order: alias → preferred-name → preferred-category → semantic vector → live Willys-search ∩ preferred. Returns one of: ✅ added (with the substituted product name); ❓ multiple candidates (ask user, then call again with their chosen productCode); ↪ no preferred match (only then fall back to mcp__willys_search, ask user to pick, then mcp__willys_add_to_cart). Never call mcp__willys_search before this tool — this tool already does Willys search as its last layer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "What the user asked for, e.g. 'milk', 'coffee', 'havremjölk'",
        },
        quantity: { type: "number", description: "Quantity (default: 1)" },
        productCode: {
          type: "string",
          description: "Optional. Pass when disambiguating after a multi-match — skips the resolve step and adds this exact code.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "mcp__willys_preferred_alias_add",
    description:
      "Register a short keyword (e.g. 'milk') that maps to a specific preferred product code. Use to fix cross-lingual mismatches (English voice request → Swedish product name). One alias maps to one product; to express 'milk could mean oat OR lactose-free', use two distinct aliases like 'havremjölk' and 'laktosfri'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        alias: { type: "string", description: "Keyword to register (lowercased automatically)" },
        productCode: { type: "string", description: "Target product code" },
      },
      required: ["alias", "productCode"],
    },
  },
  {
    name: "mcp__willys_preferred_alias_remove",
    description: "Remove a single alias.",
    inputSchema: {
      type: "object" as const,
      properties: {
        alias: { type: "string", description: "Keyword to remove" },
      },
      required: ["alias"],
    },
  },
  {
    name: "mcp__willys_preferred_alias_list",
    description:
      "Show registered aliases. Omit productCode to dump all; pass it to see aliases for one product.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productCode: { type: "string", description: "Optional filter" },
      },
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Tool-call telemetry. Redact password on login; keep everything else
  // visible so we can diagnose hallucinated tool calls vs. real failures.
  // stderr only (stdout is reserved for JSON-RPC).
  const redacted = (name === "mcp__willys_login" && args)
    ? { ...args, password: "***" }
    : args;
  const callT0 = Date.now();
  console.error(`[mcp-call] ${name} args=${JSON.stringify(redacted)}`);

  try {
    switch (name) {
      case "mcp__willys_login": {
        const { username, password } = args as {
          username: string;
          password: string;
        };
        const sessionId = mcpSessionStore.generateSessionId();
        const result = await mcpAuthenticateWithWillys(sessionId, {
          username,
          password,
        });

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `✅ Successfully logged in. The session is now active and used automatically by all other tools — no further action needed.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `❌ Login failed: ${result.error || "Invalid credentials"}`,
            },
          ],
        };
      }

      case "mcp__willys_logout": {
        const { sessionId = DEFAULT_SESSION_ID } = args as { sessionId?: string };
        await mcpLogout(sessionId);
        return {
          content: [{ type: "text", text: "✅ Successfully logged out" }],
        };
      }

      case "mcp__willys_check_auth": {
        const { sessionId = DEFAULT_SESSION_ID } = args as { sessionId?: string };
        const isAuth = await mcpIsAuthenticated(sessionId);
        return {
          content: [
            {
              type: "text",
              text: isAuth ? "✅ Authenticated" : "❌ Not authenticated",
            },
          ],
        };
      }

      case "mcp__willys_get_orders": {
        const { sessionId = DEFAULT_SESSION_ID } = args as { sessionId?: string };
        const orders = await mcpGetOrders(sessionId);
        return {
          content: [
            {
              type: "text",
              text: formatOrders(orders as unknown as Record<string, unknown>[]),
            },
          ],
        };
      }

      case "mcp__willys_get_order_details": {
        const { sessionId = DEFAULT_SESSION_ID, orderId } = args as {
          sessionId?: string;
          orderId: string;
        };
        const order = await mcpGetOrderDetails(sessionId, orderId);
        if (!order) {
          return { content: [{ type: "text", text: `❌ Order not found` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: formatOrderDetails(order as unknown as Record<string, unknown>),
            },
          ],
        };
      }

      case "mcp__willys_get_cart": {
        const { sessionId = DEFAULT_SESSION_ID } = args as { sessionId?: string };
        const cart = await mcpGetCart(sessionId);
        if (!cart) {
          return {
            content: [{ type: "text", text: `❌ Failed to fetch cart` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatCart(cart as unknown as Record<string, unknown>),
            },
          ],
        };
      }

      case "mcp__willys_add_to_cart": {
        const {
          sessionId = DEFAULT_SESSION_ID,
          productCode,
          quantity = 1,
        } = args as {
          sessionId?: string;
          productCode: string;
          quantity?: number;
        };
        const result = await mcpAddToCart(sessionId, productCode, quantity);
        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Added to cart`
                : `❌ ${result.message}`,
            },
          ],
        };
      }

      case "mcp__willys_remove_from_cart": {
        const { sessionId = DEFAULT_SESSION_ID, productCode } = args as {
          sessionId?: string;
          productCode: string;
        };
        const result = await mcpRemoveFromCart(sessionId, productCode);
        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Removed from cart`
                : `❌ ${result.message}`,
            },
          ],
        };
      }

      case "mcp__willys_checkout": {
        const { sessionId = DEFAULT_SESSION_ID } = args as { sessionId?: string };
        const result = await mcpCheckout(sessionId);
        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Checkout initiated`
                : `❌ ${result.message}`,
            },
          ],
        };
      }

      case "mcp__willys_get_customer_info": {
        const { sessionId = DEFAULT_SESSION_ID } = args as { sessionId?: string };
        const customer = await mcpGetCustomerInfo(sessionId);
        if (!customer) {
          return {
            content: [{ type: "text", text: `❌ Failed to get customer info` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatCustomerInfo(customer as unknown as Record<string, unknown>),
            },
          ],
        };
      }

      case "mcp__willys_get_delivery_slots": {
        const { sessionId = DEFAULT_SESSION_ID, postalCode = "12345" } = args as {
          sessionId?: string;
          postalCode?: string;
        };
        const slots = await mcpGetDeliverySlots(sessionId, postalCode);
        if (!slots) {
          return {
            content: [
              { type: "text", text: `❌ Failed to get delivery slots` },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatDeliverySlots(slots as unknown as Record<string, unknown>),
            },
          ],
        };
      }

      case "mcp__willys_get_pickup_slots": {
        const { sessionId = DEFAULT_SESSION_ID, storeId = "2288" } = args as {
          sessionId?: string;
          storeId?: string;
        };
        const slots = await mcpGetPickupSlots(sessionId, storeId);
        if (!slots) {
          return {
            content: [{ type: "text", text: `❌ Failed to get pickup slots` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatPickupSlots(slots as unknown as Record<string, unknown>),
            },
          ],
        };
      }

      case "mcp__willys_select_slot": {
        const {
          sessionId = DEFAULT_SESSION_ID,
          slotCode,
          isTmsSlot = false,
        } = args as {
          sessionId?: string;
          slotCode: string;
          isTmsSlot?: boolean;
        };
        const result = await mcpSelectSlot(sessionId, slotCode, isTmsSlot);
        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Slot selected`
                : `❌ ${result.message}`,
            },
          ],
        };
      }

      case "mcp__willys_search": {
        const {
          sessionId = DEFAULT_SESSION_ID,
          query,
          page = 0,
          size = 30,
        } = args as {
          sessionId?: string;
          query: string;
          page?: number;
          size?: number;
        };
        const result = await mcpSearchProducts(sessionId, query, page, size);
        if (!result.success) {
          return { content: [{ type: "text", text: `❌ ${result.message}` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: formatSearchResults(query, result.products as unknown as Record<string, unknown>[]),
            },
          ],
        };
      }

      case "mcp__willys_search_suggestions": {
        const { sessionId = DEFAULT_SESSION_ID, query } = args as {
          sessionId?: string;
          query: string;
        };
        const result = await mcpGetSearchSuggestions(sessionId, query);
        if (!result.success) {
          return { content: [{ type: "text", text: `❌ ${result.message}` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: formatSearchSuggestions(query, result.suggestions),
            },
          ],
        };
      }

      case "mcp__willys_get_offers": {
        const { sessionId = DEFAULT_SESSION_ID } = args as { sessionId?: string };
        const result = await mcpGetOffers(sessionId);
        if (!result.success) {
          return { content: [{ type: "text", text: `❌ ${result.message}` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: formatOffers(result.offers),
            },
          ],
        };
      }

      case "mcp__willys_get_common_products": {
        const { sessionId = DEFAULT_SESSION_ID } = args as { sessionId?: string };
        const result = await mcpGetCommonProducts(sessionId);
        if (!result.success) {
          return { content: [{ type: "text", text: `❌ ${result.message}` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: formatCommonProducts(result.commonProducts),
            },
          ],
        };
      }

      case "mcp__willys_get_product_detail": {
        const { sessionId = DEFAULT_SESSION_ID, productCode, productName } = args as {
          sessionId?: string;
          productCode: string;
          productName?: string;
        };
        const result = await mcpGetProductDetail(
          sessionId,
          productCode,
          productName,
        );
        if (!result.success) {
          return { content: [{ type: "text", text: `❌ ${result.message}` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: formatProductDetail(result.productDetail as unknown as Record<string, unknown>),
            },
          ],
        };
      }

      case "mcp__willys_get_smart_product_matches": {
        const {
          sessionId = DEFAULT_SESSION_ID,
          searchTerm,
          limit = 5,
        } = args as { sessionId?: string; searchTerm: string; limit?: number };
        const result = await mcpGetSmartProductMatches(
          sessionId,
          searchTerm,
          limit,
        );
        if (!result.success) {
          return { content: [{ type: "text", text: `❌ ${result.message}` }] };
        }
        const matches = result.matches || [];
        let text = `✅ Smart matches for "${searchTerm}":\n\n`;
        matches.forEach(
          (
            match: {
              product: { name: string; code: string; price?: string };
              score: number;
              frequency: number;
            },
            i: number,
          ) => {
            text += `${i + 1}. ${match.product.name} (${match.product.code}) - Score: ${match.score}, Freq: ${match.frequency}\n`;
          },
        );
        return { content: [{ type: "text", text }] };
      }

      case "mcp__willys_preferred_list": {
        const items = willysDatabase.listPreferred();
        return {
          content: [{ type: "text", text: formatPreferredList(items) }],
        };
      }

      case "mcp__willys_preferred_search": {
        const { query, limit = 5 } = args as { query: string; limit?: number };
        // Use the full resolvePreferred flow (alias → name → category) plus
        // a vector pass — so even if the LLM uses this tool instead of
        // preferred_add, it sees the same quality of matches.
        let matches: Array<{
          productCode: string;
          name: string;
          manufacturer: string | null;
          matchedBy: string;
        }> = willysDatabase.resolvePreferred(query, limit);
        console.error(
          `[preferred_search] "${query}" → resolvePreferred returned ${matches.length} hit(s)`,
        );
        if (matches.length === 0) {
          try {
            const qVec = await generateQueryEmbedding(query);
            const T = parseFloat(
              process.env.WILLYS_VECTOR_THRESHOLD || "0.70",
            );
            const vecHits = willysDatabase
              .vectorSearchPreferred(qVec, limit)
              .filter((h) => h.similarity >= T);
            console.error(
              `[preferred_search] "${query}" → vector returned ${vecHits.length} hit(s) above ${T}`,
            );
            matches = vecHits.map((h) => ({
              productCode: h.productCode,
              name: h.name,
              manufacturer: h.manufacturer,
              matchedBy: "vector",
            }));
          } catch (e) {
            console.error(
              `[preferred_search] vector pass failed: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No preferred items match "${query}". For adding to cart, prefer mcp__willys_preferred_add (it falls back to live Willys search ∩ preferred automatically). Only call mcp__willys_search if the user wants to browse non-preferred Willys results.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Preferred matches for "${query}":\n${formatPreferredList(matches)}`,
            },
          ],
        };
      }

      case "mcp__willys_preferred_remove": {
        const { productCode } = args as { productCode: string };
        const removed = willysDatabase.removePreferred(productCode);
        return {
          content: [
            {
              type: "text",
              text: removed
                ? `✅ Removed ${productCode} from preferred list.`
                : `❌ ${productCode} was not in the preferred list.`,
            },
          ],
        };
      }

      case "mcp__willys_preferred_mark": {
        const { productCode, name: nameArg } = args as {
          productCode: string;
          name?: string;
        };
        const cachedName =
          nameArg ?? willysDatabase.getProductNameByCode(productCode);
        if (!cachedName) {
          return {
            content: [
              {
                type: "text",
                text: `❌ ${productCode} not in cache and no name argument supplied. Either pass name="..." (you can read it from the conversation context where this code appeared) or look up the product first.`,
              },
            ],
          };
        }
        const { newlyPreferred } = willysDatabase.addPreferred(
          productCode,
          cachedName,
          null,
          { overwriteTimestamp: true },
        );
        enrichPreferredItem(DEFAULT_SESSION_ID, productCode, cachedName).catch(
          (e) =>
            console.error(
              `inline enrich ${productCode} failed: ${e instanceof Error ? e.message : e}`,
            ),
        );
        console.error(
          `[preferred_mark] ${productCode} "${cachedName}" → ${newlyPreferred ? "NEWLY preferred" : "timestamp refreshed"}`,
        );
        return {
          content: [
            {
              type: "text",
              text: newlyPreferred
                ? `✅ Marked "${cachedName}" [${productCode}] as preferred.`
                : `ℹ️  "${cachedName}" [${productCode}] was already preferred (timestamp refreshed).`,
            },
          ],
        };
      }

      case "mcp__willys_preferred_replace_with_cart": {
        const { confirm, sessionId = DEFAULT_SESSION_ID } = args as {
          confirm: boolean;
          sessionId?: string;
        };
        if (confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: "⚠️  This will WIPE the entire preferred list and replace it with the current Willys cart. Ask the user to confirm, then call again with confirm=true.",
              },
            ],
          };
        }
        const cart = await mcpGetCart(sessionId);
        const products = (cart?.products ?? []) as Array<{
          code: string;
          name: string;
          manufacturer?: string;
          categoryName?: string;
        }>;
        if (products.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "❌ Current cart is empty — refusing to wipe preferred list with nothing to put in its place.",
              },
            ],
          };
        }
        const cleared = willysDatabase.clearAllPreferred();
        let added = 0;
        for (const p of products) {
          if (!p.code || !p.name) continue;
          willysDatabase.addPreferred(p.code, p.name, p.manufacturer ?? null, {
            overwriteTimestamp: true,
            category: p.categoryName ?? null,
          });
          added++;
        }
        // Kick off enrichment in the background so the new preferred items
        // get description + embedding without blocking the LLM.
        enrichPreferredBacklog().catch((e) =>
          console.error(
            `enrich-after-replace failed: ${e instanceof Error ? e.message : e}`,
          ),
        );
        return {
          content: [
            {
              type: "text",
              text: `✅ Preferred list replaced: cleared ${cleared} old item(s), added ${added} from current cart. Enrichment running in background.`,
            },
          ],
        };
      }

      case "mcp__willys_preferred_update_from_cart": {
        const { sessionId = DEFAULT_SESSION_ID } = args as {
          sessionId?: string;
        };
        const cart = await mcpGetCart(sessionId);
        const products = (cart?.products ?? []) as Array<{
          code: string;
          name: string;
          manufacturer?: string;
          categoryName?: string;
        }>;
        if (products.length === 0) {
          return {
            content: [
              { type: "text", text: "ℹ️  Cart is empty — nothing to add." },
            ],
          };
        }
        let inserted = 0;
        let skipped = 0;
        for (const p of products) {
          if (!p.code || !p.name) continue;
          const { newlyPreferred } = willysDatabase.addPreferred(
            p.code,
            p.name,
            p.manufacturer ?? null,
            { overwriteTimestamp: false, category: p.categoryName ?? null },
          );
          if (newlyPreferred) inserted++;
          else skipped++;
        }
        if (inserted > 0) {
          enrichPreferredBacklog().catch((e) =>
            console.error(
              `enrich-after-update failed: ${e instanceof Error ? e.message : e}`,
            ),
          );
        }
        return {
          content: [
            {
              type: "text",
              text: `✅ Preferred list updated: ${inserted} new item(s) added, ${skipped} already preferred (left unchanged).${inserted > 0 ? " Enrichment running in background." : ""}`,
            },
          ],
        };
      }

      case "mcp__willys_preferred_add": {
        const {
          sessionId = DEFAULT_SESSION_ID,
          query,
          quantity = 1,
          productCode,
        } = args as {
          sessionId?: string;
          query: string;
          quantity?: number;
          productCode?: string;
        };

        // Disambiguation path: caller already picked a code after a
        // previous multi-match. Skip resolution and add directly.
        if (productCode) {
          const result = await mcpAddToCart(sessionId, productCode, quantity);
          const cachedName =
            willysDatabase.getProductNameByCode(productCode) || productCode;
          return {
            content: [
              {
                type: "text",
                text: result.success
                  ? `✅ Added ${quantity}× "${cachedName}" [${productCode}]${result.message ? ` — ${result.message}` : ""}`
                  : `❌ ${result.message}`,
              },
            ],
          };
        }

        console.error(`[preferred_add] resolving "${query}"…`);
        let matches: Array<{
          productCode: string;
          name: string;
          manufacturer: string | null;
          matchedBy: "alias" | "name" | "category" | "vector" | "willys-fallback";
        }> = willysDatabase.resolvePreferred(query, 5);
        if (matches.length > 0) {
          console.error(
            `[preferred_add] layer 1 (alias/name/category) → ${matches.length} hit(s): ${matches.map((m) => `${m.name}[${m.matchedBy}]`).join(", ")}`,
          );
        } else {
          console.error(
            `[preferred_add] layer 1 (alias/name/category) → no hits`,
          );
        }

        // Vector layer: semantic k-NN over preferred items embedded with
        // name + manufacturer + category (+ description when we have it).
        //
        // Two knobs, both tuned empirically against a real 18-item preferred
        // list with multilingual-e5-small on grocery text:
        //
        //   WILLYS_VECTOR_THRESHOLD (default 0.70) — minimum similarity for
        //     a hit to count at all. Below this is noise; the query falls
        //     through to the live Willys-search layer.
        //
        //   WILLYS_VECTOR_GAP (default 0.010) — minimum margin between top-1
        //     and top-2 to treat the top hit as unambiguous and auto-add.
        //     Without this rule everything ends up "ask the user" because
        //     multilingual-e5-small produces clusters of close scores when
        //     the index has visually-similar items (e.g. you have 3 cheese
        //     snacks — "cheese" → all three at ~0.745). With this rule:
        //     • clear-winner queries auto-add (e.g. "brun farin" → 0.752 vs
        //       0.685, gap 0.067)
        //     • cluster queries return all candidates and ask the user
        //
        // Override via env if you find the defaults annoying.
        const VECTOR_THRESHOLD = parseFloat(
          process.env.WILLYS_VECTOR_THRESHOLD || "0.70",
        );
        const VECTOR_GAP = parseFloat(
          process.env.WILLYS_VECTOR_GAP || "0.010",
        );
        if (matches.length === 0) {
          try {
            const qVec = await generateQueryEmbedding(query);
            const allHits = willysDatabase.vectorSearchPreferred(qVec, 5);
            console.error(
              `[preferred_add] layer 2 (vector, threshold=${VECTOR_THRESHOLD}, gap=${VECTOR_GAP}) raw top: ${allHits
                .slice(0, 3)
                .map((h) => `${h.similarity.toFixed(3)}=${h.name}`)
                .join(" | ")}`,
            );
            const aboveThreshold = allHits.filter(
              (h) => h.similarity >= VECTOR_THRESHOLD,
            );
            if (aboveThreshold.length > 0) {
              const top = aboveThreshold[0];
              const second = aboveThreshold[1];
              const isUnambiguous =
                !second || top.similarity - second.similarity >= VECTOR_GAP;
              const accepted = isUnambiguous ? [top] : aboveThreshold;
              console.error(
                `preferred_add: vector layer returned ${aboveThreshold.length} hit(s) above ${VECTOR_THRESHOLD}; ` +
                  (isUnambiguous
                    ? `top=${top.similarity.toFixed(3)} gap=${second ? (top.similarity - second.similarity).toFixed(3) : "n/a"} → auto-add`
                    : `top gap ${(top.similarity - second.similarity).toFixed(3)} < ${VECTOR_GAP} → ask user`),
              );
              matches = accepted.map((h) => ({
                productCode: h.productCode,
                name: h.name,
                manufacturer: h.manufacturer,
                matchedBy: "vector" as const,
              }));
            }
          } catch (e) {
            console.error(
              `preferred_add: vector layer failed (${e instanceof Error ? e.message : e}); falling through to Willys search`,
            );
          }
        }

        // Live Willys-search fallback. If layers 1–3 produce nothing, let
        // Willys' own search index do the heavy lifting — it understands
        // product descriptions, ingredients, tags, cross-language tokens etc.
        // We then INTERSECT with preferred. *Important*: per user feedback,
        // this layer NEVER auto-adds, even if there's a clean 1-match
        // intersection — the chain of inference (Willys query → match → user
        // intent) is too lossy. Always ask first.
        let isFromWillysFallback = false;
        if (matches.length === 0) {
          console.error(
            `[preferred_add] layer 3 (Willys-search ∩ preferred) — calling Willys…`,
          );
          const search = await mcpSearchProducts(sessionId, query, 0, 30);
          if (search.success && search.products && search.products.length > 0) {
            const codes = search.products
              .map((p) => p.code)
              .filter(Boolean) as string[];
            const intersection = willysDatabase.filterPreferredByCodes(codes);
            console.error(
              `[preferred_add] Willys returned ${codes.length} candidates; ${intersection.length} are in preferred`,
            );
            if (intersection.length > 0) {
              isFromWillysFallback = true;
              matches = intersection.map((m) => ({
                productCode: m.productCode,
                name: m.name,
                manufacturer: m.manufacturer,
                matchedBy: "willys-fallback" as const,
              }));
            }
          } else {
            console.error(
              `[preferred_add] Willys search returned no results (success=${search.success})`,
            );
          }
        }

        if (matches.length === 0) {
          console.error(`[preferred_add] "${query}" → no match anywhere`);
          return {
            content: [
              {
                type: "text",
                text: `No preferred match for "${query}" (tried alias, name, category, semantic vector, and Willys search ∩ preferred). If the user wants this product anyway, call mcp__willys_search "${query}", show them the numbered results, and ask which one they want before calling mcp__willys_add_to_cart.`,
              },
            ],
          };
        }

        const viaMap = {
          alias: "via alias",
          name: "from preferred name",
          category: "from preferred category",
          vector: "via semantic match",
          "willys-fallback": "via Willys search ∩ preferred",
        } as const;

        // High-confidence auto-add ONLY when the match came from a local
        // layer (alias / name / category / vector) AND is unambiguous.
        // Willys-fallback always asks — even a 1-match intersection.
        if (matches.length === 1 && !isFromWillysFallback) {
          const m = matches[0];
          console.error(
            `[preferred_add] "${query}" → AUTO-ADD ${m.name} [${m.productCode}] (${m.matchedBy})`,
          );
          const result = await mcpAddToCart(sessionId, m.productCode, quantity);
          return {
            content: [
              {
                type: "text",
                text: result.success
                  ? `✅ Added ${quantity}× "${m.name}" [${m.productCode}] (${viaMap[m.matchedBy]})${result.message ? ` — ${result.message}` : ""}`
                  : `❌ ${result.message}`,
              },
            ],
          };
        }

        // Multi-match OR willys-fallback (regardless of count) → ask user.
        console.error(
          `[preferred_add] "${query}" → ASK USER (${matches.length} candidate${matches.length === 1 ? "" : "s"}, willys-fallback=${isFromWillysFallback})`,
        );
        const lines = matches.map(
          (m, i) =>
            `${i + 1}. ${m.name}${m.manufacturer ? ` (${m.manufacturer})` : ""} [${m.productCode}] — ${viaMap[m.matchedBy]}`,
        );
        const lead = isFromWillysFallback
          ? `❓ Found preferred match(es) for "${query}" via live Willys search — confirm with the user which one before adding. Then call mcp__willys_preferred_add again with the chosen productCode:`
          : `❓ Multiple preferred matches for "${query}" — ask the user which one, then call mcp__willys_preferred_add again with the chosen productCode:`;
        return {
          content: [{ type: "text", text: `${lead}\n${lines.join("\n")}` }],
        };
      }

      case "mcp__willys_preferred_alias_add": {
        const { alias, productCode } = args as {
          alias: string;
          productCode: string;
        };
        const result = willysDatabase.addAlias(alias, productCode);
        return {
          content: [
            {
              type: "text",
              text: result.ok
                ? `✅ Alias "${alias.toLowerCase().trim()}" → ${productCode} registered.`
                : `❌ ${result.reason}`,
            },
          ],
        };
      }

      case "mcp__willys_preferred_alias_remove": {
        const { alias } = args as { alias: string };
        const removed = willysDatabase.removeAlias(alias);
        return {
          content: [
            {
              type: "text",
              text: removed
                ? `✅ Removed alias "${alias.toLowerCase().trim()}".`
                : `❌ No alias "${alias}" found.`,
            },
          ],
        };
      }

      case "mcp__willys_preferred_alias_list": {
        const { productCode } = args as { productCode?: string };
        const rows = willysDatabase.listAliases(productCode);
        return {
          content: [{ type: "text", text: formatAliases(rows) }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[mcp-call] ${name} FAILED (${Date.now() - callT0}ms): ${msg}`);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${msg}`,
        },
      ],
      isError: true,
    };
  }
});

async function autoLoginIfConfigured(): Promise<void> {
  const creds = readCredentialsFile();
  if (!creds) {
    console.error(
      "No .credentials file found; skipping auto-login. Use mcp__willys_login.",
    );
    return;
  }
  try {
    const result = await mcpAuthenticateWithWillys(DEFAULT_SESSION_ID, creds);
    if (result.success) {
      console.error(
        `Auto-login OK; default sessionId='${DEFAULT_SESSION_ID}' active for 24h.`,
      );
    } else {
      console.error(`Auto-login failed: ${result.error ?? "unknown error"}`);
    }
  } catch (err) {
    console.error(
      `Auto-login threw: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const REFRESH_INTERVAL_HOURS = 4;

function scheduleProactiveRefresh(): void {
  if (!readCredentialsFile()) return;
  const intervalMs = REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
  setInterval(() => {
    console.error(
      `Proactive Willys session refresh (every ${REFRESH_INTERVAL_HOURS}h)...`,
    );
    autoLoginIfConfigured().catch((err) =>
      console.error(
        `Scheduled refresh threw: ${err instanceof Error ? err.message : err}`,
      ),
    );
  }, intervalMs);
  console.error(
    `Scheduled proactive Willys re-login every ${REFRESH_INTERVAL_HOURS}h.`,
  );
}

// Fix 2: one-time backfill from order history.
// If the relational `orders` table is empty (e.g. after a fresh container or
// the first deploy with persistence wired up), walk the user's order history
// once and pull details for each. fetchOrderDetails() calls
// storeOrderRelational() under the hood, which populates orders / products /
// categories / order_products — the tables hybridSearchProducts() reads from.
// Runs in the background; never blocks startup. Bounded + rate-limited.
const BACKFILL_MAX_ORDERS = 50;
const BACKFILL_DELAY_MS = 500;

async function backfillFromOrderHistoryIfEmpty(): Promise<void> {
  if (willysDatabase.countOrders() > 0) {
    console.error(
      `Backfill skipped: ${willysDatabase.countOrders()} orders already in relational schema.`,
    );
    return;
  }
  console.error(
    "Relational schema is empty — backfilling from Willys order history…",
  );
  let cookies: string;
  try {
    cookies = await mcpGetWillysCookies(DEFAULT_SESSION_ID);
  } catch (err) {
    console.error(
      `Backfill: cannot get session cookies (${err instanceof Error ? err.message : err}) — skipping.`,
    );
    return;
  }
  const orders = await mcpGetOrders(DEFAULT_SESSION_ID);
  if (orders.length === 0) {
    console.error("Backfill: order history is empty — nothing to do.");
    return;
  }
  const toFetch = orders.slice(0, BACKFILL_MAX_ORDERS);
  console.error(
    `Backfill: fetching details for ${toFetch.length}/${orders.length} orders (cap=${BACKFILL_MAX_ORDERS})…`,
  );
  let ok = 0;
  let failed = 0;
  for (const order of toFetch) {
    if (!order.orderNumber) continue;
    const details = await fetchOrderDetails(order.orderNumber, {
      cookies,
      sessionId: DEFAULT_SESSION_ID,
      useCache: true,
    });
    if (details) ok++;
    else failed++;
    await new Promise((resolve) => setTimeout(resolve, BACKFILL_DELAY_MS));
  }
  console.error(
    `Backfill done: ${ok} orders ingested, ${failed} failed. ` +
      `Now: ${willysDatabase.countOrders()} orders in relational schema.`,
  );
}

// ─── Preferred-item enrichment: description + embedding ──────────────────
// Builds the embedding input from name + manufacturer + category + description.
// Skipping any field that's null keeps the model focused; e5 is robust to
// short inputs.
function buildEmbeddingText(p: {
  name: string;
  manufacturer?: string | null;
  category?: string | null;
  description?: string | null;
}): string {
  return [p.name, p.manufacturer ?? "", p.category ?? "", p.description ?? ""]
    .filter(Boolean)
    .join(" — ");
}

async function enrichPreferredItem(
  sessionId: string,
  productCode: string,
  name: string,
): Promise<void> {
  // 1) Fetch description if we don't have one yet. Wrap defensively — the
  // product detail endpoint changes shape and we don't want one bad response
  // to nuke the enrichment for the rest of the batch.
  let description: string | null = null;
  try {
    const detail = await mcpGetProductDetail(sessionId, productCode, name);
    if (detail.success && detail.productDetail) {
      description = extractProductDescription(detail.productDetail);
      if (description) {
        willysDatabase.storeProductDescription(productCode, description);
      }
    }
  } catch (e) {
    console.error(
      `enrich: product detail fetch failed for ${productCode}: ${e instanceof Error ? e.message : e}`,
    );
  }

  // 2) Generate embedding using whatever metadata we have on the row.
  try {
    const row = willysDatabase
      .listPreferredMissingEmbedding()
      .find((r) => r.productCode === productCode);
    if (!row) return; // already embedded by a concurrent call
    const text = buildEmbeddingText({
      name: row.name,
      manufacturer: row.manufacturer,
      category: row.category,
      description: row.description,
    });
    const [vec] = await generatePassageEmbeddingsBatch([text]);
    willysDatabase.storeProductEmbedding(productCode, vec);
  } catch (e) {
    console.error(
      `enrich: embedding generation failed for ${productCode}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

const ENRICH_DELAY_MS = 250;

async function enrichPreferredBacklog(): Promise<void> {
  const missing = [
    ...new Map(
      willysDatabase
        .listPreferredMissingEmbedding()
        .map((p) => [p.productCode, p]),
    ).values(),
  ];
  if (missing.length === 0) {
    console.error("Preferred enrichment: nothing to do.");
    return;
  }
  console.error(
    `Preferred enrichment: ${missing.length} item(s) need description+embedding…`,
  );
  let ok = 0;
  let failed = 0;
  for (const p of missing) {
    try {
      await enrichPreferredItem(DEFAULT_SESSION_ID, p.productCode, p.name);
      ok++;
    } catch (e) {
      console.error(
        `enrich ${p.productCode} (${p.name}) FAILED: ${e instanceof Error ? e.message : e}`,
      );
      failed++;
    }
    await new Promise((r) => setTimeout(r, ENRICH_DELAY_MS));
  }
  console.error(
    `Preferred enrichment done: ${ok} ok, ${failed} failed. Remaining missing: ${willysDatabase.listPreferredMissingEmbedding().length}`,
  );
}

// Start the server
async function main() {
  // Initialize database before starting server
  await willysDatabase.ensureInitialized();

  // Try to pre-authenticate using .credentials so callers can omit sessionId
  await autoLoginIfConfigured();
  scheduleProactiveRefresh();

  // Fire-and-forget the order-history backfill. We don't await it because it
  // can take minutes (50 orders × ~500 ms + HTTP) and there's no reason to
  // block the MCP transport — the LLM can use live API calls in the meantime
  // and the cache will be there for subsequent calls.
  backfillFromOrderHistoryIfEmpty().catch((err) =>
    console.error(
      `Backfill threw: ${err instanceof Error ? err.message : err}`,
    ),
  );

  // Same for preferred-item enrichment: walks every preferred row missing
  // an embedding and fills in description + vector. New items added later
  // via `mcp__willys_preferred_*` tools trigger an inline enrich, so this
  // is mainly for the one-time backfill after the embedding service comes
  // online or after `preferred_replace_with_cart`.
  enrichPreferredBacklog().catch((err) =>
    console.error(
      `Preferred enrichment threw: ${err instanceof Error ? err.message : err}`,
    ),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Willys MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
