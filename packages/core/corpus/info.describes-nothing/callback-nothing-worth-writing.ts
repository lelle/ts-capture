// rule: info.describes-nothing
// site: job
// title: A callback that returned an empty object
// verdict: ok
// The function came back with an empty object, so all the run knows is `() =>
// {}`, which says nothing about what the callback is for.

function schedule(job) {
  return job();
}

schedule(() => JSON.parse("{}"));
