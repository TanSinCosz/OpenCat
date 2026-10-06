/** 评测运行目录与详情；协调数据集和指标合并，保留历史有效指标回退策略。 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getEvaluationConfig } from "../config/load-config.js";
import type {
  CaseSummary,
  DatasetItemSummary,
  EvaluationOptions,
  JsonRecord,
  RunDetail,
  RunListItem,
} from "./types.js";
import type { DatasetRepository } from "./dataset.js";
import type { EvaluationWorkspace } from "./workspace.js";
import { readJson, readJsonl, readDatasetRecords, firstLine, stringValue } from "./records.js";
import {
  indexRootSummaryResults,
  mergeCaseSummaryWithRunResult,
  caseSummaryFromRunResult,
  hasMetricData,
  summarizeCase,
  summarizeTotals,
  resolveEvalVersion,
} from "./metrics.js";

const DATASET_ONLY_RUN_NAME = "__dataset__";

export function createRunRepository(
  options: EvaluationOptions,
  datasets: DatasetRepository,
  workspaces: EvaluationWorkspace,
) {
  const { evalRoot, evalRoots, appConfig } = options;
  const { ensureDatasetAvailable, resolveDatasetPathForRun } = datasets;
  const { getRepoWorkspaceStatus } = workspaces;

  async function listRuns(): Promise<RunListItem[]> {
    const runSets = await Promise.all(evalRoots.map((root) => listRunsInRoot(root)));
    const runs = runSets.flat();

    const sortedRuns = runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (sortedRuns.length > 0) {
      return sortedRuns;
    }

    return [];
  }

  async function listRunsInRoot(root: string): Promise<RunListItem[]> {
    const config = getEvaluationConfig(appConfig);
    await ensureDatasetAvailable(root, config);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("swe_"))
      .map(async (entry) => {
        const runPath = path.join(root, entry.name);
        const info = await stat(runPath);
        const summary = await readJson(path.join(runPath, "summary.json"));
        const config = getEvaluationConfig(appConfig);
        return {
          name: entry.name,
          path: runPath,
          evalRoot: root,
          updatedAt: info.mtime.toISOString(),
          version: resolveEvalVersion(summary, config),
          summary,
        };
      }));

    if (runs.length > 0) {
      return runs;
    }

    return config ? [await createDatasetOnlyRun(config, root)] : [];
  }

  async function findRun(name: string): Promise<RunListItem> {
    const runs = await listRuns();
    const run = runs.find((item) => item.name === name) ?? runs[0];
    if (!run) {
      throw new Error(`No SWE eval runs found under ${evalRoot}`);
    }
    return run;
  }

  async function loadRunDetail(run: RunListItem): Promise<RunDetail> {
    if (run.datasetOnly) {
      const config = getEvaluationConfig(appConfig);
      const datasetItems = await loadDatasetItems(run, [], config);
      return {
        run,
        version: resolveEvalVersion(run.summary, config),
        rootSummary: run.summary,
        cases: [],
        datasetItems,
        config,
        totals: summarizeTotals([]),
      };
    }
    const entries = await readdir(run.path, { withFileTypes: true }).catch(() => []);
    const rootSummary = run.summary;
    const rootResults = indexRootSummaryResults(rootSummary);
    const caseEntries = entries.filter((entry) => entry.isDirectory());
    const caseIds = new Set(caseEntries.map((entry) => entry.name));
    for (const caseId of rootResults.keys()) {
      caseIds.add(caseId);
    }

    const cases = await Promise.all([...caseIds].map(async (caseId) => {
      const caseDir = path.join(run.path, caseId);
      const hasCaseDirectory = caseEntries.some((entry) => entry.name === caseId);
      const events = hasCaseDirectory
        ? await readJsonl(path.join(caseDir, "events.jsonl"))
        : [];
      const summary = hasCaseDirectory
        ? await readJson(path.join(caseDir, "summary.json"))
        : undefined;
      return mergeCaseSummaryWithRunResult(
        summarizeCase(caseId, events, summary),
        rootResults.get(caseId),
      );
    }));

    // A skipped item can have a zero-metric record in the current run even
    // though the same item completed in an earlier run. Keep the current run
    // as the source of truth when it has metrics, otherwise reuse that older
    // metric-bearing result for the dashboard.
    const historicalCases = await loadHistoricalMetricCases(run);
    const displayCases = cases.map((item) => {
      const historical = historicalCases.get(item.caseId);
      return !hasMetricData(item) && historical
        ? { ...historical, caseId: item.caseId, repo: item.repo ?? historical.repo }
        : item;
    });

    const config = getEvaluationConfig(appConfig);
    const datasetItems = await loadDatasetItems(run, displayCases, config);
    return {
      run,
      version: resolveEvalVersion(rootSummary, config),
      rootSummary,
      cases: displayCases.sort((a, b) => a.caseId.localeCompare(b.caseId)),
      datasetItems,
      config,
      totals: summarizeTotals(displayCases),
    };
  }

  async function loadHistoricalMetricCases(
    run: RunListItem,
  ): Promise<Map<string, CaseSummary>> {
    const candidates = (await listRunsInRoot(run.evalRoot))
      .filter((candidate) => !candidate.datasetOnly &&
        candidate.path !== run.path &&
        candidate.updatedAt.localeCompare(run.updatedAt) < 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const historical = new Map<string, CaseSummary>();

    for (const candidate of candidates) {
      const results = indexRootSummaryResults(candidate.summary);
      for (const result of results.values()) {
        const summary = caseSummaryFromRunResult(result);
        if (summary && hasMetricData(summary) && !historical.has(summary.caseId)) {
          historical.set(summary.caseId, summary);
        }
      }
    }

    return historical;
  }

  async function createDatasetOnlyRun(
    config?: JsonRecord,
    root: string = evalRoot,
  ): Promise<RunListItem> {
    const info = await stat(root).catch(() => undefined);
    const rootName = path.basename(root);
    return {
      name: rootName === "swe-lite"
        ? "swe_lite_dataset"
        : rootName === "swe-lite-baseline"
        ? "swe_lite_baseline_dataset"
        : DATASET_ONLY_RUN_NAME,
      path: root,
      evalRoot: root,
      updatedAt: (info?.mtime ?? new Date()).toISOString(),
      version: resolveEvalVersion(undefined, config),
      summary: {},
      datasetOnly: true,
    };
  }

  async function loadDatasetItems(
    run: RunListItem,
    cases: readonly CaseSummary[],
    config?: JsonRecord,
  ): Promise<DatasetItemSummary[]> {
    const datasetPath = await resolveDatasetPathForRun(run, config);
    const records = await readDatasetRecords(datasetPath);
    const byCaseId = new Map(cases.map((item) => [item.caseId, item]));

    const items = await Promise.all(records.map(async (record) => {
      const instanceId = stringValue(record.instance_id) ?? "";
      const result = byCaseId.get(instanceId);
      return {
        instanceId,
        repo: stringValue(record.repo),
        baseCommit: stringValue(record.base_commit),
        problemPreview: firstLine(stringValue(record.problem_statement) ?? ""),
        problemStatement: stringValue(record.problem_statement),
        hintsText: stringValue(record.hints_text),
        testPatch: stringValue(record.test_patch),
        tested: result !== undefined,
        status: result?.status ?? result?.finishedReason,
        cacheHitRate: result?.cacheHitRate,
        totalTokens: result?.totalTokens,
        maxEstimatedTokens: result?.maxEstimatedTokens,
        workspace: await getRepoWorkspaceStatus(record),
      };
    }));

    return items.filter((item) => item.instanceId);
  }

  return { listRuns, findRun, loadRunDetail };
}
