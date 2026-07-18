"""Install the Data Agent Quality Lab from inside a Fabric notebook — no local tools needed.

Usage (paste into any Fabric notebook cell):

    import requests
    exec(requests.get(
        "https://api.github.com/repos/omerizm47/data-agent-quality-lab/contents/scripts/fabric_install.py",
        headers={"Accept": "application/vnd.github.raw"}).text)

    install()                      # deploy everything into the current workspace
    register_agents([{"name": "MyAgent", "workspace": "other-ws", "bank": "default"}])
    run_evaluation()               # baseline run

While the repo is private, pass a GitHub token:
    headers={"Accept": "application/vnd.github.raw", "Authorization": "Bearer <PAT>"}
    install(github_token="<PAT>")

Or drive everything from a YAML config (see config.example.yaml):
    install(config="/lakehouse/default/Files/aql_config.yaml")
"""
import base64
import io
import json
import os
import tempfile
import time
import zipfile

import requests

FABRIC = "https://api.fabric.microsoft.com/v1"
ONELAKE = "https://onelake.dfs.fabric.microsoft.com"
MODEL_NAME = "agent_quality_lab_model"
REPORT_NAME = "agent_quality_scorecard"
DEFAULT_REPO = "omerizm47/data-agent-quality-lab"

_STATE = {"workspace_id": None}


# --- Fabric plumbing -----------------------------------------------------------
def _get_token(audience):
    try:
        import notebookutils  # Fabric notebook / recent runtimes
        return notebookutils.credentials.getToken(audience)
    except Exception:
        from notebookutils import mssparkutils  # older runtimes / Livy
        return mssparkutils.credentials.getToken(audience)


def _fabric_headers():
    return {"Authorization": f"Bearer {_get_token('pbi')}", "Content-Type": "application/json"}


def _storage_headers():
    return {"Authorization": f"Bearer {_get_token('storage')}"}


def _current_workspace_id():
    try:
        import notebookutils
        ctx = notebookutils.runtime.context
        ws = ctx.get("currentWorkspaceId") or ctx.get("workspaceId")
        if ws:
            return ws
    except Exception:
        pass
    import sempy.fabric as sf
    return str(sf.get_workspace_id())


def _wait_lro(resp, headers):
    if resp.status_code not in (201, 202):
        return
    loc = resp.headers.get("Location")
    if not loc:
        return
    for _ in range(60):
        time.sleep(3)
        st = requests.get(loc, headers=headers).json()
        status = st.get("status")
        if status in ("Succeeded", "Completed"):
            return
        if status in ("Failed", "Cancelled"):
            raise RuntimeError(f"LRO failed: {json.dumps(st, indent=2)}")
    raise RuntimeError("LRO timeout")


def _list_items(ws, headers):
    return requests.get(f"{FABRIC}/workspaces/{ws}/items", headers=headers).json()["value"]


def _b64(text):
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _create_or_update(ws, items, name, item_type, definition, headers):
    existing = next((i for i in items if i["type"] == item_type and i["displayName"] == name), None)
    if existing:
        r = requests.post(f"{FABRIC}/workspaces/{ws}/items/{existing['id']}/updateDefinition",
                          headers=headers, json={"definition": definition})
        if r.status_code >= 400:
            raise RuntimeError(f"update {name}: {r.status_code} {r.text[:500]}")
        _wait_lro(r, headers)
        print(f"updated  {name}")
        return existing["id"]
    body = {"displayName": name, "type": item_type, "definition": definition}
    for attempt in range(1, 13):
        r = requests.post(f"{FABRIC}/workspaces/{ws}/items", headers=headers, json=body)
        if r.status_code < 400:
            break
        if "ItemDisplayNameNotAvailableYet" in r.text and attempt < 12:
            print(f"  name '{name}' still reserved, retrying in 15s ({attempt}/12)...")
            time.sleep(15)
            continue
        raise RuntimeError(f"create {name}: {r.status_code} {r.text[:500]}")
    _wait_lro(r, headers)
    item_id = (r.json() or {}).get("id")
    print(f"created  {name}")
    return item_id


# --- source fetching -------------------------------------------------------------
def _fetch_source(source, repo, ref, github_token):
    """Return a local directory containing the repo tree."""
    if source and source != "github":
        if not os.path.isdir(source):
            raise ValueError(f"source directory not found: {source}")
        return source
    headers = {"Accept": "application/vnd.github+json"}
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"
    r = requests.get(f"https://api.github.com/repos/{repo}/zipball/{ref}", headers=headers)
    if r.status_code >= 400:
        raise RuntimeError(f"GitHub download failed ({r.status_code}). "
                           "Private repo? Pass github_token='<PAT>'.")
    tmp = tempfile.mkdtemp(prefix="aql_")
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        z.extractall(tmp)
    root = next(os.path.join(tmp, d) for d in os.listdir(tmp)
                if os.path.isdir(os.path.join(tmp, d)))
    return root


