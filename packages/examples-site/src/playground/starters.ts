export interface Starter {
  id: string;
  title: string;
  code: string;
}

export const STARTERS: Starter[] = [
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
