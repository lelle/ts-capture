---
"@ts-capture/skills": patch
---

Both skills now have a path for an agent that was asked to do the work, not to advise on it. They assumed a user who confirms each edit, runs each command and applies each fix; an agent told to adopt ts-capture broke those instructions every time and then had no guidance at all. The setup skill says which confirmations are already given. The apply-review skill says what may be edited, to run the typecheck and the tests after editing, and to report what was changed, what was flagged and left, and what still fails.
