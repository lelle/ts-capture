// rule: verify.type-error
// site: current
// title: A later assignment would not compile
// verdict: ok
// The run saw `current` hold `{ n: number }`. Written, that type would make the
// assignment of `null` further down an error, so apply drops it.

let current = JSON.parse('{"n": 1}');
current = null;
