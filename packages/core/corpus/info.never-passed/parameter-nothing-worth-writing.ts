// rule: info.never-passed
// site: options
// title: Nothing worth writing
// verdict: ok
// No call passed this parameter, so all the run saw was `undefined`. That says
// nothing about what the parameter is for, and written as `options: undefined`
// it would make every call that does pass options an error.

function connect(options) {
  return { retries: 3, ...options };
}

connect();
