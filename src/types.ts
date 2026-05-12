export type PageType =
  | "dashboard"
  | "list"
  | "detail"
  | "form"
  | "settings"
  | "modal"
  | "wizard"
  | "report"
  | "auth"
  | "error"
  | "empty"
  | "unknown";

export type RouteStatus =
  | "discovered"
  | "queued"
  | "visited"
  | "validated"
  | "failed"
  | "blocked"
  | "skipped";

export type ActionKind =
  | "navigate"
  | "click"
  | "fill"
  | "submit"
  | "search"
  | "filter"
  | "sort"
  | "open_detail"
  | "create"
  | "edit"
  | "delete"
  | "export"
  | "import"
  | "cancel"
  | "logout"
  | "noop";

export type ActionRisk = "safe" | "mutation" | "destructive" | "tenant_wide" | "external";

export type SafetyDecision = "allow" | "approval_required" | "deny";

export type FindingSeverity = "P0" | "P1" | "P2" | "P3";

export type FindingCategory =
  | "functional_bug"
  | "workflow_mismatch"
  | "wiki_product_mismatch"
  | "copy_text_issue"
  | "layout_display_issue"
  | "accessibility_issue"
  | "validation_issue"
  | "broken_navigation"
  | "auth_permission_issue"
  | "console_runtime_error"
  | "network_api_failure"
  | "data_persistence_issue"
  | "flaky_timeout_issue";

export interface ArticleRecord {
  id: string;
  url: string;
  title: string;
  product?: string;
  category?: string;
  headings: string[];
  bodyText: string;
  markdown: string;
  workflowSteps: string[];
  terminology: string[];
  contentHash: string;
  crawledAt: string;
  updatedAt?: string;
  filePath?: string;
}

export interface WikiManifest {
  rootUrl: string;
  crawledAt: string;
  articleCount: number;
  jsonlPath: string;
  markdownDir: string;
  articles: Array<Pick<ArticleRecord, "id" | "url" | "title" | "product" | "category" | "contentHash" | "filePath">>;
}

export interface RetrievedChunk {
  articleId: string;
  title: string;
  url: string;
  text: string;
  score: number;
  product?: string;
  category?: string;
}

export interface ControlDescriptor {
  tag: string;
  role?: string;
  type?: string;
  label: string;
  name?: string;
  href?: string;
  selectorHint?: string;
  disabled: boolean;
  visible: boolean;
}

export interface FormDescriptor {
  selectorHint: string;
  labels: string[];
  inputs: ControlDescriptor[];
  buttons: ControlDescriptor[];
}

export interface TableDescriptor {
  selectorHint: string;
  headers: string[];
  rowCount: number;
}

export interface NetworkEvent {
  url: string;
  method: string;
  status?: number;
  failureText?: string;
  resourceType?: string;
}

export interface ConsoleEvent {
  type: string;
  text: string;
}

export interface ScreenState {
  runId: string;
  url: string;
  routeKey: string;
  title: string;
  pageType: PageType;
  visibleText: string;
  textHash: string;
  controls: ControlDescriptor[];
  forms: FormDescriptor[];
  tables: TableDescriptor[];
  breadcrumbs: string[];
  accessibilitySnapshot?: unknown;
  screenshotPath?: string;
  domSnapshotPath?: string;
  consoleEvents: ConsoleEvent[];
  networkEvents: NetworkEvent[];
  capturedAt: string;
}

export interface CandidateAction {
  id: string;
  kind: ActionKind;
  label: string;
  description: string;
  risk: ActionRisk;
  selectorHint?: string;
  href?: string;
  inputValue?: string;
  expectedResult: string;
  cleanupRequired: boolean;
  approvalRequired: boolean;
  source: "deterministic" | "stagehand" | "planner";
}

export interface PolicyDecision {
  decision: SafetyDecision;
  reason: string;
  action: CandidateAction;
}

export interface OracleJudgment {
  summary: string;
  expectedBehaviors: string[];
  mismatches: Array<{
    category: FindingCategory;
    severity: FindingSeverity;
    title: string;
    expected: string;
    actual: string;
    citationUrls: string[];
  }>;
  citations: Array<{
    title: string;
    url: string;
  }>;
  modelProvider?: "openrouter" | "heuristic";
  model?: string;
  retrievalMode?: "local" | "openai_vector_store" | "local_plus_openai_vector_store" | "none";
  usage?: {
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
    accumulatedCostUsd: number;
    budgetUsd: number;
  };
}

export interface Finding {
  id: string;
  runId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  route: string;
  tenant: string;
  role: string;
  steps: string[];
  expected: string;
  actual: string;
  screenshotPath?: string;
  tracePath?: string;
  consoleEvidence: ConsoleEvent[];
  networkEvidence: NetworkEvent[];
  citationUrls: string[];
  createdAt: string;
}

