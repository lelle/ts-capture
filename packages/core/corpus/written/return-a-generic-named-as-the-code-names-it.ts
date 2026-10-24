// rule: written
// site: return type
// title: A generic named the way the code names it
// verdict: ok
// The returned function takes a `Request`, and every type parameter of
// `Request` has a default. The return type says `Request` as the code does,
// not `Request<unknown>`.

interface Request<Body = any> {
  body: Body;
}

function handlerFor(prefix: string) {
  return async (request: Request, reply: (text: string) => void) => {
    if (!request.body) return reply(prefix);
    reply(prefix + request.body);
  };
}

handlerFor("Hi ")({ body: "" }, () => {});