# --- lakehouse -------------------------------------------------------------------
def _ensure_lakehouse(ws, name, headers):
    lhs = requests.get(f"{FABRIC}/workspaces/{ws}/lakehouses", headers=headers).json()["value"]
    lh = next((l for l in lhs if l["displayName"] == name), None)
    if lh:
        return lh["id"]
    r = requests.post(f"{FABRIC}/workspaces/{ws}/lakehouses", headers=headers,
                      json={"displayName": name})
    if r.status_code >= 400:
        raise RuntimeError(f"create lakehouse: {r.status_code} {r.text[:500]}")
    _wait_lro(r, headers)
    for _ in range(20):
        lhs = requests.get(f"{FABRIC}/workspaces/{ws}/lakehouses", headers=headers).json()["value"]
        lh = next((l for l in lhs if l["displayName"] == name), None)
        if lh:
            print(f"created  {name} (lakehouse)")
            return lh["id"]
        time.sleep(3)
    raise RuntimeError("lakehouse did not appear after creation")


# --- config ----------------------------------------------------------------------
def _load_config(config):
    if config is None:
        return {}
    if isinstance(config, dict):
        return config
    import yaml
    text = config
    if os.path.exists(config):
        with open(config, "r", encoding="utf-8") as f:
            text = f.read()
    return yaml.safe_load(text) or {}


# --- main entry points -------------------------------------------------------------
def install(lakehouse_name="agent_quality_lab_lh", workspace_id=None, config=None,
            source="github", repo=DEFAULT_REPO, ref="main", github_token=None):
    """Deploy the whole lab (notebooks, model, pipeline, report, sample bank) into a workspace."""
    cfg = _load_config(config)
    lakehouse_name = cfg.get("lakehouse", lakehouse_name)
    ws = workspace_id or cfg.get("workspace_id") or _current_workspace_id()
    _STATE["workspace_id"] = ws
    H = _fabric_headers()
    root = _fetch_source(source, repo, ref, github_token)
    lh_id = _ensure_lakehouse(ws, lakehouse_name, H)

    def sub(text):
        return (text.replace("{{DEFAULT_LAKEHOUSE_ID}}", lh_id)
                    .replace("{{DEFAULT_LAKEHOUSE_NAME}}", lakehouse_name)
                    .replace("{{WORKSPACE_ID}}", ws))

    # 1. notebooks
    items = _list_items(ws, H)
    nb_dir = os.path.join(root, "notebooks")
    for fn in sorted(os.listdir(nb_dir)):
        if not fn.endswith(".ipynb"):
            continue
        with open(os.path.join(nb_dir, fn), "r", encoding="utf-8") as f:
            content = sub(f.read())
        definition = {"format": "ipynb",
                      "parts": [{"path": "notebook-content.ipynb", "payload": _b64(content),
                                 "payloadType": "InlineBase64"}]}
        _create_or_update(ws, items, fn[:-6], "Notebook", definition, H)

    # 2. semantic model (TMDL)
    sm_dir = os.path.join(root, "semantic_model")
    if os.path.isdir(sm_dir):
        parts = []
        for dirpath, dirnames, files in os.walk(sm_dir):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fn in files:
                if fn.startswith("."):  # .crc/.DS_Store etc.
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, sm_dir).replace(os.sep, "/")
                with open(full, "r", encoding="utf-8") as f:
                    parts.append({"path": rel, "payload": _b64(sub(f.read())),
                                  "payloadType": "InlineBase64"})
        items = _list_items(ws, H)
        _create_or_update(ws, items, MODEL_NAME, "SemanticModel",
                          {"format": "TMDL", "parts": parts}, H)

    # 3. pipeline (needs notebook 02's id)
    pl_dir = os.path.join(root, "pipeline")
    if os.path.isdir(pl_dir):
        items = _list_items(ws, H)
        nb02 = next(i for i in items if i["type"] == "Notebook"
                    and i["displayName"] == "02_run_evaluation")
        for fn in sorted(os.listdir(pl_dir)):
            if not fn.endswith(".json"):
                continue
            with open(os.path.join(pl_dir, fn), "r", encoding="utf-8") as f:
                content = f.read().replace("{{NOTEBOOK_02_ID}}", nb02["id"]) \
                                  .replace("{{WORKSPACE_ID}}", ws)
            definition = {"parts": [{"path": "pipeline-content.json", "payload": _b64(content),
                                     "payloadType": "InlineBase64"}]}
            _create_or_update(ws, items, fn[:-5], "DataPipeline", definition, H)

    # 4. report (bound to the semantic model)
    rp_dir = os.path.join(root, "report")
    if os.path.isfile(os.path.join(rp_dir, "report.json")):
        items = _list_items(ws, H)
        sm = next((i for i in items if i["type"] == "SemanticModel"
                   and i["displayName"] == MODEL_NAME), None)
        if sm:
            ws_name = requests.get(f"{FABRIC}/workspaces/{ws}", headers=H).json()["displayName"]
            with open(os.path.join(rp_dir, "definition.pbir"), "r", encoding="utf-8") as f:
                pbir = (f.read().replace("{{SEMANTIC_MODEL_ID}}", sm["id"])
                               .replace("{{SEMANTIC_MODEL_NAME}}", sm["displayName"])
                               .replace("{{WORKSPACE_NAME}}", ws_name))
            with open(os.path.join(rp_dir, "report.json"), "r", encoding="utf-8") as f:
                report_json = f.read()
            definition = {"parts": [
                {"path": "report.json", "payload": _b64(report_json), "payloadType": "InlineBase64"},
                {"path": "definition.pbir", "payload": _b64(pbir), "payloadType": "InlineBase64"}]}
            _create_or_update(ws, items, REPORT_NAME, "Report", definition, H)
        else:
            print("skip report: semantic model not found")

    # 5. ground-truth CSVs
    gt_dir = os.path.join(root, "ground_truth")
    if os.path.isdir(gt_dir):
        SH = _storage_headers()
        for fn in sorted(os.listdir(gt_dir)):
            if not fn.endswith(".csv"):
                continue
            with open(os.path.join(gt_dir, fn), "rb") as f:
                data = f.read()
            path = f"{ONELAKE}/{ws}/{lh_id}/Files/ground_truth/{fn}"
            requests.put(f"{path}?resource=file", headers=SH).raise_for_status()
            requests.patch(f"{path}?action=append&position=0", headers={
                **SH, "Content-Type": "application/octet-stream"}, data=data).raise_for_status()
            requests.patch(f"{path}?action=flush&position={len(data)}", headers=SH).raise_for_status()
            print(f"uploaded {fn}")

    print(f"\ninstall complete: https://app.fabric.microsoft.com/groups/{ws}/list")

    # optional: config-driven registration + baseline
    agents = cfg.get("agents")
    if agents:
        register_agents(agents, auto_discover=cfg.get("auto_discover", True), workspace_id=ws)
    if cfg.get("run_baseline"):
        run_evaluation(workspace_id=ws)
    if not agents:
        print("next: register_agents([...]) then run_evaluation()")


