// rule: written
// site: order
// title: A list whose items differ, inside an object
// verdict: ok
// The order's lines were not all alike: one had a note, one did not. They are
// written as one kind of line where the note may be missing, the same as for
// a list passed on its own.

function ship(order) {
  return order.lines.length;
}

ship({
  id: 7,
  lines: [
    { sku: "A1", qty: 2 },
    { sku: "B2", qty: 1, note: "gift" },
  ],
});
