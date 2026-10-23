// rule: info.unparseable
// site: item
// title: A name no type can have
// verdict: ok
// The class was renamed at runtime to `9lives`, which no identifier can be. The
// type would not parse, so nothing is written.

function label(item) {
  return String(item);
}

const Renamed = Object.defineProperty(class {}, "name", { value: "9lives" });
label(new Renamed());
