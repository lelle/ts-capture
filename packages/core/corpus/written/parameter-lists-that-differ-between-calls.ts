// rule: written
// site: lines
// title: Lists that differ between calls
// verdict: ok
// Each call passed a list of lines, and only the second had a note. The
// parameter is written as a list of one kind of line where the note may be
// missing, which both calls fit.

function count(lines) {
  return lines.length;
}

count([{ sku: "A1", qty: 2 }]);
count([{ sku: "B2", qty: 1, note: "gift" }]);
