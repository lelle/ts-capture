// rule: info.never-passed
// site: options
// verdict: ok
// Every call left the parameter out; `options: undefined` would forbid passing it.
function connect(options) {
  return { retries: 3, ...options };
}

connect();
