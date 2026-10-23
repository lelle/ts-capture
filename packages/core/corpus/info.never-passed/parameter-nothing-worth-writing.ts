// rule: info.never-passed
// site: options
// title: An options parameter left out of every call
// verdict: ok
// No call passed this parameter, so all the run saw was `undefined`. That says
// nothing about what the parameter is for, and written as `options: undefined`
// it would make every call that does pass options an error.

function connect(options) {
  return { retries: 3, ...options };
}

connect();
