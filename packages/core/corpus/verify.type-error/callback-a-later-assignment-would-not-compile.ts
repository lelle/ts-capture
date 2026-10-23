// rule: verify.type-error
// site: job
// title: A later assignment would not compile
// verdict: ok
// The run saw a function returning `number`. The body later sets `job` to
// `null`, which that type would make an error.

function retry(job) {
  const result = job();
  job = null;
  return result;
}

retry(() => 1);
