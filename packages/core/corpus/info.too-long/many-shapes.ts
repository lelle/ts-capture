// rule: info.too-long
// site: record
// verdict: ok
// The calls passed 400 different shapes; their union is longer than
// `maxAnnotationChars` (4096), so nothing is written.
function store(record) {
  return Object.keys(record).length;
}

for (let i = 0; i < 400; i++) store({ [`field${i}`]: i });
