"use server";

import type {
  RawCartResponse,
  RawCustomerResponse,
  RawOrder,
  RawOrderDetails,
  RawProduct,
  RawSavedCard,
  WillysCart,
  WillysCustomer,
  WillysDeliverySlotsResponse,
  WillysOrder,
  WillysOrderItem,
  WillysPickupSlotsResponse,
} from "@/lib/types";
import { readCredentialsFile } from "./credentials";
import { mcpAuthenticateWithWillys, mcpGetWillysCookies } from "./mcp-auth";
import {
  fetchCsrfToken,
  fetchWithRetry,
  generateTrackingHeaders,
  getApiHeaders,
  getCommonHeaders,
  getErrorMessage,
  truncateForLog,
} from "./request-utils";

/**
 * MCP-specific order functions that use session store for authentication
 */

function isCsrfOrAuthFailure(status: number, body: string): boolean {
  // Reauth on the full set of session-stale signatures observed from Willys:
  // 401/403 (classic auth failures), 419 (session expired in some Axfood
  // endpoints), and 500-class with csrf body (occasionally returned when the
  // CSRF token is stale rather than missing). The previous narrow body
  // check missed cases where the response body didn't lowercase-include
  // "csrf"/"unauthorized" verbatim, which caused mcpAddToCart to surface a
  // raw failure to the LLM — once the model sees that, it "learns" within
  // the conversation to stop calling the tool. Better to retry one too
  // many times than too few.
  if (status === 401 || status === 403 || status === 419) return true;
  const lc = body.toLowerCase();
  if (lc.includes("csrf")) return true;
  if (lc.includes("unauthorized")) return true;
  if (lc.includes("session") && lc.includes("expired")) return true;
  return false;
}

async function refreshSession(sessionId: string): Promise<boolean> {
  const creds = readCredentialsFile();
  if (!creds) {
    console.error("Auto-reauth skipped: no .credentials file available");
    return false;
  }
  const result = await mcpAuthenticateWithWillys(sessionId, creds);
  if (result.success) {
    console.error(`Auto-reauth succeeded for session ${sessionId}`);
    return true;
  }
  console.error(`Auto-reauth failed: ${result.error ?? "unknown error"}`);
  return false;
}

// Run a request that needs a valid session; on CSRF/401 failure, refresh the
// Willys session via Puppeteer login and retry the request once.
async function withAuthRefresh(
  sessionId: string,
  request: (cookies: string) => Promise<Response>,
): Promise<Response> {
  let cookies = await mcpGetWillysCookies(sessionId);
  if (!cookies) throw new Error("No authentication cookies found");

  const response = await request(cookies);
  if (response.ok) return response;
  if (response.status !== 401 && response.status !== 403) return response;

  const body = await response.clone().text();
  if (!isCsrfOrAuthFailure(response.status, body)) return response;

  console.error(
    `Auth/CSRF failure (status ${response.status}): ${truncateForLog(body, 80)} — refreshing session...`,
  );
  const refreshed = await refreshSession(sessionId);
  if (!refreshed) return response;

  cookies = await mcpGetWillysCookies(sessionId);
  if (!cookies) return response;

  console.error("Retrying request after session refresh");
  return request(cookies);
}

function parseCurrencyToNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  let s = value.replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (s.includes(",") && s.includes(".")) {
    if (s.indexOf(".") < s.indexOf(",")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

export async function mcpGetOrders(sessionId: string): Promise<WillysOrder[]> {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    console.error(
      "Using MCP cookies for orders request:",
      truncateForLog(cookies, 100),
    );

    const response = await fetchWithRetry(
      "https://www.willys.se/axfood/rest/account/orders",
      { headers: getApiHeaders(cookies) },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch orders: ${response.status}`);
    }

    const data = await response.json();
    console.error("Raw MCP Willys API response:", JSON.stringify(data, null, 2));

    const rawOrders: RawOrder[] = Array.isArray(data)
      ? data
      : data.orders || [];

    const mapped: WillysOrder[] = rawOrders.map((o: RawOrder) => {
      const deliveryDate =
        o.deliveryFormattedDate || o.formattedOrderDate || "";
      const statusCode: string | undefined =
        (typeof o.status === "object" ? o.status?.code : undefined) ??
        o.orderStatus?.code ??
        (typeof o.status === "string" ? o.status : undefined);
      const completed: boolean = Boolean(o.complete || o.completed);
      const status: string =
        completed || statusCode === "COMPLETED" ? "delivered" : "pending";

      const total: number =
        parseCurrencyToNumber(o.total) ||
        parseCurrencyToNumber(o.reservedAmount) ||
        (o.totalPrice &&
          parseCurrencyToNumber(
            o.totalPrice.value ?? o.totalPrice.formattedValue,
          )) ||
        0;

      return {
        orderNumber: String(o.orderNumber ?? o.code ?? o.guid ?? ""),
        deliveryDate,
        status,
        total,
        items: [],
      };
    });

    return mapped;
  } catch (error) {
    console.error("Error fetching MCP orders:", error);
    return [];
  }
}

export async function mcpGetCart(
  sessionId: string,
): Promise<WillysCart | null> {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    const csrfToken = await fetchCsrfToken(cookies);

    const response = await fetchWithRetry(
      "https://www.willys.se/axfood/rest/cart",
      {
        headers: {
          ...getApiHeaders(cookies, csrfToken),
          dnt: "1",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch cart: ${response.status}`);
    }

    const data: RawCartResponse = await response.json();

    // Map the response to our cart type
    const cart: WillysCart = {
      code: data.code || "",
      totalPrice: data.totalPrice || "0,00 kr",
      subTotalPrice: data.subTotalPrice || "0,00 kr",
      totalItems: data.totalItems || 0,
      totalUnitCount: data.totalUnitCount || 0,
      totalDiscount: data.totalDiscount || "0,00 kr",
      totalDiscountValue: data.totalDiscountValue || 0,
      totalTax: data.totalTax || "0,00 kr",
      bufferedAmount: data.bufferedAmount || "0,00 kr",
      reservedAmount: data.reservedAmount || "0,00 kr",
      orderDate: data.orderDate || "",
      deliveryCost: data.deliveryCost || "",
      pickUpCost: data.pickUpCost || "0,00 kr",
      serviceCost: data.serviceCost || "0,00 kr",
      pickAndPackCost: data.pickAndPackCost || "0,00 kr",
      products:
        data.products?.map((product: RawProduct) => ({
          code: product.code || "",
          name: product.name || "",
          price: product.price || "",
          priceValue: product.priceValue || 0,
          totalPrice:
            typeof product.totalPrice === "string"
              ? product.totalPrice
              : product.totalPrice?.formattedValue || "",
          totalDiscountedPrice: product.totalDiscountedPrice || "",
          quantity: product.quantity || 0,
          pickQuantity: product.pickQuantity || 0,
          categoryName: product.categoryName || "",
          manufacturer: product.manufacturer,
          displayVolume: product.displayVolume || "",
          image: product.image
            ? {
                url: product.image.url || "",
                altText: product.image.altText || "",
              }
            : undefined,
          thumbnail: product.thumbnail
            ? {
                url: product.thumbnail.url || "",
                altText: product.thumbnail.altText || "",
              }
            : undefined,
          unit: {
            code:
              (typeof product.unit === "object"
                ? product.unit?.code
                : undefined) || "",
            name:
              (typeof product.unit === "object"
                ? product.unit?.name
                : undefined) || "",
          },
          pickUnit: {
            code:
              (typeof product.pickUnit === "object"
                ? product.pickUnit?.code
                : undefined) || "",
            name:
              (typeof product.pickUnit === "object"
                ? product.pickUnit?.name
                : undefined) || "",
          },
          totalDiscount: product.totalDiscount || "0,00 kr",
          totalDiscountValue: product.totalDiscountValue || 0,
          outOfStock: product.outOfStock || false,
          canBeReplaced: product.canBeReplaced || false,
          doNotReplace: product.doNotReplace || false,
        })) || [],
    };

    return cart;
  } catch (error) {
    console.error("Error fetching MCP cart:", error);
    return null;
  }
}

