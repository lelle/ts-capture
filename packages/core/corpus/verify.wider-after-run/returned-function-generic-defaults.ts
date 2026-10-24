// rule: verify.wider-after-run
// site: return type
// title: A returned function with a generic's defaults, already known
// verdict: ok
// The run only saw the branch that returns a number, so `Promise<number>` does
// not hold. The returned function's parameters are typed in the code, so
// TypeScript knew its type before the run. Read from outside the function it
// spells `Request<any>`, at the return `Request`, but it is one type, and it is
// left to TypeScript.

interface Request<Body = any> {
  body: Body;
}

function handlerFor(prefix: string) {
  return async (request: Request, reply: (text: string) => number) => {
    if (!request.body) return reply(prefix);
    reply(prefix + request.body);
  };
}

handlerFor("Hi ")({ body: "" }, (text) => text.length);
