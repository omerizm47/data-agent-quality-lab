# Generates report/report.json (PBIR-Legacy) for the Agent Quality Lab scorecard.
# Run after changing the layout; commit the output.
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent

# ---------- palette (Fluent) ----------
$cAccent   = "#0078D4"
$cText     = "#201F1E"
$cSubtle   = "#605E5C"
$cBorder   = "#E1DFDD"
$cHeaderBg = "#F3F2F1"
$cBandBg   = "#FAF9F8"
$cPageBg   = "#F7F6F5"

function New-Literal([string]$v) { @{ expr = @{ Literal = @{ Value = $v } } } }
function New-Solid([string]$hex) { @{ solid = @{ color = (New-Literal "'$hex'") } } }
function New-From([string]$alias, [string]$entity) { @{ Name = $alias; Entity = $entity; Type = 0 } }
function New-MeasureSelect([string]$alias, [string]$entity, [string]$measure) {
    @{ Measure = @{ Expression = @{ SourceRef = @{ Source = $alias } }; Property = $measure }; Name = "$entity.$measure" }
}
function New-ColumnSelect([string]$alias, [string]$entity, [string]$column) {
    @{ Column = @{ Expression = @{ SourceRef = @{ Source = $alias } }; Property = $column }; Name = "$entity.$column" }
}

# container-level "tile" treatment: white card, hairline border, soft shadow
function Get-TileVcObjects([string]$title) {
    $vc = @{
        background = @(@{ properties = @{ color = (New-Solid "#FFFFFF"); transparency = (New-Literal "0D") } })
        border     = @(@{ properties = @{ show = (New-Literal "true"); color = (New-Solid $cBorder); radius = (New-Literal "6D") } })
        dropShadow = @(@{ properties = @{ show = (New-Literal "true"); preset = (New-Literal "'BottomRight'") } })
    }
    if ($title) {
        $vc.title = @(@{ properties = @{
            show = (New-Literal "true"); text = (New-Literal "'$title'")
            fontColor = (New-Solid $cText); fontSize = (New-Literal "12D")
            fontFamily = (New-Literal "'Segoe UI Semibold'")
        } })
    } else {
        $vc.title = @(@{ properties = @{ show = (New-Literal "false") } })
    }
    $vc
}

function New-Vis([hashtable]$cfg, [int]$x, [int]$y, [int]$w, [int]$h) {
    $cfg.layouts = @(@{ id = 0; position = @{ x = $x; y = $y; z = 0; width = $w; height = $h } })
    @{ x = $x; y = $y; z = 0; width = $w; height = $h
       config = ($cfg | ConvertTo-Json -Depth 32 -Compress); filters = "[]" }
}

function New-Card([string]$name, [int]$x, [int]$y, [string]$entity, [string]$measure, [string]$valueSize = "28D") {
    $cfg = @{
        name = $name
        singleVisual = @{
            visualType = "card"
            projections = @{ Values = @(@{ queryRef = "$entity.$measure" }) }
            prototypeQuery = @{
                Version = 2
                From = @(New-From "a" $entity)
                Select = @(New-MeasureSelect "a" $entity $measure)
            }
            objects = @{
                labels = @(@{ properties = @{ color = (New-Solid $cAccent); fontSize = (New-Literal $valueSize); fontFamily = (New-Literal "'Segoe UI Light'") } })
                categoryLabels = @(@{ properties = @{ show = (New-Literal "true"); color = (New-Solid $cSubtle); fontSize = (New-Literal "10D") } })
            }
            vcObjects = (Get-TileVcObjects $null)
            drillFilterOtherVisuals = $true
        }
    }
    New-Vis $cfg $x $y 295 96
}

function New-Header([string]$name, [string]$title, [string]$subtitle) {
    $cfg = @{
        name = $name
        singleVisual = @{
            visualType = "textbox"
            drillFilterOtherVisuals = $true
            objects = @{
                general = @(@{ properties = @{ paragraphs = @(
                    @{ textRuns = @(@{ value = $title; textStyle = @{ fontWeight = "bold"; fontSize = "20pt"; color = $cText; fontFamily = "Segoe UI" } }) },
                    @{ textRuns = @(@{ value = $subtitle; textStyle = @{ fontSize = "11pt"; color = $cSubtle; fontFamily = "Segoe UI" } }) }
                ) } })
            }
            vcObjects = @{ background = @(@{ properties = @{ transparency = (New-Literal "100D") } }) }
        }
    }
    New-Vis $cfg 20 14 1240 72
}

