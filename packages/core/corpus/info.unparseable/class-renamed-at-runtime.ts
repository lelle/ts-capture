// rule: info.unparseable
// site: item
// verdict: ok
// The class was renamed at runtime to something no identifier can be.
function label(item) {
  return String(item);
}

const Renamed = Object.defineProperty(class {}, "name", { value: "9lives" });
label(new Renamed());