def _typed_params(params):
    out = {}
    for k, v in params.items():
        if isinstance(v, bool):
            out[k] = {"value": v, "type": "bool"}
        elif isinstance(v, int):
            out[k] = {"value": v, "type": "int"}
        elif isinstance(v, float):
            out[k] = {"value": v, "type": "float"}
        elif isinstance(v, (dict, list)):
            out[k] = {"value": json.dumps(v), "type": "string"}
        else:
            out[k] = {"value": str(v), "type": "string"}
    return out


def _run_notebook(name, params, workspace_id=None, wait=True):
    ws = workspace_id or _STATE["workspace_id"] or _current_workspace_id()
    H = _fabric_headers()
    items = _list_items(ws, H)
    nb = next(i for i in items if i["type"] == "Notebook" and i["displayName"] == name)
    body = {"executionData": {"parameters": _typed_params(params)}} if params else {"executionData": {}}
    r = requests.post(f"{FABRIC}/workspaces/{ws}/items/{nb['id']}/jobs/instances?jobType=RunNotebook",
                      headers=H, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"run {name}: {r.status_code} {r.text[:500]}")
    loc = r.headers.get("Location")
    print(f"run started: {name}")
    if not wait or not loc:
        return
    for _ in range(240):
        time.sleep(10)
        st = requests.get(loc, headers=H).json()
        if st.get("status") in ("Completed", "Failed", "Cancelled", "Deduped"):
            print(f"run finished: {st['status']}")
            if st["status"] != "Completed":
                raise RuntimeError(json.dumps(st.get("failureReason"), indent=2))
            return


def register_agents(agents=None, auto_discover=True, workspace_id=None, wait=True):
    """Register agents to evaluate. agents = [{'name': ..., 'workspace': ..., 'bank': ...}, ...]"""
    extra = []
    for a in agents or []:
        extra.append({
            "agent_name": a.get("agent_name") or a["name"],
            "workspace_name": a.get("workspace_name") or a.get("workspace"),
            "question_bank": a.get("question_bank") or a.get("bank", "default"),
        })
    _run_notebook("01_register_agents",
                  {"AUTO_DISCOVER": auto_discover, "EXTRA_AGENTS": extra},
                  workspace_id, wait)


def run_evaluation(workspace_id=None, wait=True, **params):
    """Run the evaluation harness once (e.g. run_evaluation(AGENT_FILTER='Media'))."""
    _run_notebook("02_run_evaluation", params, workspace_id, wait)


print("Data Agent Quality Lab installer loaded: install() / register_agents() / run_evaluation()")
