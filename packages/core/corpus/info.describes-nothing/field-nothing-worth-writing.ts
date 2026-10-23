// rule: info.describes-nothing
// site: blank
// title: Nothing worth writing
// verdict: ok
// All the run saw was an empty object, which says nothing about what the field
// is for.

class Note {
  blank = JSON.parse("{}");
}

new Note();
