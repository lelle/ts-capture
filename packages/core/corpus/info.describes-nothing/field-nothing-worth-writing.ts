// rule: info.describes-nothing
// site: blank
// title: A field that held an empty object
// verdict: ok
// All the run saw was an empty object, which says nothing about what the field
// is for.

class Note {
  blank = JSON.parse("{}");
}

new Note();
