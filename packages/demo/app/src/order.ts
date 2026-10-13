export function parseOrder(form) {
  const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
  return {
    customer: { name: data.name, email: data.email },
    lines: [{ sku: data.sku, qty: Number(data.qty) }],
    payment: data.payment,
    discountCode: data.discountCode || undefined,
  };
}

export function itemCount(order) {
  return order.lines.reduce((count, line) => count + line.qty, 0);
}

export async function submitOrder(order) {
  const body = JSON.stringify(order);
  const response = await fetch("/api/orders", { method: "POST", body });
  return await response.json();
}

export function receiptText(receipt) {
  return `${receipt.id} is ${receipt.status}: ${receipt.total} kr`;
}
