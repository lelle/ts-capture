import type { LiteralOptions } from "./collector-contract.js";

import { createCollectionContextWith } from "./collection-context.js";
import { computeAnnotationTypeString } from "./compute-annotation.js";
import { type DeepPartial, type InferOptions, resolveInferOptions } from "./configuration.js";
import { createTrackedPromiseState } from "./promise-state.js";
import { identifierCase, planShapeAliases } from "./shape-aliases.js";
import { typeStringForSource } from "./type-canonical.js";

export interface TypesFromValuesOptions {
  /** The name apply would see the values under, as a parameter's; names a declared shape. */
  name?: string;
  /** How deep a value is read before the rest is unknown. Default 5, as when observed. */
  maxDepth?: number;
  /** What is observed of each value, as given to the Vite plugin; literals follow `infer.literal` unless set here. */
  literalOptions?: LiteralOptions;
  /** How observations become a type, as `infer` in ts-capture.config.json. */
  infer?: DeepPartial<InferOptions>;
}

export interface TypesFromValuesResult {
  /** `name` as a type name, which no declared shape takes; undefined without a name that is an identifier. */
  rootName: string | undefined;
  /** Undefined when apply would write nothing for these values. */
  type: string | undefined;
  /** `type X = …;` for each shape named, when `infer.aliasRepeatedShapes` is on. */
  declarations: string[];
}

const SITE = "values";

/** The type apply would write for a parameter called once with each value. */
export function typesFromValues(
  values: readonly unknown[],
  options: TypesFromValuesOptions = {},
): TypesFromValuesResult {
  const infer = resolveInferOptions({ infer: options.infer });
  const rootName = options.name === undefined ? undefined : identifierCase(options.name);
  const context = createCollectionContextWith(createTrackedPromiseState(), {
    maxDepth: options.maxDepth,
    literalOptions: {
      literalString: infer.literal.string,
      literalStringMaxLength: infer.literal.stringMaxLength,
      literalNumber: infer.literal.number,
      literalBoolean: infer.literal.boolean,
      ...options.literalOptions,
    },
  });
  for (const value of values) context.record(options.name ?? SITE, value, 0, SITE, {});

  const observed = context.getCollectedTypes()[0]?.[2] ?? [];
  const computed = computeAnnotationTypeString(observed, {}, infer, false);
  if (computed === null) return { rootName, type: undefined, declarations: [] };

  if (!infer.aliasRepeatedShapes) {
    return { rootName, type: spelled(computed), declarations: [] };
  }
  const plan = planShapeAliases(
    [{ emitted: computed, name: options.name }],
    (name) => name === rootName,
  );
  return {
    rootName,
    type: spelled(plan.emitted[0] ?? computed),
    declarations: plan.declarations.map(({ name, body }) => `type ${name} = ${body};`),
  };
}

const spelled = (type: string): string => typeStringForSource(type) ?? type;
