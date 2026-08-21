export type UnitKind = "comment" | "statement";

export interface Unit {
  kind: UnitKind;
  text: string;
  startLine: number; // 0-based, inclusive
  endLine: number;   // 0-based, inclusive
}

export interface ParseResult {
  units: Unit[];
  explicitTarget?: string;
  lineCount: number;
}

export interface Survey {
  language?: string; // English name of the source's human language
  target: "bash" | "python";
  preambleEnd: number; // 1-based last preamble line, 0 = none
  uses: string[];
  definitions: { line: number; name: string }[]; // line is 1-based
  examples: { line: number; name: string }[];    // expectation statements, 1-based
}

export interface LintWarning { line: number; endLine: number; message: string }

export interface ModuleInfo {
  path: string;        // resolved .ei file
  name: string;        // python/bash identifier
  artifact: string;    // generated .py/.sh path
  target: "bash" | "python";
  brief: string;
}

export interface EngineConfig {
  engine: "http" | "pi";
  httpUrl: string;
  httpApiKey: string;
  httpModel: string;
  piModel: string;
  piModeFile: string;
}

export type Effect =
  | "reads_files" | "writes_files" | "deletes_data"
  | "uses_network" | "starts_process"
  | "reads_database" | "writes_database"
  | "uses_time" | "uses_randomness" | "unknown_dynamic";

export interface FunctionInterface {
  name: string;
  parameters: string[];
  requiredParameters: number;
  async: boolean;
}

export interface SemanticFacts {
  defines: string[];
  reads: string[];
  calls: string[];
  imports: string[];
  functions: FunctionInterface[];
  classes: string[];
  effects: Effect[];
  dynamic: boolean;
  parseError?: string;
}

export interface DependencyEdge {
  nodeId: string;
  symbols: string[];
  kind: "symbol" | "dynamic" | "effect";
}

export interface GraphNode {
  id: string;
  ordinal: number;
  stmtKey: string;
  stmt: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
  implementationHash: string;
  interfaceHash: string;
  facts: SemanticFacts;
  dependencies: DependencyEdge[];
  dependencyInterfaceHash: string;
}

export interface DependencyGraph {
  version: 1;
  target: "bash" | "python";
  engineId: string;
  briefsHash: string;
  sourceHash: string;
  builtAt: number;
  nodes: GraphNode[]; // source order (not hoisted output order)
}

export interface PinData {
  code: string;
  stmt: string;
  at: number;
  automatic?: boolean;
  acceptedDependencies?: Record<string, string>; // provider node id -> interface hash
}

export interface TranslationData {
  code: string;
  stmt: string;
  at: number;
}

export interface BlockResult {
  unit: Unit;
  nodeId: string;
  isExample?: boolean;
  code: string;
  pinned: boolean;
  automaticPin: boolean;
  fromCache: boolean;
  error?: string;
  genStart: number;
  genEnd: number;
  facts?: SemanticFacts;
  dependencies?: DependencyEdge[];
  sourceHash?: string;
  implementationHash?: string;
  interfaceHash?: string;
  dependencyWarning?: string;
}

export interface Diag {
  line: number;
  endLine: number;
  message: string;
  severity: "error" | "warning";
  code?: string;
}

export interface CompileResult {
  survey: Survey;
  target: "bash" | "python";
  briefs: string;
  script: string;
  testScript: string;      // script + example assertions harness ("" = no examples)
  blocks: BlockResult[];
  exampleBlocks: BlockResult[]; // genStart/genEnd map into testScript
  modules: ModuleInfo[];
  diagnostics: Diag[];
  hoistedLines: number[];
  graph: DependencyGraph;
  locked: boolean;
}

export interface CacheData {
  version: 2;
  translations: Record<string, TranslationData>;
  pins: Record<string, PinData>;
  survey?: { key: string; value: Survey };
  lint?: { key: string; value: LintWarning[] };
  graph?: DependencyGraph;
}

export interface StalenessInfo {
  staleLines: number[]; // changed statement itself
  dependentLines: number[]; // transitively affected by a changed statement
  pinnedLines: number[];
  dependencyWarningLines: number[];
  ghost: Map<number, string>;
  reasons: Map<number, string>;
}
