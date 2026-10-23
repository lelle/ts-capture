// rule: syntax.outer-conflict
// site: double
// title: A function's type is written on the function
// verdict: ok
// The variable holds a function. Its parameters and return are typed where they
// stand, inside the function, and the variable gets its type from them.

const double = (n) => n * 2;
double(2);
