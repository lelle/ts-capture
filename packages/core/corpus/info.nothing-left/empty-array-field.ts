// rule: info.nothing-left
// site: post
// verdict: ok
// The only shape seen had an empty array, `unknown[]`, as a field. That
// shape is dropped, and nothing is left to write.
function countTags(post) {
  return post.tags.length;
}

countTags({ tags: [] });
