import ts from "typescript";

export interface TypeCoverageResult {
  knownTypes: number;
  totalTypes: number;
  percentage: number;
}

export function typeCoverage(program: ts.Program): TypeCoverageResult {
  const checker = program.getTypeChecker();
  let knownTypes = 0;
  let totalTypes = 0;

  function visit(node: ts.Node) {
    if (
      ts.isIdentifier(node) &&
      node.parent &&
      !ts.isFunctionDeclaration(node.parent) &&
      !ts.isClassDeclaration(node.parent)
    ) {
      const type = checker.getTypeAtLocation(node);
      if (type) {
        totalTypes++;
        if (checker.typeToString(type) !== "any") {
          knownTypes++;
        }
      }
    }
    node.forEachChild(visit);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) {
      visit(sourceFile);
    }
  }

  return {
    knownTypes,
    totalTypes,
    percentage: totalTypes > 0 ? (100 * knownTypes) / totalTypes : 0,
  };
}
