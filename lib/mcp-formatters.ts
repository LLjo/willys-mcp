/**
 * Voice-friendly formatters for MCP tool responses.
 *
 * Goal: keep output short, readable, and free of internal codes/IDs the user
 * doesn't care about. Codes (productCode etc.) are still emitted when the LLM
 * needs them for follow-up tool calls, but kept in a clearly-marked section
 * the model is unlikely to read aloud verbatim.
 */

type AnyObj = Record<string, unknown>;

function pickName(p: AnyObj): string {
  return (
    (p.name as string | undefined) ??
    (p.productLine2 as string | undefined) ??
    "Unknown product"
  );
}

function pickPrice(p: AnyObj): string {
  const price =
    (p.price as string | undefined) ??
    (p.formattedValue as string | undefined) ??
    (typeof p.priceValue === "number" ? `${p.priceValue} kr` : undefined);
  return price ?? "";
}

function pickCode(p: AnyObj): string | undefined {
  return (
    (p.code as string | undefined) ??
    (p.productCode as string | undefined) ??
    (p.id as string | undefined)
  );
}

function withCodeIndex(
  lines: string[],
  items: AnyObj[],
  nameFn: (p: AnyObj) => string,
): string {
  const codes = items
    .map((p, i) => {
      const c = pickCode(p);
      return c ? `${i + 1}=${c}` : null;
    })
    .filter((s): s is string => Boolean(s));
  if (codes.length === 0) return lines.join("\n");
  return `${lines.join("\n")}\n[codes: ${codes.join(", ")}]`;
}

// One-line reminder appended to disambiguation responses. The system prompt
// already tells the agent not to speak [bracketed] content, but the
// "list-to-user then silently pass code in follow-up tool call" flow is the
// place it's most likely to slip — so we restate it inline, scoped to where
// it matters.
const CODE_HANDLING_HINT =
  "(Read names aloud to the user; never speak or write the [bracketed] codes. Pass the chosen code as productCode in the follow-up tool call.)";

export function formatSearchResults(
  query: string,
  products: AnyObj[] | undefined,
): string {
  if (!products || products.length === 0) {
    return `No results for "${query}".`;
  }
  const top = products.slice(0, 10);
  const lines = top.map((p, i) => {
    const name = pickName(p);
    const price = pickPrice(p);
    const volume = (p.displayVolume as string | undefined) ?? "";
    const extras = [volume, price].filter(Boolean).join(", ");
    return `${i + 1}. ${name}${extras ? ` — ${extras}` : ""}`;
  });
  const more =
    products.length > top.length
      ? `\n…and ${products.length - top.length} more.`
      : "";
  return `${withCodeIndex(
    [`Top ${top.length} results for "${query}":`, ...lines, more].filter(
      Boolean,
    ),
    top,
    pickName,
  )}\n${CODE_HANDLING_HINT}`;
}

export function formatSearchSuggestions(
  query: string,
  suggestions: unknown,
): string {
  const arr = Array.isArray(suggestions) ? (suggestions as unknown[]) : [];
  if (arr.length === 0) return `No suggestions for "${query}".`;
  const items = arr
    .slice(0, 8)
    .map((s) =>
      typeof s === "string"
        ? s
        : ((s as AnyObj)?.term as string | undefined) ?? String(s),
    );
  return `Suggestions: ${items.join(", ")}.`;
}

export function formatCart(cart: AnyObj | null | undefined): string {
  if (!cart) return "Cart is empty or unavailable.";
  const products = (cart.products as AnyObj[] | undefined) ?? [];
  const total = (cart.totalPrice as string | undefined) ?? "?";
  const totalItems = (cart.totalItems as number | undefined) ?? products.length;
  if (products.length === 0) {
    return `Cart is empty (total: ${total}).`;
  }
  const lines = products.map((p) => {
    const qty = (p.quantity as number | undefined) ?? 1;
    const name = pickName(p);
    const price = pickPrice(p);
    return `• ${qty}× ${name}${price ? ` (${price})` : ""}`;
  });
  return withCodeIndex(
    [`Cart: ${totalItems} items, total ${total}.`, ...lines],
    products,
    pickName,
  );
}