# shared tableEx styling: gray header row, banded rows, word wrap, per-column widths
function Get-TableObjects([array]$columnWidths) {
    $o = @{
        grid = @(@{ properties = @{
            gridHorizontal = (New-Literal "true"); gridHorizontalColor = (New-Solid $cBorder); gridHorizontalWeight = (New-Literal "1D")
            gridVertical = (New-Literal "false"); rowPadding = (New-Literal "8D")
        } })
        columnHeaders = @(@{ properties = @{
            backColor = (New-Solid $cHeaderBg); fontColor = (New-Solid $cText)
            fontSize = (New-Literal "11D"); fontFamily = (New-Literal "'Segoe UI Semibold'")
            wordWrap = (New-Literal "true"); outline = (New-Literal "'None'")
        } })
        values = @(@{ properties = @{
            fontSize = (New-Literal "10D")
            fontColorPrimary = (New-Solid $cText); fontColorSecondary = (New-Solid $cText)
            backColor = (New-Solid "#FFFFFF"); backColorSecondary = (New-Solid $cBandBg)
            wordWrap = (New-Literal "true")
        } })
    }
    if ($columnWidths) {
        $o.columnWidth = @($columnWidths | ForEach-Object {
            @{ selector = @{ metadata = $_.ref }; properties = @{ value = (New-Literal "$($_.px)D") } }
        })
    }
    $o
}

function New-SectionConfig() {
    @{ objects = @{ background = @(@{ properties = @{ color = (New-Solid $cPageBg); transparency = (New-Literal "0D") } }) } } |
        ConvertTo-Json -Depth 12 -Compress
}

$scores = "aql_agent_scores"
$evalout = "evaluation_output"
$recs = "aql_recommendations"

# ================= page 1: Agent Scorecard =================
$lineCfg = @{
    name = "accuracyTrend"
    singleVisual = @{
        visualType = "lineChart"
        projections = @{
            Category = @(@{ queryRef = "$scores.eval_date" })
            Series   = @(@{ queryRef = "$scores.agent_name" })
            Y        = @(@{ queryRef = "$scores.Accuracy %" })
        }
        prototypeQuery = @{
            Version = 2
            From = @(New-From "a" $scores)
            Select = @(
                (New-ColumnSelect "a" $scores "eval_date"),
                (New-ColumnSelect "a" $scores "agent_name"),
                (New-MeasureSelect "a" $scores "Accuracy %")
            )
        }
        objects = @{ legend = @(@{ properties = @{ show = (New-Literal "true"); position = (New-Literal "'Top'") } }) }
        vcObjects = (Get-TileVcObjects "Accuracy over time")
        drillFilterOtherVisuals = $true
    }
}
$lineVis = New-Vis $lineCfg 20 204 1240 236

$tblCfg = @{
    name = "agentScorecard"
    singleVisual = @{
        visualType = "tableEx"
        projections = @{
            Values = @(
                @{ queryRef = "$scores.agent_name" },
                @{ queryRef = "$scores.Latest Accuracy %" },
                @{ queryRef = "$scores.Accuracy Change vs Previous" },
                @{ queryRef = "$scores.Avg Latency (s)" },
                @{ queryRef = "$scores.Questions Evaluated" }
            )
        }
        prototypeQuery = @{
            Version = 2
            From = @(New-From "a" $scores)
            Select = @(
                (New-ColumnSelect "a" $scores "agent_name"),
                (New-MeasureSelect "a" $scores "Latest Accuracy %"),
                (New-MeasureSelect "a" $scores "Accuracy Change vs Previous"),
                (New-MeasureSelect "a" $scores "Avg Latency (s)"),
                (New-MeasureSelect "a" $scores "Questions Evaluated")
            )
        }
        columnProperties = @{ "$scores.agent_name" = @{ displayName = "Agent" } }
        objects = (Get-TableObjects @(
            @{ ref = "$scores.agent_name"; px = 300 },
            @{ ref = "$scores.Latest Accuracy %"; px = 200 },
            @{ ref = "$scores.Accuracy Change vs Previous"; px = 250 },
            @{ ref = "$scores.Avg Latency (s)"; px = 200 },
            @{ ref = "$scores.Questions Evaluated"; px = 220 }
        ))
        vcObjects = (Get-TileVcObjects "Latest scores by agent")
        drillFilterOtherVisuals = $true
    }
}
$tblVis = New-Vis $tblCfg 20 456 1240 244

