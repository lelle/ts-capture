// rule: written
// site: order
// title: Lists that differ, where one call had none
// verdict: ok
// One order had plain lines, one had none, and one had a line with a note.
// The lines are written as one kind of line where the note may be missing,
// and the missing list stays a null beside them.

function ship(order) {
  return order.lines?.length ?? 0;
}

ship({ lines: [{ sku: "A1", qty: 2 }] });
ship({ lines: null });
ship({ lines: [{ sku: "B2", qty: 1, note: "gift" }] });
