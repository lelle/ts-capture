// rule: verify.type-error
// site: job
// title: A callback parameter set to `null` later
// verdict: ok
// The run saw a function returning `number`. The body later sets `job` to
// `null`, which that type would make an error.

function retry(job) {
  const result = job();
  job = null;
  return result;
}

retry(() => 1);