export function formatOrders(orders: AnyObj[] | undefined): string {
  if (!orders || orders.length === 0) return "No orders found.";
  const top = orders.slice(0, 10);
  const lines = top.map((o) => {
    const date =
      (o.deliveryDate as string | undefined) ??
      (o.deliveryFormattedDate as string | undefined) ??
      "unknown date";
    const num =
      (o.orderNumber as string | undefined) ??
      (o.code as string | undefined) ??
      "";
    const total =
      typeof o.total === "string" || typeof o.total === "number"
        ? String(o.total)
        : "?";
    const status = (o.status as string | undefined) ?? "";
    return `• ${date} — ${total} kr${status ? `, ${status}` : ""}${num ? ` [#${num}]` : ""}`;
  });
  const more =
    orders.length > top.length
      ? `\n…and ${orders.length - top.length} more.`
      : "";
  return [`${orders.length} order(s):`, ...lines, more].filter(Boolean).join("\n");
}

export function formatOrderDetails(order: AnyObj | null | undefined): string {
  if (!order) return "Order not found.";
  const date =
    (order.deliveryDate as string | undefined) ??
    (order.deliveryFormattedDate as string | undefined) ??
    "unknown date";
  const total =
    typeof order.total === "string" || typeof order.total === "number"
      ? String(order.total)
      : "?";
  const items = (order.items as AnyObj[] | undefined) ?? [];
  const head = `Order from ${date} — ${total} kr — ${items.length} items.`;
  if (items.length === 0) return head;
  const lines = items.slice(0, 30).map((it) => {
    const qty = (it.quantity as number | undefined) ?? 1;
    return `• ${qty}× ${pickName(it)}`;
  });
  return [head, ...lines].join("\n");
}

export function formatCustomerInfo(c: AnyObj | null | undefined): string {
  if (!c) return "Customer info unavailable.";
  const name =
    (c.name as string | undefined) ??
    [c.firstName, c.lastName].filter(Boolean).join(" ") ??
    "customer";
  const bonus = (c.bonusInfo as AnyObj | undefined) ?? {};
  const tier = (bonus.currentTierName as string | undefined) ?? "";
  const monthBonus =
    (bonus.bonusAmountCurrentMonth as string | undefined) ?? "";
  return `${name}${tier ? ` (${tier} tier)` : ""}${monthBonus ? `, bonus this month: ${monthBonus}` : ""}.`;
}

export function formatDeliverySlots(resp: AnyObj | null | undefined): string {
  if (!resp) return "No delivery slot info.";
  const days = (resp.deliveryDays as AnyObj[] | undefined) ?? [];
  if (days.length === 0) return "No delivery slots available.";
  const lines: string[] = [];
  for (const day of days.slice(0, 4)) {
    const slots = ((day.slots as AnyObj[] | undefined) ?? [])
      .filter((s) => s.available)
      .slice(0, 3);
    if (slots.length === 0) continue;
    const label =
      (day.formattedDate as string | undefined) ??
      (day.date as string | undefined) ??
      "";
    lines.push(`${label}:`);
    for (const s of slots) {
      const time = (s.formattedTime as string | undefined) ?? "?";
      const cost = (s.totalCost as string | undefined) ?? "";
      lines.push(`  • ${time}${cost ? ` (${cost})` : ""}`);
    }
  }
  if (lines.length === 0) return "All delivery slots fully booked.";
  return ["Available delivery slots:", ...lines].join("\n");
}

export function formatPickupSlots(resp: AnyObj | null | undefined): string {
  if (!resp) return "No pickup slot info.";
  const slots = ((resp.slots as AnyObj[] | undefined) ?? [])
    .filter((s) => s.available)
    .slice(0, 8);
  if (slots.length === 0) return "No pickup slots available.";
  const lines = slots.map((s) => {
    const day = (s.dayOfTheWeek as string | undefined) ?? "";
    const time = (s.formattedTime as string | undefined) ?? "?";
    const cost = (s.totalCost as AnyObj | undefined)?.formattedValue ?? "";
    return `• ${day} ${time}${cost ? ` (${cost})` : ""}`;
  });
  return ["Available pickup slots:", ...lines].join("\n");
}

export function formatOffers(offers: unknown): string {
  const arr = Array.isArray(offers) ? (offers as AnyObj[]) : [];
  if (arr.length === 0) return "No current offers.";
  const top = arr.slice(0, 10);
  const lines = top.map((o, i) => {
    const name = pickName(o);
    const price = pickPrice(o);
    return `${i + 1}. ${name}${price ? ` — ${price}` : ""}`;
  });
  const more = arr.length > top.length ? `\n…and ${arr.length - top.length} more.` : "";
  return withCodeIndex([`${arr.length} offers, top ${top.length}:`, ...lines, more].filter(Boolean), top, pickName);
}

export function formatCommonProducts(products: unknown): string {
  const arr = Array.isArray(products) ? (products as AnyObj[]) : [];
  if (arr.length === 0) return "No frequent products found.";
  const top = arr.slice(0, 15);
  const lines = top.map((p, i) => `${i + 1}. ${pickName(p)}`);
  return withCodeIndex(["Your frequent products:", ...lines], top, pickName);
}

export function formatProductDetail(p: AnyObj | null | undefined): string {
  if (!p) return "Product not found.";
  const name = pickName(p);
  const price = pickPrice(p);
  const volume = (p.displayVolume as string | undefined) ?? "";
  const manufacturer = (p.manufacturer as string | undefined) ?? "";
  const parts = [name, manufacturer, volume, price].filter(Boolean);
  const head = parts.join(" — ");
  const code = pickCode(p);
  return code ? `${head}\n[code: ${code}]` : head;
}

export function formatPreferredList(
  items: Array<{
    productCode: string;
    name: string;
    manufacturer?: string | null;
  }>,
): string {
  if (!items || items.length === 0) {
    return "Preferred list is empty. Add items with mcp__willys_preferred_add_last_cart_item or mcp__willys_preferred_replace_with_cart.";
  }
  const lines = items.map((p, i) => {
    const mfg = p.manufacturer ? ` (${p.manufacturer})` : "";
    return `${i + 1}. ${p.name}${mfg}`;
  });
  const codes = items.map((p) => p.productCode).join(", ");
  return `Preferred list (${items.length} items):\n${lines.join("\n")}\n[codes: ${codes}]`;
}

export function formatAliases(
  rows: Array<{ alias: string; productCode: string; name: string | null }>,
): string {
  if (!rows || rows.length === 0) return "No aliases registered.";
  const lines = rows.map(
    (r) => `• ${r.alias} → ${r.name ?? "(unknown product)"}`,
  );
  const codes = rows.map((r) => r.productCode).join(", ");
  return `Aliases (${rows.length}):\n${lines.join("\n")}\n[codes: ${codes}]`;
}
