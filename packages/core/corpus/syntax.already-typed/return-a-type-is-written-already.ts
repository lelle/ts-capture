// rule: syntax.already-typed
// site: return type
// title: A return typed by the first apply
// apply: twice
// verdict: ok
// The same observations applied a second time meet the type the first apply
// wrote. Apply never replaces a type that is there, its own or anyone else's.

function load() {
  return JSON.parse('{"a": 1}');
}

load();
