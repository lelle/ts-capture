// Pure cross-reference engine for the collection subsystem. Given normalized,
// Function-free observation data, derives the final CollectedTypeInfo via the
// signature-reconstruction + cross-ref passes that used to live inside
// collection-context's getCollectedTypes(). Function identity is resolved to
// stable `${filename}:${retPos}` keys at the recording boundary, so this engine
// depends only on plain data and is testable from fixtures.
import type {
  ApproximationReason,
  CollectedTypeEntry,
  CollectedTypeInfo,
  ExtraOptions,
  SourceLocation,
} from "./collector-contract.js";

import {
  applyParamReturnUpgrade,
  buildFunctionSignature,
  isGenericFunctionType,
  upgradeObjectMemberFn,
} from "./type-signature.js";

interface LogKey {
  filename: string;
  pos: number;
  opts: ExtraOptions;
}

export interface CrossRefInput {
  /** The raw observation log: JSON `{filename,pos,opts}` key → set of JSON type tuples. */
  logs: Map<string, Set<string>>;
  /** Real parameter names by `filename:pos`. */
  paramNames: Map<string, string>;
  /** Per log key: the registered `${filename}:${retPos}` keys of recorded fn values, in order. */
  recordedFnKeys: Map<string, string[]>;
  /** Per log key: registered object-member fns as `{member, fnKey}`. */
  objectMemberFnKeys: Map<string, Array<{ member: string; fnKey: string }>>;
}

