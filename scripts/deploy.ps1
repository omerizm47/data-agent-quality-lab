# Deploys quality-lab notebooks + ground-truth CSVs to a Fabric workspace, optionally runs a notebook.
# Usage:
#   .\deploy.ps1 -WorkspaceId <ws-guid> -LakehouseId <lh-guid> -LakehouseName <name>   # deploy everything
#   ... -Run 01_register_agents                                                        # deploy, then run notebook and wait
#   ... -Run 02_run_evaluation -ParamsJson '{"SAMPLE_SIZE":{"value":2,"type":"int"}}'
param(
    [Parameter(Mandatory = $true)][string]$WorkspaceId,
    [Parameter(Mandatory = $true)][string]$LakehouseId,
    [Parameter(Mandatory = $true)][string]$LakehouseName,
    [string]$Run = "",
    [string]$ParamsJson = ""
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$base = "https://api.fabric.microsoft.com/v1"

$tok = (az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
$H  = @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" }

function Wait-LRO($resp) {
    if ($resp.StatusCode -notin 201, 202) { return }
    $loc = $resp.Headers['Location']; if ($loc -is [array]) { $loc = $loc[0] }
    if (-not $loc) { return }
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 3
        $st = Invoke-RestMethod -Uri $loc -Headers $H
        if ($st.status -in "Succeeded", "Completed") { return }
        if ($st.status -in "Failed", "Cancelled") { throw "LRO failed: $($st | ConvertTo-Json -Depth 5)" }
    }
    throw "LRO timeout"
}

# --- 1. Deploy notebooks ------------------------------------------------------
$items = (Invoke-RestMethod -Uri "$base/workspaces/$WorkspaceId/items" -Headers $H).value
foreach ($nb in Get-ChildItem "$repo\notebooks\*.ipynb") {
    $name = $nb.BaseName
    $content = (Get-Content $nb.FullName -Raw).
        Replace("{{DEFAULT_LAKEHOUSE_ID}}", $LakehouseId).
        Replace("{{DEFAULT_LAKEHOUSE_NAME}}", $LakehouseName).
        Replace("{{WORKSPACE_ID}}", $WorkspaceId)
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($content))
    $definition = @{ format = "ipynb"; parts = @(@{ path = "notebook-content.ipynb"; payload = $b64; payloadType = "InlineBase64" }) }
    $existing = $items | Where-Object { $_.type -eq "Notebook" -and $_.displayName -eq $name }
    if ($existing) {
        $body = @{ definition = $definition } | ConvertTo-Json -Depth 6
        $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items/$($existing.id)/updateDefinition" -Method Post -Headers $H -Body $body
        Wait-LRO $r
        Write-Host "updated  $name"
    } else {
        $body = @{ displayName = $name; type = "Notebook"; definition = $definition } | ConvertTo-Json -Depth 6
        for ($try = 1; $try -le 12; $try++) {
            try {
                $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items" -Method Post -Headers $H -Body $body
                break
            } catch {
                # freshly deleted display names stay reserved for a short while
                if ($_.ErrorDetails.Message -match "ItemDisplayNameNotAvailableYet" -and $try -lt 12) {
                    Write-Host "  name '$name' still reserved, retrying in 15s ($try/12)..."
                    Start-Sleep -Seconds 15
                } else { throw }
            }
        }
        Wait-LRO $r
        Write-Host "created  $name"
    }
}

# --- 2. Deploy semantic model (TMDL definition) -------------------------------
$smDir = "$repo\semantic_model"
if (Test-Path $smDir) {
    $smName = "agent_quality_lab_model"
    $parts = @()
    foreach ($file in Get-ChildItem $smDir -Recurse -File) {
        $rel = $file.FullName.Substring($smDir.Length + 1).Replace("\", "/")
        $content = (Get-Content $file.FullName -Raw).
            Replace("{{DEFAULT_LAKEHOUSE_ID}}", $LakehouseId).
            Replace("{{DEFAULT_LAKEHOUSE_NAME}}", $LakehouseName).
            Replace("{{WORKSPACE_ID}}", $WorkspaceId)
        $parts += @{ path = $rel; payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($content)); payloadType = "InlineBase64" }
    }
    $definition = @{ format = "TMDL"; parts = $parts }
    $existing = $items | Where-Object { $_.type -eq "SemanticModel" -and $_.displayName -eq $smName }
    if ($existing) {
        $body = @{ definition = $definition } | ConvertTo-Json -Depth 8
        $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items/$($existing.id)/updateDefinition" -Method Post -Headers $H -Body $body
        Wait-LRO $r
        Write-Host "updated  $smName (semantic model)"
    } else {
        $body = @{ displayName = $smName; type = "SemanticModel"; definition = $definition } | ConvertTo-Json -Depth 8
        $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items" -Method Post -Headers $H -Body $body
        Wait-LRO $r
        Write-Host "created  $smName (semantic model)"
    }
}