export async function mcpGetOrderDetails(
  sessionId: string,
  orderNumber: string,
): Promise<WillysOrder | null> {
  const { orderCache } = await import("./mcp-order-cache");

  try {
    // Check cache first
    const cachedOrder = orderCache.getCachedOrder(orderNumber);
    if (cachedOrder) {
      console.error(`Cache hit for order ${orderNumber}`);

      // If cached data is in raw format (has categoryOrderedDeliveredProducts), transform it
      if (cachedOrder.categoryOrderedDeliveredProducts) {
        // Transform raw cached data to MCP format
        const items: WillysOrderItem[] = [];
        Object.entries(
          cachedOrder.categoryOrderedDeliveredProducts as Record<
            string,
            RawProduct[]
          >,
        ).forEach(([categoryName, products]) => {
          if (Array.isArray(products)) {
            products.forEach((product: RawProduct) => {
              items.push({
                id: product.code || String(Math.random()),
                name: product.name || "Unknown product",
                quantity: product.quantity || 0,
                price: parseCurrencyToNumber(
                  product.basePrice?.formattedValue ||
                    (typeof product.totalPrice === "object"
                      ? product.totalPrice?.formattedValue
                      : product.totalPrice) ||
                    "0",
                ),
                brand: product.manufacturer || "Unknown brand",
                category: categoryName,
                productCode: product.code,
              });
            });
          }
        });

        return {
          orderNumber: String(cachedOrder.code || orderNumber),
          deliveryDate: cachedOrder.deliveryFormattedDate || "",
          status: cachedOrder.statusDisplay || "Unknown",
          total: cachedOrder.totalPrice?.value || 0,
          items,
        };
      }

      // If already in MCP format, return as-is
      return cachedOrder;
    }

    console.error(`Cache miss for order ${orderNumber}, fetching from API`);

    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    const response = await fetchWithRetry(
      `https://www.willys.se/axfood/rest/orderdata?q=${orderNumber}`,
      { headers: getApiHeaders(cookies) },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch order details: ${response.status}`);
    }

    const data: RawOrderDetails = await response.json();

    // Cache the raw data first for compatibility with web interface
    orderCache.setCachedOrder(orderNumber, sessionId, data);
    console.error(`Cached raw order data for ${orderNumber}`);

    // Map the detailed order data from categoryOrderedDeliveredProducts
    const items: WillysOrderItem[] = [];
    if (data.categoryOrderedDeliveredProducts) {
      Object.entries(data.categoryOrderedDeliveredProducts).forEach(
        ([categoryName, products]) => {
          if (Array.isArray(products)) {
            products.forEach((product: RawProduct) => {
              items.push({
                id: product.code || String(Math.random()),
                name: product.name || "Unknown product",
                quantity: product.quantity || 0,
                price: parseCurrencyToNumber(
                  product.basePrice?.formattedValue ||
                    (typeof product.totalPrice === "object"
                      ? product.totalPrice?.formattedValue
                      : product.totalPrice) ||
                    "0",
                ),
                brand: product.manufacturer || "Unknown brand",
                category: categoryName,
                productCode: product.code,
              });
            });
          }
        },
      );
    }

    const orderDetails: WillysOrder = {
      orderNumber: String(data.code || orderNumber),
      deliveryDate: data.deliveryFormattedDate || "",
      status: data.statusDisplay || "Unknown",
      total: data.totalPrice?.value || 0,
      items,
    };

    return orderDetails;
  } catch (error) {
    console.error("Error fetching MCP order details:", error);
    return null;
  }
}

async function addToCartRaw(
  sessionId: string,
  productCode: string,
  quantity: number,
): Promise<{ success: boolean; message?: string }> {
  try {
    const response = await withAuthRefresh(sessionId, async (cookies) => {
      const csrfToken = await fetchCsrfToken(cookies);
      console.error("Retrieved CSRF token:", truncateForLog(csrfToken));
      return fetchWithRetry(
        "https://www.willys.se/axfood/rest/cart/addProducts",
        {
          method: "POST",
          headers: getApiHeaders(cookies, csrfToken),
          body: JSON.stringify({
            products: [
              {
                productCodePost: productCode,
                qty: quantity,
                pickUnit: "pieces",
                hideDiscountToolTip: false,
                noReplacementFlag: false,
              },
            ],
          }),
        },
      );
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to add to cart: ${response.status} - ${errorText}`,
      );
    }

    return { success: true };
  } catch (error) {
    console.error("Error adding to MCP cart:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

export async function mcpAddToCart(
  sessionId: string,
  productCode: string,
  quantity: number = 1,
  options: { allowFallback?: boolean } = {},
): Promise<{ success: boolean; message?: string }> {
  const allowFallback = options.allowFallback !== false;

  // First attempt with whatever code we were given.
  const first = await addToCartRaw(sessionId, productCode, quantity);
  if (first.success) {
    try {
      const { willysDatabase } = await import("./database");
      const name = willysDatabase.getProductNameByCode(productCode);
      willysDatabase.logCartAddition(productCode, name);
    } catch (e) {
      console.error("logCartAddition failed:", e);
    }
    return first;
  }
  if (!allowFallback) return first;

  // Fix 3: the code came back invalid. If we have a cached name for it,
  // mark it stale (so future smart-match queries skip it), re-search by
  // name, and retry against the top fresh result. This handles the case
  // where Willys rotates product codes / discontinues SKUs without our
  // cache noticing.
  const { willysDatabase } = await import("./database");
  const cachedName = willysDatabase.getProductNameByCode(productCode);
  if (!cachedName) {
    console.error(
      `add_to_cart failed for ${productCode}; no cached name → cannot fall back. Original error: ${first.message}`,
    );
    return first;
  }

  console.error(
    `add_to_cart failed for ${productCode} (cached as "${cachedName}"); marking stale and re-searching…`,
  );
  willysDatabase.markProductStale(productCode);

  const search = await mcpSearchProducts(sessionId, cachedName, 0, 5);
  if (!search.success || !search.products || search.products.length === 0) {
    return {
      success: false,
      message: `Original code ${productCode} is no longer valid and re-search for "${cachedName}" returned nothing.`,
    };
  }

  const top = search.products[0];
  if (top.code === productCode) {
    // Fresh search returned the same dead code — the original failure
    // probably wasn't about staleness (maybe out of stock, auth glitch, etc.).
    // Revert the stale marker so we don't silently hide a real product.
    console.error(
      `Re-search returned same code ${productCode}; clearing stale marker (failure was probably transient).`,
    );
    willysDatabase.cacheProductsFromSearch([
      { code: top.code, name: top.name, manufacturer: top.manufacturer },
    ]);
    return {
      success: false,
      message: `Add to cart failed for ${productCode} — re-search returned the same code, so the issue is likely transient (auth / stock). Original error: ${first.message}`,
    };
  }

  const retry = await addToCartRaw(sessionId, top.code, quantity);
  if (retry.success) {
    try {
      willysDatabase.logCartAddition(top.code, top.name);
    } catch (e) {
      console.error("logCartAddition (substituted) failed:", e);
    }
    return {
      success: true,
      message: `Original code ${productCode} was stale — substituted "${top.name}" [${top.code}] instead.`,
    };
  }
  return {
    success: false,
    message: `Original code ${productCode} stale; retried with "${top.name}" [${top.code}] but that also failed: ${retry.message}`,
  };
}

export async function mcpRemoveFromCart(
  sessionId: string,
  productCode: string,
): Promise<{ success: boolean; message?: string }> {
  try {
    const response = await withAuthRefresh(sessionId, async (cookies) => {
      const csrfToken = await fetchCsrfToken(cookies);
      console.error("Retrieved CSRF token:", truncateForLog(csrfToken));
      return fetchWithRetry(
        "https://www.willys.se/axfood/rest/cart/addProducts",
        {
          method: "POST",
          headers: getApiHeaders(cookies, csrfToken),
          body: JSON.stringify({
            products: [
              {
                productCodePost: productCode,
                qty: 0,
                pickUnit: "pieces",
                hideDiscountToolTip: false,
                noReplacementFlag: false,
              },
            ],
          }),
        },
      );
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to remove from cart: ${response.status} - ${errorText}`,
      );
    }

    return { success: true };
  } catch (error) {
    console.error("Error removing from MCP cart:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

export async function mcpGetCustomerInfo(
  sessionId: string,
): Promise<WillysCustomer | null> {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    const response = await fetchWithRetry(
      "https://www.willys.se/axfood/rest/customer",
      {
        headers: getApiHeaders(cookies),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch customer info: ${response.status}`);
    }

    const data: RawCustomerResponse = await response.json();

    return {
      uid: data.uid || "Unknown",
      name:
        `${data.firstName || ""} ${data.lastName || ""}`.trim() || "Unknown",
      firstName: data.firstName || "Unknown",
      lastName: data.lastName || "Unknown",
      email: data.email || data.displayUid || data.uid || "Unknown",
      displayUid: data.displayUid || "Unknown",
      socialSecurityNumber:
        data.socialSecurityNumber || data.socialSecurityNumer,
      defaultBillingAddress: data.defaultBillingAddress
        ? {
            id: data.defaultBillingAddress.id || "",
            firstName: data.defaultBillingAddress.firstName || "",
            lastName: data.defaultBillingAddress.lastName || "",
            line1: data.defaultBillingAddress.line1 || "",
            line2: data.defaultBillingAddress.line2,
            town: data.defaultBillingAddress.town || "",
            postalCode: data.defaultBillingAddress.postalCode || "",
            phone: data.defaultBillingAddress.phone,
            cellphone: data.defaultBillingAddress.cellphone,
            email: data.defaultBillingAddress.email || "",
            country: {
              isocode: data.defaultBillingAddress.country?.isocode || "",
              name: data.defaultBillingAddress.country?.name || "",
            },
            formattedAddress:
              data.defaultBillingAddress.formattedAddress || "Not available",
          }
        : undefined,
      defaultShippingAddress: data.defaultShippingAddress
        ? {
            id: data.defaultShippingAddress.id || "",
            firstName: data.defaultShippingAddress.firstName || "",
            lastName: data.defaultShippingAddress.lastName || "",
            line1: data.defaultShippingAddress.line1 || "",
            line2: data.defaultShippingAddress.line2,
            town: data.defaultShippingAddress.town || "",
            postalCode: data.defaultShippingAddress.postalCode || "",
            phone: data.defaultShippingAddress.phone,
            cellphone: data.defaultShippingAddress.cellphone,
            email: data.defaultShippingAddress.email || "",
            country: {
              isocode: data.defaultShippingAddress.country?.isocode || "",
              name: data.defaultShippingAddress.country?.name || "",
            },
            formattedAddress:
              data.defaultShippingAddress.formattedAddress || "Not available",
          }
        : undefined,
      savedCards:
        data.savedCards?.map((card: RawSavedCard) => ({
          id: card.id || "",
          maskedNumber: card.maskedNumber || "",
          cardType: card.cardType || "",
          expired: card.expired || false,
          defaultCard: card.defaultCard || false,
          expireDate: card.expireDate || "",
        })) || [],
      bonusInfo: {
        bonusAmountCurrentMonth: data.bonusInfo?.bonusAmountCurrentMonth || "0",
        currentTierName: data.bonusInfo?.currentTierName || "Unknown",
        totalDiscountCurrentMonth:
          data.bonusInfo?.totalDiscountCurrentMonth || "0,00 kr",
        totalDiscountCurrentYear:
          data.bonusInfo?.totalDiscountCurrentYear || "0,00 kr",
        currentBonusLevelEndDate:
          data.bonusInfo?.currentBonusLevelEndDate || "",
        daysLeftOnCurrentPeriod: data.bonusInfo?.daysLeftOnCurrentPeriod || 0,
        currentBonusVoucherPoints:
          data.bonusInfo?.currentBonusVoucherPoints || 0,
      },
      memberCreationMonthAndYear: data.memberCreationMonthAndYear || "Unknown",
      memberCreationDateFull: data.memberCreationDateFull || "Unknown",
      newCustomer: data.newCustomer || false,
    };
  } catch (error) {
    console.error("Error fetching MCP customer info:", error);
    return null;
  }
}

export async function mcpGetDeliverySlots(
  sessionId: string,
  postalCode: string,
): Promise<WillysDeliverySlotsResponse | null> {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    const response = await fetchWithRetry(
      `https://www.willys.se/axfood/rest/tms/delivery-slots?postalCode=${postalCode}`,
      { headers: getCommonHeaders(cookies) },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch delivery slots: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching MCP delivery slots:", error);
    return null;
  }
}

export async function mcpGetPickupSlots(
  sessionId: string,
  storeId: string = "2288",
): Promise<WillysPickupSlotsResponse | null> {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    const response = await fetchWithRetry(
      `https://www.willys.se/axfood/rest/pickup-slots/${storeId}`,
      { headers: getCommonHeaders(cookies) },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch pickup slots: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching MCP pickup slots:", error);
    return null;
  }
}

export async function mcpSelectSlot(
  sessionId: string,
  slotCode: string,
  isTmsSlot: boolean = false,
): Promise<{ success: boolean; message?: string }> {
  try {
    const url = isTmsSlot
      ? "https://www.willys.se/axfood/rest/tms/select-slot"
      : "https://www.willys.se/axfood/rest/select-pickup-slot";

    const body = isTmsSlot ? { slotCode, tmsData: {} } : { slotCode };

    const response = await withAuthRefresh(sessionId, async (cookies) => {
      const csrfToken = await fetchCsrfToken(cookies);
      return fetchWithRetry(url, {
        method: "POST",
        headers: getApiHeaders(cookies, csrfToken),
        body: JSON.stringify(body),
      });
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to select slot: ${response.status} - ${errorText}`,
      );
    }

    return { success: true };
  } catch (error) {
    console.error("Error selecting MCP slot:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

export async function mcpCheckout(
  sessionId: string,
): Promise<{ success: boolean; message?: string; emptyCart?: boolean }> {
  try {
    const response = await withAuthRefresh(sessionId, async (cookies) => {
      const tracking = generateTrackingHeaders();
      return fetchWithRetry(
        "https://www.willys.se/axfood/rest/checkout",
        {
          method: "GET",
          headers: {
            ...getApiHeaders(cookies),
            accept: "application/json, text/plain, */*",
            "x-newrelic-id": "VQcCVVdaDhAHUFFTDwQAVFc=",
            "x-request-id": tracking.traceparent.split("-")[1],
          },
        },
      );
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to checkout: ${response.status} - ${errorText}`);
    }

    const data: { emptyCart?: boolean } = await response.json();

    return {
      success: true,
      emptyCart: data.emptyCart || false,
      message: data.emptyCart ? "Cart is empty" : "Checkout successful",
    };
  } catch (error) {
    console.error("Error during MCP checkout:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

export async function mcpGetOffers(sessionId: string) {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    console.error(
      "Using MCP cookies for offers request:",
      truncateForLog(cookies, 100),
    );

    const response = await fetchWithRetry(
      "https://www.willys.se/_next/data/a4eecdbf/sv/erbjudanden.json",
      {
        headers: {
          ...getApiHeaders(cookies),
          purpose: "prefetch",
          "x-nextjs-data": "1",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch offers: ${response.status}`);
    }

    const data: unknown = await response.json();
    console.error(
      "Offers API response received, data keys:",
      Object.keys(data as Record<string, unknown>),
    );

    return {
      success: true,
      offers: data,
    };
  } catch (error) {
    console.error("Error fetching offers:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

interface SearchProduct {
  name: string;
  code: string;
  price: string;
  priceValue: number;
  manufacturer?: string;
  categoryName?: string;
  potentialPromotions: unknown[];
  stock: { stockLevelStatus: string; stockLevel: number };
  image: { url: string } | null;
  volume?: string;
  url?: string;
  averageRating?: number;
  numberOfReviews?: number;
  badges: string[];
}

export async function mcpSearchProducts(
  sessionId: string,
  query: string,
  page: number = 0,
  size: number = 30,
) {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.willys.se/search?q=${encodedQuery}&page=${page}&size=${size}`;

    const response = await fetchWithRetry(url, {
      headers: getApiHeaders(cookies),
    });

    if (!response.ok) {
      throw new Error(`Failed to search products: ${response.status}`);
    }

    const htmlData = await response.text();
    console.error(
      `Search results received for query "${query}": ${htmlData.length} characters of HTML`,
    );

    // Parse HTML to extract JSON data
    let products: SearchProduct[] = [];
    try {
      // The API returns JSON directly, try parsing it
      let searchData: { results?: RawProduct[] } | null = null;

      if (htmlData.startsWith("{")) {
        // Direct JSON response
        searchData = JSON.parse(htmlData);
      } else {
        // Look for the JSON data in the HTML script tag
        const scriptMatch = htmlData.match(
          /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
        );
        if (scriptMatch) {
          const nextData = JSON.parse(scriptMatch[1]);
          searchData = nextData?.props?.pageProps?.searchResults;
        }
      }

      if (searchData?.results) {
        // Transform to clean JSON structure
        products = searchData.results.map((product: RawProduct) => ({
          name: product.name || "",
          code: product.code || "",
          price: product.price || "",
          priceValue: product.priceValue || 0,
          manufacturer: product.manufacturer,
          categoryName: product.categoryName,
          potentialPromotions: product.potentialPromotions || [],
          stock: {
            stockLevelStatus: product.stock?.stockLevelStatus || "unknown",
            stockLevel: product.stock?.stockLevel || 0,
          },
          image: product.image
            ? {
                url: product.image.url || "",
              }
            : null,
          volume: product.volume || product.displayVolume,
          url: product.url,
          averageRating: product.averageRating,
          numberOfReviews: product.numberOfReviews,
          badges: product.badges || [],
        }));
      }
    } catch (parseError) {
      console.error("Failed to parse search results JSON:", parseError);
    }

    // Fix 3: cache the results so future smart-match / hybrid searches can
    // serve them without an API call, and so add_to_cart's stale-code retry
    // path has a name to re-search by. Best-effort; never blocks the response.
    if (products.length > 0) {
      try {
        const { willysDatabase } = await import("./database");
        const { inserted, revived } = willysDatabase.cacheProductsFromSearch(
          products.map((p) => ({
            code: p.code,
            name: p.name,
            manufacturer: p.manufacturer,
            category: p.categoryName,
          })),
        );
        if (inserted > 0 || revived > 0) {
          console.error(
            `Cached search results for "${query}": ${inserted} new, ${revived} revived from stale`,
          );
        }
      } catch (cacheError) {
        console.error("Failed to cache search results:", cacheError);
      }
    }

    return {
      success: true,
      query,
      page,
      size,
      products,
      totalResults: products.length,
      htmlContent: htmlData, // Keep for backward compatibility
      message: `Found ${products.length} products for "${query}" (page ${page + 1})`,
    };
  } catch (error) {
    console.error("Error searching products:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

export async function mcpGetSearchSuggestions(sessionId: string, term: string) {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    const encodedTerm = encodeURIComponent(term);
    const url = `https://www.willys.se/search/autocomplete/SearchBox?term=${encodedTerm}`;

    const response = await fetchWithRetry(url, {
      headers: getApiHeaders(cookies),
    });

    if (!response.ok) {
      throw new Error(`Failed to get search suggestions: ${response.status}`);
    }

    const data: unknown = await response.json();
    console.error(
      `Search suggestions received for term "${term}":`,
      JSON.stringify(data, null, 2),
    );

    return {
      success: true,
      term,
      suggestions: data,
    };
  } catch (error) {
    console.error("Error getting search suggestions:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

export async function mcpGetCommonProducts(sessionId: string) {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    console.error(
      "Using MCP cookies for common products request:",
      truncateForLog(cookies, 100),
    );

    const csrfToken = await fetchCsrfToken(cookies);

    const response = await fetchWithRetry(
      "https://www.willys.se/axfoodcommercewebservices/v2/willys/cms/pages?pageType=ContentPage&pageLabelOrId=minavanligastevaror&code=&fields=DEFAULT",
      {
        headers: getApiHeaders(cookies, csrfToken),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch common products: ${response.status}`);
    }

    const data: unknown = await response.json();
    console.error(
      "Common products API response received, data keys:",
      Object.keys(data as Record<string, unknown>),
    );

    return {
      success: true,
      commonProducts: data,
    };
  } catch (error) {
    console.error("Error fetching common products:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

// Pull a useful description blob out of the raw Next.js data dump returned
// by mcpGetProductDetail. The exact shape is unstable; walk a few common
// paths and concatenate whatever we find. Order matters: marketing copy
// first, then ingredients (often where the differentiating word lives).
export function extractProductDescription(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const out: string[] = [];
  const visit = (node: any, depth = 0): void => {
    if (!node || depth > 8) return;
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, val] of Object.entries(node)) {
      const k = key.toLowerCase();
      if (typeof val === "string" && val.trim().length > 3) {
        if (
          k.includes("description") ||
          k.includes("ingredient") ||
          k.includes("ingredienser") ||
          k.includes("productinformation") ||
          k.includes("produktinformation") ||
          k.includes("summary") ||
          k.includes("marketing") ||
          k === "longdescription" ||
          k === "shortdescription"
        ) {
          out.push(val.trim());
        }
      } else if (val && typeof val === "object") {
        visit(val, depth + 1);
      }
    }
  };
  visit(raw);
  // Dedupe; collapse whitespace.
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const s of out) {
    const norm = s.replace(/\s+/g, " ").trim();
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      cleaned.push(norm);
    }
  }
  return cleaned.join(" \n ");
}

export async function mcpGetProductDetail(
  sessionId: string,
  productCode: string,
  productName?: string,
) {
  try {
    const cookies = await mcpGetWillysCookies(sessionId);
    if (!cookies) {
      throw new Error("No authentication cookies found");
    }

    const csrfToken = await fetchCsrfToken(cookies);

    // Build the product detail URL
    // The buildId can be found from the page source or use a recent known one
    const buildId = "a4eecdbf"; // This might need to be updated occasionally
    const name = productName || `product-${productCode}`;
    const url = `https://www.willys.se/_next/data/${buildId}/sv/produktdetalj/${name}.json?name=${encodeURIComponent(name)}&productCode=${encodeURIComponent(productCode)}&showInModal=true`;

    console.error("Fetching product detail from:", url);

    const response = await fetchWithRetry(url, {
      headers: {
        ...getApiHeaders(cookies, csrfToken),
        purpose: "prefetch",
        "x-nextjs-data": "1",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch product detail: ${response.status}`);
    }

    const data: unknown = await response.json();
    console.error("Product detail API response received");

    return {
      success: true,
      productDetail: data,
    };
  } catch (error) {
    console.error("Error fetching product detail:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

interface ProductMatchResult {
  product: {
    name: string;
    code: string;
    brand: string;
    category: string;
    quantity: number;
    price: string;
  };
  score: number;
  frequency: number;
  lastPurchased: string;
  recentPurchases: number;
  similarity?: number;
  source?: string;
}

export async function mcpGetSmartProductMatches(
  sessionId: string,
  searchTerm: string,
  maxResults: number = 5,
) {
  try {
    console.error(`Finding smart product matches for: "${searchTerm}"`);

    // Use hybrid search (combines SQL text search with vector similarity)
    const { willysDatabase } = await import("./database");
    const hybridResults = await willysDatabase.hybridSearchProducts(
      searchTerm,
      maxResults,
    );

    console.error(
      `Found ${hybridResults.length} hybrid search matches (text + vector)`,
    );

    if (hybridResults.length === 0) {
      console.error("No matches found, falling back to regular search");
      const searchResult = await mcpSearchProducts(
        sessionId,
        searchTerm,
        0,
        maxResults,
      );
      if (searchResult.success) {
        return {
          success: true,
          matches: [] as ProductMatchResult[],
          message: `No purchase history found for "${searchTerm}". Try building purchase history by ordering products first.`,
        };
      } else {
        throw new Error("No purchase history and search also failed");
      }
    }

    // Transform hybrid results to the expected format
    const matches: ProductMatchResult[] = hybridResults.map((hybridMatch) => ({
      product: {
        name: hybridMatch.name,
        code: hybridMatch.productCode,
        brand: hybridMatch.manufacturer || "Unknown brand",
        category: "", // Could be enhanced with category lookup if needed
        quantity: 1,
        price: "Unknown", // Price info not stored in our denormalized schema yet
      },
      score: hybridMatch.score,
      frequency: hybridMatch.frequency,
      lastPurchased: hybridMatch.frequency > 0 ? "Recent" : "Never", // Simplify for now
      recentPurchases: hybridMatch.frequency,
      similarity: hybridMatch.similarity,
      source: hybridMatch.source,
    }));

    return {
      success: true,
      matches,
      searchTerm,
      totalHistoryMatches: hybridResults.length,
      message: `Found ${matches.length} smart hybrid matches for "${searchTerm}" (text + vector similarity)`,
    };
  } catch (error) {
    console.error("Error finding smart product matches:", error);
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}
