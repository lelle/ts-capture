// rule: syntax.outer-conflict
// site: double
// verdict: ok
// A binding to a function gets its type from the function's own parameters and
// return, which are typed where they stand.
const double = (n) => n * 2;
double(2);
