// rule: info.too-long
// site: record
// title: Too long to be worth writing
// verdict: ok
// The calls passed 400 different shapes. Their union is longer than
// `maxAnnotationChars` (4096 characters by default), and an annotation that
// long is harder to read than no annotation.

function store(record) {
  return Object.keys(record).length;
}

for (let i = 0; i < 400; i++) store({ [`field${i}`]: i });
