// rule: written
// site: return type
// title: A generic named the way the code names it
// verdict: ok
// The returned function takes a `Request`, and every type parameter of
// `Request` has a default. TypeScript knows nothing of `greeting`, so the
// return type is written, and it says `Request` as the code does, not
// `Request<unknown>`.

interface Request<Body = any> {
  body: Body;
}

function handlerFor(prefix: string) {
  return (request: Request, greeting) => prefix + greeting + request.body;
}

handlerFor("Hi ")({ body: "Ada" }, "hello ");
