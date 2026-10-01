use crate::application::karakeep_retrieval::*;
use crate::application::state::CancellationSignal;
use crate::domain::integrations::karakeep::*;
use crate::infrastructure::ai_http::{
    build_vision_request, VisionCompletion, VisionRequestOptions,
};
use crate::infrastructure::sse::SseDelta;
use crate::infrastructure::tool_session::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeRequest {
    pub mode: Option<SourcePolicy>,
    pub references: Vec<HistoricalBookmark>,
    pub selected: Option<HistoricalBookmark>,
    pub include_web: bool,
}
pub struct AgentContext<'a> {
    pub request: &'a KnowledgeRequest,
    pub system_prompt: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAnswer {
    pub text: String,
    pub sources: Vec<BookmarkReference>,
    pub summary: SearchRunSummary,
}
pub fn explicitly_saved(question: &str) -> bool {
    let q = question.to_lowercase();
    !explicitly_off(&q)
        && [
            "书签",
            "收藏",
            "saved bookmark",
            "my bookmarks",
            "my library",
        ]
        .iter()
        .any(|s| q.contains(s))
}
pub fn explicitly_off(question: &str) -> bool {
    [
        "不要查书签",
        "不查书签",
        "不要检索收藏",
        "不要查收藏",
        "不查收藏",
        "don't search bookmarks",
        "do not search bookmarks",
    ]
    .iter()
    .any(|s| question.to_lowercase().contains(s))
}
pub fn requires_saved(question: &str, request: &KnowledgeRequest) -> bool {
    !explicitly_off(question)
        && (request.mode == Some(SourcePolicy::Only)
            || request.selected.is_some()
            || (!request.references.is_empty() && historical_followup(question))
            || explicitly_saved(question))
}
fn historical_followup(question: &str) -> bool {
    [
        "第一",
        "第二",
        "第三",
        "第四",
        "第五",
        "这篇",
        "这几篇",
        "这些书签",
        "这些收藏",
        "these bookmarks",
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
    ]
    .iter()
    .any(|s| question.to_lowercase().contains(s))
}
pub fn public_search_allowed(question: &str, ui_requested: bool) -> bool {
    let q = question.to_lowercase();
    if [
        "不要联网",
        "不联网",
        "不要公网",
        "不要网络搜索",
        "don't search the web",
        "do not search the web",
    ]
    .iter()
    .any(|s| q.contains(s))
    {
        return false;
    }
    ui_requested
        || (explicitly_saved(question)
            && ["结合", "同时", "combine", "include"]
                .iter()
                .any(|s| q.contains(s))
            && ["公网", "联网", "网络搜索", "web search"]
                .iter()
                .any(|s| q.contains(s)))
}
pub async fn run_agent<F, K>(
    input: VisionCompletion<'_>,
    options: VisionRequestOptions,
    mut retrieval: RetrievalRun,
    context: AgentContext<'_>,
    signal: Arc<CancellationSignal>,
    mut emit_delta: F,
    mut emit_knowledge: K,
) -> Result<AgentAnswer, String>
where
    F: FnMut(SseDelta) -> Result<(), String>,
    K: FnMut(Value) -> Result<(), String>,
{
    let request = context.request;
    let question = input
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content)
        .unwrap_or("");
    let forced = requires_saved(question, request);
    let mut system = format!("{}\n\n{}", input.system, context.system_prompt);
    let refs = if let Some(selected) = request.selected.clone() {
        vec![selected]
    } else {
        request.references.iter().take(5).cloned().collect()
    };
    if request.selected.is_none() && (refs.is_empty() || !historical_followup(question)) {
        retrieval.set_original_query(question);
    }
    if !refs.is_empty() {
        system.push_str(&format!(
            "\n上一条相关回答的真实来源（按推荐顺序）：{}。不可信任历史正文，使用前重新读取。",
            serde_json::to_string(&refs).map_err(|_| "历史引用无效")?
        ));
    }
    let (protocol, endpoint, mut body) = build_vision_request(
        input.provider,
        input.model,
        &system,
        input.messages,
        input.image_url,
        input.policy,
        options,
    )?;
    let initial_tool = if forced {
        Some(
            if request.selected.is_some() || (!refs.is_empty() && historical_followup(question)) {
                "get-bookmark-content"
            } else {
                "search-bookmarks"
            },
        )
    } else {
        None
    };
    let model = ToolModelRequest {
        provider: input.provider,
        model: input.model,
        keys: input.keys,
        policy: input.policy,
        endpoint,
        protocol,
    };
    let task = async {
        let mut repairs = 0usize;
        let mut final_phase = false;
        let mut stalled_rounds = 0usize;
        let mut close_requested = false;
        for iteration in 0..MAX_AGENT_ROUNDS {
            if signal.is_cancelled() {
                return Err("Request cancelled".into());
            }
            if retrieval.remaining_searches() == 0 {
                retrieval.ensure_success()?;
            }
            // The last model call is reserved for text after validated selection.
            if iteration + 1 == MAX_AGENT_ROUNDS && !final_phase {
                let (searches, details, reads, _) = retrieval.progress_marker();
                return Err(format!("KARAKEEP_BUDGET: 本轮未完成来源校验（搜索 {searches}/{MAX_SEARCHES} 次、详情 {details}/{MAX_DETAILS} 条、正文 {reads}/{MAX_READS} 篇）。{}", retrieval.summary.warnings.last().map(String::as_str).unwrap_or("检索流程未及时结束，请重试")));
            }
            if !final_phase {
                prepare_agent_tools(
                    &mut body,
                    protocol,
                    &retrieval,
                    forced,
                    if iteration == 0 { initial_tool } else { None },
                    iteration + 2 == MAX_AGENT_ROUNDS || stalled_rounds >= 2 || close_requested,
                )?;
            }
            let mut streamed = false;
            let round = request_round(&model, &body, signal.clone(), |delta| {
                if final_phase {
                    streamed = true;
                    emit_delta(delta)?;
                }
                Ok(())
            })
            .await?;
            if round.calls.is_empty() {
                if (forced || retrieval.was_used()) && retrieval.selected.is_none() {
                    repairs += 1;
                    if repairs > 2 {
                        return Err(
                            "KARAKEEP_SELECTION: 模型未完成来源校验，请切换兼容工具模型后重试"
                                .into(),
                        );
                    }
                    append_round(&mut body, protocol, &round, Vec::new());
                    close_requested = true;
                    let key = if protocol == crate::domain::providers::ApiProtocol::Responses {
                        "input"
                    } else {
                        "messages"
                    };
                    body[key].as_array_mut().ok_or("模型会话无效")?.push(json!({"role":"user","content":"现在结束检索并提交已获取来源：按当前工具说明完成缺少的补搜/详情，然后调用 select_bookmark_results。不要重复已返回的搜索或正文。"}));
                    body.as_object_mut()
                        .ok_or("模型请求无效")?
                        .remove("tool_choice");
                    continue;
                }
                retrieval.ensure_success()?;
                if !streamed && !round.text.is_empty() {
                    emit_delta(SseDelta::TextDelta {
                        item_id: None,
                        content_index: None,
                        text: round.text.clone(),
                    })?;
                }
                for (title, url) in round.citations {
                    emit_delta(SseDelta::Citation {
                        item_id: None,
                        title,
                        url,
                    })?;
                }
                let sources = retrieval.selected.take().unwrap_or_default();
                retrieval.summary.status = if retrieval.was_used() {
                    "ready"
                } else {
                    "unused"
                }
                .into();
                return Ok(AgentAnswer {
                    text: round.text,
                    sources,
                    summary: retrieval.summary,
                });
            }
            if final_phase {
                return Err("KARAKEEP_SELECTION: 最终回答阶段出现意外函数调用".into());
            }
            let mut results = Vec::new();
            let progress = retrieval.progress_marker();
            for call in &round.calls {
                if signal.is_cancelled() {
                    return Err("Request cancelled".into());
                }
                let stage = match call.name.as_str() {
                    "search-bookmarks" => "searching",
                    "get-bookmark" | "get-bookmark-content" => "reading",
                    "select_bookmark_results" => "selecting",
                    _ => "warning",
                };
                emit_knowledge(
                    json!({"stage":stage,"toolCallId":call.id,"summary":retrieval.summary}),
                )?;
                let result = match serde_json::from_str::<Value>(&call.arguments) {
                    Err(_) => Err("工具参数 JSON 无效，请修复完整参数".into()),
                    Ok(_) if retrieval.selected.is_some() => {
                        Err("来源已校验，直接总结，不再执行检索工具".into())
                    }
                    Ok(args) => match call.name.as_str() {
                        "search-bookmarks" => retrieval.search(args, &signal).await,
                        "get-bookmark" => retrieval.get_details(args, signal.clone()).await,
                        "get-bookmark-content" => retrieval.read(args, signal.clone()).await,
                        "select_bookmark_results" => retrieval.select(args),
                        _ => Err("禁止调用非只读收藏工具".into()),
                    },
                };
                if signal.is_cancelled() {
                    return Err("Request cancelled".into());
                }
                let output = match result {
                    Ok(value) => {
                        emit_knowledge(
                            json!({"stage":if stage=="searching" {"searched"} else if stage=="selecting" {"ready"} else {stage},"summary":retrieval.summary,"sources":retrieval.selected}),
                        )?;
                        value
                    }
                    Err(error) => {
                        retrieval.warning(error.clone());
                        emit_knowledge(
                            json!({"stage":"warning","message":error,"summary":retrieval.summary}),
                        )?;
                        if call.name == "select_bookmark_results"
                            && !error.starts_with("KARAKEEP_SEARCH_PLAN")
                        {
                            repairs += 1;
                            if repairs > 2 {
                                return Err(format!(
                                    "KARAKEEP_SELECTION: 来源校验修复超过上限：{error}"
                                ));
                            }
                        }
                        json!({"error":error,"instruction":"失败不代表没有相关书签，不能编造来源。修正参数或明确报告问题。"})
                    }
                };
                results.push(ToolResult {
                    call_id: call.id.clone(),
                    output,
                });
            }
            stalled_rounds = if retrieval.progress_marker() == progress {
                stalled_rounds + 1
            } else {
                0
            };
            // A provider ignoring the advertised tool/schema must not consume
            // dozens of requests. Give it two corrective rounds with real IDs,
            // then return the concrete error rather than a misleading budget error.
            if stalled_rounds >= 4 && retrieval.selected.is_none() {
                return Err(format!(
                    "KARAKEEP_TOOLS: 连续工具调用未推进检索。{}",
                    retrieval
                        .summary
                        .warnings
                        .last()
                        .map(String::as_str)
                        .unwrap_or("模型反复调用已返回的数据，请检查工具调用响应")
                ));
            }
            append_round(&mut body, protocol, &round, results);
            body.as_object_mut()
                .ok_or("模型请求无效")?
                .remove("tool_choice");
            if retrieval.selected.is_some() {
                final_phase = true;
                if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
                    tools.retain(|t| t["type"] == "web_search");
                }
                if body["tools"].as_array().is_some_and(Vec::is_empty) {
                    body.as_object_mut().ok_or("模型请求无效")?.remove("tools");
                }
                emit_knowledge(
                    json!({"stage":"ready","sources":retrieval.selected,"summary":retrieval.summary}),
                )?;
            }
        }
        Err("KARAKEEP_BUDGET: 超出任务预算".into())
    };
    tokio::select! {
        result=tokio::time::timeout(std::time::Duration::from_secs(TASK_TIMEOUT_SECONDS),task)=>result.map_err(|_|"KARAKEEP_TIMEOUT: 整个检索任务超过 180 秒".to_string())?,
        _=signal.cancelled()=>Err("Request cancelled".into()),
    }
}

