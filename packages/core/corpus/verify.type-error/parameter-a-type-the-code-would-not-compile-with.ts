// rule: verify.type-error
// site: settings
// title: A type the code would not compile with
// real: left-alone
// verdict: ok
// The run saw `{ name: string }`, but the function adds a field. Written, that
// type would make the next line an error, so apply type-checks every annotation
// first and drops this one.

function enable(settings) {
  settings.enabled = true;
  return settings;
}

enable({ name: "dark mode" });