# --- 3. Deploy data pipeline ---------------------------------------------------
$plDir = "$repo\pipeline"
if (Test-Path $plDir) {
    $items = (Invoke-RestMethod -Uri "$base/workspaces/$WorkspaceId/items" -Headers $H).value
    $nb02 = $items | Where-Object { $_.type -eq "Notebook" -and $_.displayName -eq "02_run_evaluation" }
    foreach ($pl in Get-ChildItem "$plDir\*.json") {
        $plName = $pl.BaseName
        $content = (Get-Content $pl.FullName -Raw).
            Replace("{{NOTEBOOK_02_ID}}", $nb02.id).
            Replace("{{WORKSPACE_ID}}", $WorkspaceId)
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($content))
        $definition = @{ parts = @(@{ path = "pipeline-content.json"; payload = $b64; payloadType = "InlineBase64" }) }
        $existing = $items | Where-Object { $_.type -eq "DataPipeline" -and $_.displayName -eq $plName }
        if ($existing) {
            $body = @{ definition = $definition } | ConvertTo-Json -Depth 8
            $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items/$($existing.id)/updateDefinition" -Method Post -Headers $H -Body $body
            Wait-LRO $r
            Write-Host "updated  $plName (pipeline)"
        } else {
            $body = @{ displayName = $plName; type = "DataPipeline"; definition = $definition } | ConvertTo-Json -Depth 8
            $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items" -Method Post -Headers $H -Body $body
            Wait-LRO $r
            Write-Host "created  $plName (pipeline)"
        }
    }
}

# --- 3b. Deploy report (PBIR-Legacy, bound to the semantic model) --------------
$rpDir = "$repo\report"
if ((Test-Path "$rpDir\report.json") -and (Test-Path "$rpDir\definition.pbir")) {
    $rpName = "agent_quality_scorecard"
    $items = (Invoke-RestMethod -Uri "$base/workspaces/$WorkspaceId/items" -Headers $H).value
    $sm = $items | Where-Object { $_.type -eq "SemanticModel" -and $_.displayName -eq "agent_quality_lab_model" }
    $wsInfo = Invoke-RestMethod -Uri "$base/workspaces/$WorkspaceId" -Headers $H
    if ($sm) {
        $pbir = (Get-Content "$rpDir\definition.pbir" -Raw).
            Replace("{{SEMANTIC_MODEL_ID}}", $sm.id).
            Replace("{{SEMANTIC_MODEL_NAME}}", $sm.displayName).
            Replace("{{WORKSPACE_NAME}}", $wsInfo.displayName)
        $reportJson = Get-Content "$rpDir\report.json" -Raw
        $definition = @{ parts = @(
            @{ path = "report.json"; payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($reportJson)); payloadType = "InlineBase64" },
            @{ path = "definition.pbir"; payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pbir)); payloadType = "InlineBase64" }
        ) }
        $existing = $items | Where-Object { $_.type -eq "Report" -and $_.displayName -eq $rpName }
        if ($existing) {
            $body = @{ definition = $definition } | ConvertTo-Json -Depth 8
            $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items/$($existing.id)/updateDefinition" -Method Post -Headers $H -Body $body
            Wait-LRO $r
            Write-Host "updated  $rpName (report)"
        } else {
            $body = @{ displayName = $rpName; type = "Report"; definition = $definition } | ConvertTo-Json -Depth 8
            $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items" -Method Post -Headers $H -Body $body
            Wait-LRO $r
            Write-Host "created  $rpName (report)"
        }
    } else {
        Write-Host "skip report: semantic model not found"
    }
}

# --- 4. Upload ground-truth CSVs to lakehouse Files --------------------------
$stok = (az account get-access-token --resource https://storage.azure.com --query accessToken -o tsv)
$SH = @{ Authorization = "Bearer $stok" }
foreach ($csv in Get-ChildItem "$repo\ground_truth\*.csv" -ErrorAction SilentlyContinue) {
    $bytes = [IO.File]::ReadAllBytes($csv.FullName)
    $path = "https://onelake.dfs.fabric.microsoft.com/$WorkspaceId/$LakehouseId/Files/ground_truth/$($csv.Name)"
    Invoke-RestMethod -Uri "$path`?resource=file" -Method Put -Headers $SH | Out-Null
    Invoke-RestMethod -Uri "$path`?action=append&position=0" -Method Patch -Headers $SH -Body $bytes -ContentType "application/octet-stream" | Out-Null
    Invoke-RestMethod -Uri "$path`?action=flush&position=$($bytes.Length)" -Method Patch -Headers $SH | Out-Null
    Write-Host "uploaded $($csv.Name)"
}

# --- 5. Optionally run a notebook and wait ------------------------------------
if ($Run) {
    $items = (Invoke-RestMethod -Uri "$base/workspaces/$WorkspaceId/items" -Headers $H).value
    $nb = $items | Where-Object { $_.type -eq "Notebook" -and $_.displayName -eq $Run }
    if (-not $nb) { throw "Notebook '$Run' not found" }
    $exec = @{ executionData = @{} }
    if ($ParamsJson) { $exec.executionData.parameters = ($ParamsJson | ConvertFrom-Json -AsHashtable) }
    $r = Invoke-WebRequest -Uri "$base/workspaces/$WorkspaceId/items/$($nb.id)/jobs/instances?jobType=RunNotebook" `
        -Method Post -Headers $H -Body ($exec | ConvertTo-Json -Depth 6)
    $loc = $r.Headers['Location']; if ($loc -is [array]) { $loc = $loc[0] }
    Write-Host "run started: $Run"
    for ($i = 0; $i -lt 240; $i++) {
        Start-Sleep -Seconds 10
        $st = Invoke-RestMethod -Uri $loc -Headers $H
        if ($st.status -in "Completed", "Failed", "Cancelled", "Deduped") {
            Write-Host "run finished: $($st.status)"
            if ($st.status -ne "Completed") { $st.failureReason | ConvertTo-Json -Depth 6 | Write-Host; exit 1 }
            break
        }
    }
}
Write-Host "done"