$section = @{
    name = "ReportSection1"
    displayName = "Agent Scorecard"
    displayOption = 1
    height = 720
    width = 1280
    config = (New-SectionConfig)
    filters = "[]"
    visualContainers = @(
        (New-Header "hdr1" "Agent quality scorecard" "Accuracy of every registered data agent against its ground-truth question bank, evaluated on a schedule."),
        (New-Card "cardAccuracy" 20 98 $scores "Accuracy %"),
        (New-Card "cardQuestions" 335 98 $scores "Questions Evaluated"),
        (New-Card "cardIncorrect" 650 98 $evalout "Incorrect Answers"),
        (New-Card "cardUnclear" 965 98 $evalout "Unclear Answers"),
        $lineVis,
        $tblVis
    )
}

# ================= page 2: What to fix =================
$fixTblCfg = @{
    name = "recommendationsTable"
    singleVisual = @{
        visualType = "tableEx"
        projections = @{
            Values = @(
                @{ queryRef = "$recs.created_at" },
                @{ queryRef = "$recs.agent_name" },
                @{ queryRef = "$recs.diagnosis" },
                @{ queryRef = "$recs.n_questions" },
                @{ queryRef = "$recs.recommendation" }
            )
        }
        prototypeQuery = @{
            Version = 2
            From = @(New-From "a" $recs)
            Select = @(
                (New-ColumnSelect "a" $recs "created_at"),
                (New-ColumnSelect "a" $recs "agent_name"),
                (New-ColumnSelect "a" $recs "diagnosis"),
                (New-ColumnSelect "a" $recs "n_questions"),
                (New-ColumnSelect "a" $recs "recommendation")
            )
            OrderBy = @(@{ Direction = 2; Expression = @{ Column = @{ Expression = @{ SourceRef = @{ Source = "a" } }; Property = "created_at" } } })
        }
        columnProperties = @{
            "$recs.created_at"     = @{ displayName = "When (UTC)" }
            "$recs.agent_name"     = @{ displayName = "Agent" }
            "$recs.diagnosis"      = @{ displayName = "Diagnosis" }
            "$recs.n_questions"    = @{ displayName = "Questions" }
            "$recs.recommendation" = @{ displayName = "Recommended action" }
        }
        objects = (Get-TableObjects @(
            @{ ref = "$recs.created_at"; px = 150 },
            @{ ref = "$recs.agent_name"; px = 180 },
            @{ ref = "$recs.diagnosis"; px = 170 },
            @{ ref = "$recs.n_questions"; px = 95 },
            @{ ref = "$recs.recommendation"; px = 620 }
        ))
        vcObjects = (Get-TileVcObjects "Recommendations (newest first)")
        drillFilterOtherVisuals = $true
    }
}
$fixTblVis = New-Vis $fixTblCfg 20 204 1240 496

$fixSection = @{
    name = "ReportSection2"
    displayName = "What to fix"
    displayOption = 1
    height = 720
    width = 1280
    config = (New-SectionConfig)
    filters = "[]"
    visualContainers = @(
        (New-Header "hdr2" "What to fix" "Root-cause diagnoses and recommended actions. 02_run_evaluation logs pointers on failures and regressions; 03_analyze_failures adds per-question diagnoses. An empty page means healthy agents."),
        (New-Card "cardRecCount" 20 98 $recs "Recommendations Logged"),
        (New-Card "cardAffectedQ" 335 98 $recs "Affected Questions"),
        (New-Card "cardAgents" 650 98 $recs "Agents Affected"),
        (New-Card "cardLatestRec" 965 98 $recs "Latest Recommendation Date" "14D"),
        $fixTblVis
    )
}

$report = @{
    config = '{"version":"5.43","themeCollection":{"baseTheme":{"name":"CY24SU06"}}}'
    layoutOptimization = 0
    sections = @($section, $fixSection)
}

$out = "$repo\report\report.json"
New-Item -ItemType Directory -Path "$repo\report" -Force | Out-Null
$report | ConvertTo-Json -Depth 40 | Set-Content $out -Encoding utf8
Write-Host "wrote $out"
