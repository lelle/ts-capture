export interface Starter {
  id: string;
  title: string;
  code: string;
  /** Ticks "Name repeated shapes" (`infer.aliasRepeatedShapes`) when chosen. */
  nameShapes?: boolean;
}

export const STARTERS: Starter[] = [
  {
    id: "api",
    title: "An API response",
    nameShapes: true,
    code: `// Stands in for fetch(): the body is text until it is parsed, so TypeScript
// only sees \`any\`. The run sees what the API actually sent.
async function getJson(url) {
  const body = '{"id":7,"customer":{"name":"Ada","address":{"city":"Oslo","zip":"0150"}},' +
    '"lines":[{"sku":"chair","quantity":2,"price":{"amount":120,"currency":"NOK"}}]}';
  return JSON.parse(body);
}

async function loadOrder(id) {
  return getJson("/api/orders/" + id);
}

function shipTo(customer) {
  return customer.address.city;
}

function lineTotal(line) {
  return line.quantity * line.price.amount;
}

async function checkout(id) {
  const order = await loadOrder(id);
  shipTo(order.customer);
  return order.lines.map(lineTotal);
}

checkout(7);
`,
  },
  {
    id: "cart",
    title: "Shopping cart",
    code: `function addLine(cart, product, quantity) {
  cart.lines.push({ sku: product.sku, quantity, unitPrice: product.price });
  return cart;
}

function total(cart) {
  return cart.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
}

const chair = { sku: "chair", price: 120 };
const cart = addLine({ lines: [] }, chair, 2);
total(cart);
`,
  },
  {
    id: "nullable",
    title: "A field that is sometimes null",
    code: `function lastSeen(user) {
  return user.lastLogin ?? "never";
}

// Called with both, so both end up in the type.
// Delete one call and run again to see the difference.
lastSeen({ id: 1, name: "Ada", lastLogin: null });
lastSeen({ id: 2, name: "Bo", lastLogin: "2026-01-01" });
`,
  },
  {
    id: "async",
    title: "Async function",
    code: `async function loadOrder(id) {
  return { id, lines: [{ sku: "chair", quantity: 2 }], paid: false };
}

async function summarize(id) {
  const order = await loadOrder(id);
  return order.lines.length + " line(s), paid: " + order.paid;
}

summarize(7);
`,
  },
  {
    id: "left-alone",
    title: "A type it will not write",
    code: `// items was seen as { sku, price }[]. With that written, item[key] no
// longer compiles, so the type-check keeps it out. See the report below.
const pick = (items, key) => items.map((item) => item[key]);

pick([{ sku: "chair", price: 120 }], "sku");
`,
  },
];