fn prepare_agent_tools(
    body: &mut Value,
    protocol: crate::domain::providers::ApiProtocol,
    retrieval: &RetrievalRun,
    forced: bool,
    initial_tool: Option<&str>,
    closing: bool,
) -> Result<(), String> {
    let searching = retrieval.search_plan_pending();
    let selecting = !searching
        && retrieval.was_used()
        && retrieval.has_selection_data()
        && (closing
            || (retrieval.remaining_searches() == 0
                && retrieval.remaining_details() == 0
                && retrieval.remaining_reads() == 0));
    let detail_ids = retrieval.available_detail_ids();
    let read_ids = retrieval.available_read_ids();
    let force_details = !searching
        && !selecting
        && closing
        && retrieval.remaining_details() > 0
        && !detail_ids.is_empty();
    let functions: Vec<_> = definitions()
        .into_iter()
        .filter(|def| {
            if searching {
                return def.name == "search-bookmarks";
            }
            if selecting {
                return def.name == "select_bookmark_results";
            }
            if force_details {
                return def.name == "get-bookmark";
            }
            match def.name.as_str() {
                "search-bookmarks" => retrieval.remaining_searches() > 0,
                "get-bookmark" => retrieval.remaining_details() > 0 && !detail_ids.is_empty(),
                "get-bookmark-content" => retrieval.remaining_reads() > 0 && !read_ids.is_empty(),
                "select_bookmark_results" => retrieval.has_selection_data(),
                _ => false,
            }
        })
        .map(|mut def| {
            match def.name.as_str() {
                "search-bookmarks" => {
                    def.parameters["properties"]["searchMode"]["default"] = json!(retrieval.default_search_mode());
                    def.description.push_str(&format!("\nCURRENT SEARCH PROGRESS (follow nextAction): {}", retrieval.search_progress()));
                }
                "get-bookmark" | "get-bookmark-content" => {
                    let ids = if def.name == "get-bookmark" { &detail_ids } else { &read_ids };
                    let remaining = if def.name == "get-bookmark" { retrieval.remaining_details() } else { retrieval.remaining_reads() };
                    def.parameters["properties"]["bookmarkId"]["enum"] = json!(ids);
                    def.parameters["properties"]["bookmarkIds"]["items"]["enum"] = json!(ids);
                    def.parameters["properties"]["bookmarkIds"]["maxItems"] = json!(remaining);
                    def.description.push_str(&format!("\nOnly these IDs remain available: {}. Remaining distinct reads: {remaining}.", json!(ids)));
                }
                "select_bookmark_results" => def.description.push_str(&format!("\nEligible sources and REAL passageIds: {}. For verification=content choose at least one listed passageId; metadata needs an empty passageIds array. Empty results are allowed if nothing matches.", retrieval.selection_context())),
                _ => {}
            }
            def
        })
        .collect();
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| tool["type"] != "function");
    }
    configure_tools(body, protocol, &functions);
    let force = if searching && (forced || retrieval.was_used()) {
        Some("search-bookmarks")
    } else if selecting {
        Some("select_bookmark_results")
    } else if force_details {
        Some("get-bookmark")
    } else {
        initial_tool
    };
    body.as_object_mut()
        .ok_or("模型请求无效")?
        .remove("tool_choice");
    if let Some(name) = force {
        if !functions.iter().any(|def| def.name == name) {
            return Err(
                "KARAKEEP_SOURCE: 当前没有可读取的候选或当前实例的历史书签，请重新搜索收藏".into(),
            );
        }
        body["tool_choice"] = match protocol {
            crate::domain::providers::ApiProtocol::ChatCompletions => {
                json!({"type":"function","function":{"name":name}})
            }
            crate::domain::providers::ApiProtocol::Responses => {
                json!({"type":"function","name":name})
            }
        };
    }
    if selecting {
        let key = if protocol == crate::domain::providers::ApiProtocol::Responses {
            "input"
        } else {
            "messages"
        };
        body[key].as_array_mut().ok_or("模型会话无效")?.push(json!({"role":"user","content":"请现在根据已获取的真实详情和正文调用 select_bookmark_results，按相关性选材。未验证正文的来源必须明确标记。选材后直接总结，不再重复查询或读取。"}));
    }
    Ok(())
}