export function crossReferenceObservations(input: CrossRefInput): CollectedTypeInfo {
  const { logs, paramNames, recordedFnKeys, objectMemberFnKeys } = input;

  // Build function signature map: retPos+filename → signature
  const fnSignatures = new Map<string, string>();

  // First pass: collect all entries and group by fnRetPos
  const paramsByFn = new Map<string, Array<{ name: string; pos: number; types: string[] }>>();
  const returnsByFn = new Map<string, { types: string[]; async: boolean }>();
  // Observed return types from param invocations, keyed by the param's
  // observation pos and the member name. The second pass uses this to substitute
  // `=> unknown` in the param's emitted function type.
  const paramReturnsByPosMember = new Map<string, Map<string, string[]>>();

  for (const [key, typeSet] of logs) {
    const { filename, pos, opts } = JSON.parse(key) as LogKey;
    const types = [...typeSet].map(
      (v) =>
        JSON.parse(v) as [
          string | undefined,
          SourceLocation | undefined,
          ApproximationReason | undefined,
        ],
    );
    const typeNames = types.map(([t]) => t).filter((t): t is string => t != null);

    if (opts.paramReturn && opts.paramReturnMember) {
      const posKey = `${filename}:${pos}`;
      let memberMap = paramReturnsByPosMember.get(posKey);
      if (!memberMap) {
        memberMap = new Map();
        paramReturnsByPosMember.set(posKey, memberMap);
      }
      const existing = memberMap.get(opts.paramReturnMember);
      if (existing) existing.push(...typeNames);
      else memberMap.set(opts.paramReturnMember, [...typeNames]);
      continue;
    }

    if (opts.returnType) {
      const fnKey = `${filename}:${pos}`;
      const existing = returnsByFn.get(fnKey);
      if (existing) {
        existing.types.push(...typeNames);
      } else {
        returnsByFn.set(fnKey, { types: [...typeNames], async: opts.async ?? false });
      }
    } else if (opts.fnRetPos !== undefined) {
      const fnKey = `${filename}:${opts.fnRetPos}`;
      const existing = paramsByFn.get(fnKey);
      const paramEntry = { name: key, pos, types: typeNames };
      if (existing) {
        // Check if this param position already exists
        const existingParam = existing.find((p) => p.pos === pos);
        if (existingParam) {
          existingParam.types.push(...typeNames);
        } else {
          existing.push(paramEntry);
        }
      } else {
        paramsByFn.set(fnKey, [paramEntry]);
      }
    }
  }

  // Build signatures from grouped data
  for (const [fnKey, returnInfo] of returnsByFn) {
    const params = paramsByFn.get(fnKey) || [];
    // Sort params by position to maintain parameter order
    params.sort((a, b) => a.pos - b.pos);

    // Look up actual parameter names
    const paramInfos = params.map((p) => {
      const logKey = JSON.parse(p.name) as LogKey;
      const realName =
        paramNames.get(`${logKey.filename}:${logKey.pos}`) ?? `arg${params.indexOf(p)}`;
      return { name: realName, types: p.types };
    });

    const sig = buildFunctionSignature(paramInfos, returnInfo.types, returnInfo.async);
    fnSignatures.set(fnKey, sig);
  }

  // Second pass: build entries, replacing generic function types with specific ones
  return [...logs.entries()]
    .map(([key, typeSet]) => {
      const { filename, pos, opts } = JSON.parse(key) as LogKey;
      // paramReturn entries are internal — consumed below as upgrade input for
      // the value-observation at the same position, never emitted to apply as
      // annotations. Drop them from output.
      if (opts.paramReturn) return null;
      let types = [...typeSet].map(
        (v) =>
          JSON.parse(v) as [
            string | undefined,
            SourceLocation | undefined,
            ApproximationReason | undefined,
          ],
      );

      // Cross-reference: if this entry recorded function values, check if any
      // resolved to a registered signature.
      const fnKeys = recordedFnKeys.get(key);
      let crossRefUpgraded = false;
      if (fnKeys) {
        for (const fnKey of fnKeys) {
          const sig = fnSignatures.get(fnKey);
          if (sig) {
            types = types.map(([typeName, srcLoc, reason]) => {
              if (typeName && isGenericFunctionType(typeName)) {
                // Cross-ref upgrade: drop the implicit "generic-fn"
                // approximation since we now have a real signature.
                return [sig, srcLoc, reason];
              }
              return [typeName, srcLoc, reason];
            });
            crossRefUpgraded = true;
            break;
          }
        }
      }

      // Upgrade registered-fn refs found as object property values.
      const memberFnKeys = objectMemberFnKeys.get(key);
      if (memberFnKeys) {
        types = types.map(([typeName, srcLoc, reason]) => {
          if (!typeName) return [typeName, srcLoc, reason];
          let upgraded = typeName;
          for (const { member, fnKey } of memberFnKeys) {
            const sig = fnSignatures.get(fnKey);
            if (!sig) continue;
            upgraded = upgradeObjectMemberFn(upgraded, member, sig);
          }
          return upgraded !== typeName ? [upgraded, srcLoc, reason] : [typeName, srcLoc, reason];
        });
      }

      // paramReturn cross-ref. When the param's own observation position has
      // accumulated invocation-site return types, substitute `=> unknown`
      // slots in the emitted type. Runs after the registered-fn upgrades so a
      // specific return type from the parent is never overridden —
      // applyParamReturnUpgrade only touches `unknown` returns.
      const paramReturnMembers = paramReturnsByPosMember.get(`${filename}:${pos}`);
      if (paramReturnMembers) {
        types = types.map(([typeName, srcLoc, reason]) => {
          if (!typeName) return [typeName, srcLoc, reason];
          let upgraded = typeName;
          for (const [member, returnTypes] of paramReturnMembers) {
            upgraded = applyParamReturnUpgrade(upgraded, member, returnTypes);
          }
          return upgraded !== typeName ? [upgraded, srcLoc, reason] : [typeName, srcLoc, reason];
        });
      }

      // Tag remaining generic-function emits with the "generic-fn"
      // approximation reason. This fires for function values whose cross-ref
      // upgrade didn't happen (no registered signature, e.g. functions from
      // external modules, or arrows observed before they ran).
      if (!crossRefUpgraded) {
        types = types.map(([typeName, srcLoc, reason]) => {
          if (typeName && reason === undefined && isGenericFunctionType(typeName)) {
            return [typeName, srcLoc, "generic-fn"];
          }
          return [typeName, srcLoc, reason];
        });
      }

      return [filename, pos, types, opts] as CollectedTypeEntry;
    })
    .filter((entry): entry is CollectedTypeEntry => entry !== null);
}
