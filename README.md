# Data Agent Quality Lab

Scheduled regression testing for Microsoft Fabric data agents. Evaluate every registered
agent against ground-truth question banks on a schedule, trend accuracy over time, and
alert on regressions.

Built on the official [`fabric-data-agent-sdk`](https://learn.microsoft.com/fabric/data-science/evaluate-data-agent)
evaluation module (preview). Follows the [Fabric Jumpstart](https://jumpstart.fabric.microsoft.com/) accelerator pattern.

## Prerequisites

- A **paid F SKU** capacity (F2+). Data agent AI operations are **not supported on trial (FTL) capacities**
  ("FTL64 SKU Not Supported" 403).
- At least one published Fabric data agent you have access to.
- Contributor+ on the workspace where the lab is installed.

## Items

| Item | Purpose |
|---|---|
| `agent_quality_lab_lh` (Lakehouse) | Ground-truth banks (`Files/ground_truth/*.csv`) + all result tables |
| `01_register_agents` (Notebook) | Register agents (auto-discover in workspace or explicit cross-workspace list), load/validate ground-truth CSVs |
| `02_run_evaluation` (Notebook) | Evaluation harness: loops agents × banks through `evaluate_data_agent`, records run metadata, rebuilds daily scores, detects regressions (fails the pipeline run when accuracy drops beyond `REGRESSION_THRESHOLD`), refreshes the semantic model |
| `03_analyze_failures` (Notebook) | Failure drill-down for a run: expected vs actual, thread links, generated queries + raw tool outputs, root-cause diagnosis + recommendations, config-drift check vs previous run |
| `daily_agent_evaluation` (Pipeline) | Runs 02 on a schedule (ships with a disabled daily trigger — enable it after install) |
| `agent_quality_lab_model` (Semantic model) | Direct Lake model over runs/scores/results/recommendations with accuracy measures |
| `agent_quality_scorecard` (Report) | Page 1 **Agent Scorecard**: accuracy cards, trend line, per-agent table. Page 2 **What to fix**: recommendation log with diagnosis + advice |

## Tables

- `aql_agents` — agent registry (name, workspace, stage, bank, enabled)
- `aql_ground_truth` — question banks (bank, question_id, question, expected_answer, category, tags)
- `aql_eval_runs` — one row per agent per run (status, duration, error, sdk version)
- `evaluation_output` / `evaluation_output_steps` — written by the SDK (verdicts, thread URLs, agent config snapshot, generated SQL/DAX/KQL + tool outputs)
- `aql_agent_scores` — derived daily scores (accuracy, unclear rate, latency)
- `aql_regressions` — accuracy drops vs the previous run (threshold-based)
- `aql_recommendations` — what to fix: diagnosis (`wrong_query`, `summarization_mismatch`, `no_data_returned`, `agent_error`, `regression_detected`, `high_latency`, `unclear_verdict`) + actionable advice per agent/run. Written automatically by 02 on failures/regressions (pointers) and in depth by 03

## Quick start (from a Fabric notebook — no local tools)

Open any notebook in the Fabric workspace where you want the lab installed and run:

```python
import requests
exec(requests.get(
    "https://api.github.com/repos/omerizm47/data-agent-quality-lab/contents/scripts/fabric_install.py",
    headers={"Accept": "application/vnd.github.raw"}).text)

install()                                             # lakehouse + notebooks + model + pipeline + report
register_agents([{"name": "MyAgent", "workspace": "other-ws", "bank": "default"}])
run_evaluation()                                      # baseline run
```

- `install()` targets the notebook's own workspace and creates the `agent_quality_lab_lh` lakehouse if missing. It's idempotent.
- While this repo is private, add `"Authorization": "Bearer <github-PAT>"` to the fetch headers and pass `github_token="<github-PAT>"` to `install()`.
- Prefer declarative? Put your agents/banks in a YAML file (see [config.example.yaml](config.example.yaml)) and call `install(config="/lakehouse/default/Files/aql_config.yaml")`.
- Add your own question banks by uploading `*.csv` (columns: `question,expected_answer[,category,tags]`) to `Files/ground_truth/` and re-running `01_register_agents`.

Then open the `agent_quality_scorecard` report and enable the daily trigger on `daily_agent_evaluation`. When something regresses, the pipeline run fails and page 2 ("What to fix") points you at `03_analyze_failures` with the right `RUN_ID`.

## Quick start (from your machine, PowerShell)

1. Create a workspace (assigned to a paid F capacity) and a lakehouse in it; grab both GUIDs from the portal URL.
2. Sign in with Azure CLI and deploy all items (idempotent — safe to re-run after edits):

   ```powershell
   az login
   .\scripts\deploy.ps1 -WorkspaceId <ws-guid> -LakehouseId <lh-guid> -LakehouseName <lh-name>
   ```

3. Run `01_register_agents` (drop your `*.csv` banks into `Files/ground_truth/` — columns: `question,expected_answer[,category,tags]`). Agents in the lab workspace are auto-discovered; register agents from other workspaces via the `EXTRA_AGENTS` parameter.
4. Run `02_run_evaluation`.
5. Open the `agent_quality_scorecard` report — accuracy trend on page 1, recommendations on page 2 ("What to fix").
6. When something fails or regresses, run `03_analyze_failures` (paste the `RUN_ID` from the recommendation) for per-question root cause and config drift.
7. Enable the daily trigger on `daily_agent_evaluation` for scheduled regression testing; a regression fails the pipeline run, so standard Fabric pipeline alerts (e.g. Activator on failure) light up.

## Notes

- SDK version is pinned (`fabric-data-agent-sdk==0.1.26a0`) — the evaluation API is preview and changes quickly.
- Each evaluated question costs ~50s of agent time + LLM critic usage; size banks/cadence accordingly.
