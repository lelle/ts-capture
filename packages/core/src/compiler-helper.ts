import ts from "typescript";

export interface CompilerOptions {
  rootDir?: string;
  tsConfig?: string;
}

export function getProgram(options: CompilerOptions): ts.Program | undefined {
  if (!options.tsConfig) return undefined;

  const { config, error } = ts.readConfigFile(options.tsConfig, ts.sys.readFile);
  if (error) {
    const msg =
      typeof error.messageText === "string" ? error.messageText : error.messageText.messageText;
    throw new Error(`Error reading ${options.tsConfig}: ${msg}`);
  }

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, options.rootDir ?? "");
  if (parsed.errors.length) {
    const msgs = parsed.errors
      .map((e) => (typeof e.messageText === "string" ? e.messageText : e.messageText.messageText))
      .join(", ");
    throw new Error(`Error parsing ${options.tsConfig}: ${msgs}`);
  }

  return ts.createProgram(parsed.fileNames, parsed.options);
}