export interface TenantCredentialProfile {
  tenant: string;
  role: string;
  email: string;
  password: string;
}

export interface AgentConfig {
  baseUrl: string;
  wikiUrl: string;
  runId?: string;
  resumeRunId?: string;
  tenant: string;
  role: string;
  maxSteps: number;
  headless: boolean;
  useStagehand: boolean;
  approvalMode: "block" | "allow_destructive";
  vectorStoreId?: string;
  wikiJsonlPath?: string;
  model: string;
  storagePath: string;
  artifactDir: string;
  credentialsFile?: string;
  seedUrls?: string[];
  discoverLinks?: boolean;
  runRequest?: RunRequest;
}

export interface RunSummary {
  runId: string;
  status: "running" | "completed" | "failed" | "incomplete";
  startedAt: string;
  completedAt?: string;
  routesVisited: number;
  routesQueued: number;
  actionsAttempted: number;
  findings: number;
}

export type RunRequestType = "full" | "recent_change" | "screen" | "flow" | "baseline" | "wiki_sync";

export type RunActionPolicy = "read_only" | "sandbox_mutation" | "approval_required";

export interface RunRequest {
  type: RunRequestType;
  tenant: string;
  role: string;
  requestedBy?: string;
  slackChannel?: string;
  slackThreadTs?: string;
  prompt?: string;
  seedUrls?: string[];
  targetModules?: string[];
  maxSteps?: number;
  maxDepth?: number;
  budgetUsd?: number;
  actionPolicy: RunActionPolicy;
  enableStagehand?: boolean;
  baselineRunId?: string;
  promoteBaseline?: boolean;
  prUrl?: string;
  budgetProfile?: BudgetProfile;
}

export interface ImpactPlan {
  modules: string[];
  routes: string[];
  wikiCitations: Array<{
    title: string;
    url: string;
    articleId?: string;
  }>;
  confidence: number;
  missingInfo: string[];
  runScope: "full" | "targeted" | "clarify";
}

export interface QaJob {
  jobId: string;
  status: "queued" | "running" | "completed" | "incomplete" | "failed" | "cancelled";
  request: RunRequest;
  cloudRunExecutionId?: string;
  startedAt?: string;
  completedAt?: string;
  reportUrls?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BaselineComparison {
  newFindings: Finding[];
  knownFindings: Finding[];
  resolvedFindings: Finding[];
  routeCoverageDelta: {
    added: string[];
    removed: string[];
    unchanged: string[];
  };
  screenFingerprintDelta: {
    changed: string[];
    unchanged: string[];
  };
}

export interface BudgetProfile {
  budgetUsd: number;
  tier: "micro" | "standard" | "deep" | "release";
  lightModel: string;
  heavyModel: string;
  selectedModel: string;
  maxSteps: number;
  maxDepth: number;
  oracleFrequency: "minimal" | "selective" | "normal" | "aggressive";
  allowStagehand: boolean;
  allowHeavyModel: boolean;
  rationale: string;
}

export interface BrowserSession {
  sessionId: string;
  runId: string;
  tenant: string;
  role: string;
  currentUrl?: string;
  status: "starting" | "ready" | "failed" | "closed" | "expired";
  slackChannel?: string;
  slackThreadTs?: string;
  createdAt: string;
  lastObservationAt?: string;
  expiresAt: string;
  error?: string;
}

export interface SessionObservation {
  sessionId: string;
  screen: ScreenState;
  summary: string;
  screenshotUrl?: string;
}

export interface PrImpactRequest {
  prUrl: string;
  tenant: string;
  role: string;
  budgetUsd?: number;
  requestedBy?: string;
  slackChannel?: string;
  slackThreadTs?: string;
}

export interface PrImpactPlan {
  prUrl: string;
  repo: string;
  owner: string;
  number: number;
  title: string;
  filesChanged: string[];
  modules: string[];
  routes: string[];
  confidence: number;
  summary: string;
  budgetProfile?: BudgetProfile;
}

export type CodeGraphNodeType = "repo" | "file" | "symbol" | "route" | "module" | "wiki" | "chunk";

export interface CodeGraphNode {
  id: string;
  type: CodeGraphNodeType;
  repo?: string;
  path?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface CodeGraphEdge {
  fromId: string;
  toId: string;
  type: "contains" | "depends_on" | "renders" | "mentions" | "maps_to" | "changed_by";
  metadata?: Record<string, unknown>;
}

export interface CodeSearchResult {
  repo: string;
  path: string;
  chunkId: string;
  text: string;
  score: number;
  symbols?: string[];
  routes?: string[];
  modules?: string[];
  metadata?: Record<string, unknown>;
}
