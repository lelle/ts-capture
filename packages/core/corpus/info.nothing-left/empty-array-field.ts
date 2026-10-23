// rule: info.nothing-left
// site: post
// title: Only a shape with an empty array was seen
// verdict: ok
// The one call passed `{ tags: [] }`, and an empty array says nothing about
// what goes in it. Written as `unknown[]`, the field would make every reader of
// it handle `unknown`, so the shape is dropped, and nothing is left to write.

function countTags(post) {
  return post.tags.length;
}

countTags({ tags: [] });
