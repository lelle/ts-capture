// rule: info.describes-nothing
// site: blank
// title: A variable that held an empty object
// verdict: ok
// All the run saw was an empty object, which says nothing about what `blank` is
// for.

const blank = JSON.parse("{}");
