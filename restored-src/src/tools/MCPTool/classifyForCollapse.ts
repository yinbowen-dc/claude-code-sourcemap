/**
 * classifyForCollapse.ts — MCP 工具 UI 折叠分类器
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 MCPTool 提供 UI 折叠判断逻辑。
 * 在 Claude Code 的消息列表中，搜索类和只读查询类操作默认折叠显示，
 * 以减少 UI 噪音。本文件通过维护两个显式白名单集合，
 * 判断某个 MCP 工具是否应被分类为可折叠的搜索操作或只读操作。
 *
 * 【主要功能】
 * 1. SEARCH_TOOLS：搜索类工具名称白名单（Set<string>）
 *    - 覆盖主流 MCP 服务器的搜索操作：Slack、GitHub、Linear、Datadog、
 *      Sentry、Notion、Gmail、Google Drive、Google Calendar、Jira/Confluence、
 *      Asana、Filesystem、Memory、Brave Search、Grafana、Supabase、Stripe、
 *      PubMed、Firecrawl、Exa、Perplexity、Tavily、Obsidian、MongoDB、Neo4j、
 *      Airtable、Todoist、AWS、Terraform 等
 * 2. READ_TOOLS：只读查询类工具名称白名单（Set<string>）
 *    - 覆盖主流 MCP 服务器的 get_/list_/read_ 类操作
 * 3. normalize()：将工具名称标准化为 snake_case 小写
 *    - camelCase → snake_case（goToDefinition → go_to_definition）
 *    - kebab-case → snake_case（get-file → get_file）
 * 4. classifyMcpToolForCollapse()：
 *    - 标准化工具名称后查白名单
 *    - 返回 { isSearch, isRead } 对象
 *    - 未知工具名称保守处理（不折叠）
 *
 * 【设计决策】
 * - 白名单匹配基于工具名称（toolName），不依赖服务器名称（serverName 被忽略）
 *   原因：同一工具在不同安装中服务器名称可能不同（如 "slack" vs "claude_ai_Slack"），
 *   但工具名称在各安装中保持稳定
 * - 保守策略：未知工具名称不折叠，避免重要操作被误隐藏
 */

/**
 * 搜索类 MCP 工具名称白名单（标准化为 snake_case 后的名称）。
 *
 * 包含各主流 MCP 服务器的搜索操作工具名称，
 * 这些工具在 UI 中默认折叠为搜索结果摘要。
 */
// prettier-ignore
const SEARCH_TOOLS = new Set([
  // Slack (hosted + @modelcontextprotocol/server-slack)
  'slack_search_public',
  'slack_search_public_and_private',
  'slack_search_channels',
  'slack_search_users',
  // GitHub (github/github-mcp-server)
  'search_code',
  'search_repositories',
  'search_issues',
  'search_pull_requests',
  'search_orgs',
  'search_users',
  // Linear (mcp.linear.app)
  'search_documentation',
  // Datadog (mcp.datadoghq.com)
  'search_logs',
  'search_spans',
  'search_rum_events',
  'search_audit_logs',
  'search_monitors',
  'search_monitor_groups',
  'find_slow_spans',
  'find_monitors_matching_pattern',
  // Sentry (getsentry/sentry-mcp)
  'search_docs',
  'search_events',
  'search_issue_events',
  'find_organizations',
  'find_teams',
  'find_projects',
  'find_releases',
  'find_dsns',
  // Notion (mcp.notion.com — kebab-case, normalized)
  'search',
  // Gmail (claude.ai hosted)
  'gmail_search_messages',
  // Google Drive (claude.ai hosted + @modelcontextprotocol/server-gdrive)
  'google_drive_search',
  // Google Calendar (claude.ai hosted)
  'gcal_find_my_free_time',
  'gcal_find_meeting_times',
  'gcal_find_user_emails',
  // Atlassian/Jira (mcp.atlassian.com — camelCase, normalized)
  'search_jira_issues_using_jql',
  'search_confluence_using_cql',
  'lookup_jira_account_id',
  // Community Atlassian (sooperset/mcp-atlassian)
  'confluence_search',
  'jira_search',
  'jira_search_fields',
  // Asana (mcp.asana.com)
  'asana_search_tasks',
  'asana_typeahead_search',
  // Filesystem (@modelcontextprotocol/server-filesystem)
  'search_files',
  // Memory (@modelcontextprotocol/server-memory)
  'search_nodes',
  // Brave Search
  'brave_web_search',
  'brave_local_search',
  // Git (mcp-server-git)
  // (git 没有搜索类操作)
  // Grafana (grafana/mcp-grafana)
  'search_dashboards',
  'search_folders',
  // PagerDuty
  // (pagerduty 的只读操作均使用 get_/list_，无搜索类操作)
  // Supabase
  'search_docs',
  // Stripe
  'search_stripe_resources',
  'search_stripe_documentation',
  // PubMed (claude.ai hosted + community)
  'search_articles',
  'find_related_articles',
  'lookup_article_by_citation',
  'search_papers',
  'search_pubmed',
  'search_pubmed_key_words',
  'search_pubmed_advanced',
  'pubmed_search',
  'pubmed_mesh_lookup',
  // Firecrawl
  'firecrawl_search',
  // Exa
  'web_search_exa',
  'web_search_advanced_exa',
  'people_search_exa',
  'linkedin_search_exa',
  'deep_search_exa',
  // Perplexity
  'perplexity_search',
  'perplexity_search_web',
  // Tavily
  'tavily_search',
  // Obsidian (MarkusPfundstein)
  'obsidian_simple_search',
  'obsidian_complex_search',
  // MongoDB
  'find',
  'search_knowledge',
  // Neo4j
  'search_memories',
  'find_memories_by_name',
  // Airtable
  'search_records',
  // Todoist (Doist — kebab-case, normalized)
  'find_tasks',
  'find_tasks_by_date',
  'find_completed_tasks',
  'find_projects',
  'find_sections',
  'find_comments',
  'find_project_collaborators',
  'find_activity',
  'find_labels',
  'find_filters',
  // AWS
  'search_documentation',
  'search_catalog',
  // Terraform
  'search_modules',
  'search_providers',
  'search_policies',
])

/**
 * 只读查询类 MCP 工具名称白名单（标准化为 snake_case 后的名称）。
 *
 * 包含各主流 MCP 服务器的 get_/list_/read_ 等只读操作工具名称，
 * 这些工具在 UI 中默认折叠为只读查询摘要。
 */
// prettier-ignore
const READ_TOOLS = new Set([
  // Slack (hosted + @modelcontextprotocol/server-slack)
  'slack_read_channel',
  'slack_read_thread',
  'slack_read_canvas',
  'slack_read_user_profile',
  'slack_list_channels',
  'slack_get_channel_history',
  'slack_get_thread_replies',
  'slack_get_users',
  'slack_get_user_profile',
  // GitHub (github/github-mcp-server)
  'get_me',
  'get_team_members',
  'get_teams',
  'get_commit',
  'get_file_contents',
  'get_repository_tree',
  'list_branches',
  'list_commits',
  'list_releases',
  'list_tags',
  'get_latest_release',
  'get_release_by_tag',
  'get_tag',
  'list_issues',
  'issue_read',
  'list_issue_types',
  'get_label',
  'list_label',
  'pull_request_read',
  'get_gist',
  'list_gists',
  'list_notifications',
  'get_notification_details',
  'projects_list',
  'projects_get',
  'actions_get',
  'actions_list',
  'get_job_logs',
  'get_code_scanning_alert',
  'list_code_scanning_alerts',
  'get_dependabot_alert',
  'list_dependabot_alerts',
  'get_secret_scanning_alert',
  'list_secret_scanning_alerts',
  'get_global_security_advisory',
  'list_global_security_advisories',
  'list_org_repository_security_advisories',
  'list_repository_security_advisories',
  'get_discussion',
  'get_discussion_comments',
  'list_discussion_categories',
  'list_discussions',
  'list_starred_repositories',
  'get_issue',
  'get_pull_request',
  'list_pull_requests',
  'get_pull_request_files',
  'get_pull_request_status',
  'get_pull_request_comments',
  'get_pull_request_reviews',
  // Linear (mcp.linear.app)
  'list_comments',
  'list_cycles',
  'get_document',
  'list_documents',
  'list_issue_statuses',
  'get_issue_status',
  'list_my_issues',
  'list_issue_labels',
  'list_projects',
  'get_project',
  'list_project_labels',
  'list_teams',
  'get_team',
  'list_users',
  'get_user',
  // Datadog (mcp.datadoghq.com)
  'aggregate_logs',
  'list_spans',
  'aggregate_spans',
  'analyze_trace',
  'trace_critical_path',
  'query_metrics',
  'aggregate_rum_events',
  'list_rum_metrics',
  'get_rum_metric',
  'list_monitors',
  'get_monitor',
  'check_can_delete_monitor',
  'validate_monitor',
  'validate_existing_monitor',
  'list_dashboards',
  'get_dashboard',
  'query_dashboard_widget',
  'list_notebooks',
  'get_notebook',
  'query_notebook_cell',
  'get_profiling_metrics',
  'compare_profiling_metrics',
  // Sentry (getsentry/sentry-mcp)
  'whoami',
  'get_issue_details',
  'get_issue_tag_values',
  'get_trace_details',
  'get_event_attachment',
  'get_doc',
  'get_sentry_resource',
  'list_events',
  'list_issue_events',
  'get_sentry_issue',
  // Notion (mcp.notion.com — kebab-case, normalized)
  'fetch',
  'get_comments',
  'get_users',
  'get_self',
  // Gmail (claude.ai hosted)
  'gmail_get_profile',
  'gmail_read_message',
  'gmail_read_thread',
  'gmail_list_drafts',
  'gmail_list_labels',
  // Google Drive (claude.ai hosted + @modelcontextprotocol/server-gdrive)
  'google_drive_fetch',
  'google_drive_export',
  // Google Calendar (claude.ai hosted)
  'gcal_list_calendars',
  'gcal_list_events',
  'gcal_get_event',
  // Atlassian/Jira (mcp.atlassian.com — camelCase, normalized)
  'atlassian_user_info',
  'get_accessible_atlassian_resources',
  'get_visible_jira_projects',
  'get_jira_project_issue_types_metadata',
  'get_jira_issue',
  'get_transitions_for_jira_issue',
  'get_jira_issue_remote_issue_links',
  'get_confluence_spaces',
  'get_confluence_page',
  'get_pages_in_confluence_space',
  'get_confluence_page_ancestors',
  'get_confluence_page_descendants',
  'get_confluence_page_footer_comments',
  'get_confluence_page_inline_comments',
  // Community Atlassian (sooperset/mcp-atlassian)
  'confluence_get_page',
  'confluence_get_page_children',
  'confluence_get_comments',
  'confluence_get_labels',
  'jira_get_issue',
  'jira_get_transitions',
  'jira_get_worklog',
  'jira_get_agile_boards',
  'jira_get_board_issues',
  'jira_get_sprints_from_board',
  'jira_get_sprint_issues',
  'jira_get_link_types',
  'jira_download_attachments',
  'jira_batch_get_changelogs',
  'jira_get_user_profile',
  'jira_get_project_issues',
  'jira_get_project_versions',
  // Asana (mcp.asana.com)
  'asana_get_attachment',
  'asana_get_attachments_for_object',
  'asana_get_goal',
  'asana_get_goals',
  'asana_get_parent_goals_for_goal',
  'asana_get_portfolio',
  'asana_get_portfolios',
  'asana_get_items_for_portfolio',
  'asana_get_project',
  'asana_get_projects',
  'asana_get_project_sections',
  'asana_get_project_status',
  'asana_get_project_statuses',
  'asana_get_project_task_counts',
  'asana_get_projects_for_team',
  'asana_get_projects_for_workspace',
  'asana_get_task',
  'asana_get_tasks',
  'asana_get_stories_for_task',
  'asana_get_teams_for_workspace',
  'asana_get_teams_for_user',
  'asana_get_team_users',
  'asana_get_time_period',
  'asana_get_time_periods',
  'asana_get_user',
  'asana_get_workspace_users',
  'asana_list_workspaces',
  // Filesystem (@modelcontextprotocol/server-filesystem)
  'read_file',
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'get_file_info',
  'list_allowed_directories',
  // Memory (@modelcontextprotocol/server-memory)
  'read_graph',
  'open_nodes',
  // Postgres (@modelcontextprotocol/server-postgres)
  'query',
  // SQLite (@modelcontextprotocol/server-sqlite)
  'read_query',
  'list_tables',
  'describe_table',
  // Git (mcp-server-git)
  'git_status',
  'git_diff',
  'git_diff_unstaged',
  'git_diff_staged',
  'git_log',
  'git_show',
  'git_branch',
  // Grafana (grafana/mcp-grafana)
  'list_teams',
  'list_users_by_org',
  'get_dashboard_by_uid',
  'get_dashboard_summary',
  'get_dashboard_property',
  'get_dashboard_panel_queries',
  'run_panel_query',
  'list_datasources',
  'get_datasource',
  'get_query_examples',
  'query_prometheus',
  'query_prometheus_histogram',
  'list_prometheus_metric_metadata',
  'list_prometheus_metric_names',
  'list_prometheus_label_names',
  'list_prometheus_label_values',
  'query_loki_logs',
  'query_loki_stats',
  'query_loki_patterns',
  'list_loki_label_names',
  'list_loki_label_values',
  'list_incidents',
  'get_incident',
  'list_sift_investigations',
  'get_sift_investigation',
  'get_sift_analysis',
  'list_oncall_schedules',
  'get_oncall_shift',
  'get_current_oncall_users',
  'list_oncall_teams',
  'list_oncall_users',
  'list_alert_groups',
  'get_alert_group',
  'get_annotations',
  'get_annotation_tags',
  'get_panel_image',
  // PagerDuty (PagerDuty/pagerduty-mcp-server)
  'list_incidents',
  'get_incident',
  'get_outlier_incident',
  'get_past_incidents',
  'get_related_incidents',
  'list_incident_notes',
  'list_incident_workflows',
  'get_incident_workflow',
  'list_services',
  'get_service',
  'list_team_members',
  'get_user_data',
  'list_schedules',
  'get_schedule',
  'list_schedule_users',
  'list_oncalls',
  'list_log_entries',
  'get_log_entry',
  'list_escalation_policies',
  'get_escalation_policy',
  'list_event_orchestrations',
  'get_event_orchestration',
  'list_status_pages',
  'get_status_page_post',
  'list_alerts_from_incident',
  'get_alert_from_incident',
  'list_change_events',
  'get_change_event',
  // Supabase (supabase-community/supabase-mcp)
  'list_organizations',
  'get_organization',
  'get_cost',
  'list_extensions',
  'list_migrations',
  'get_logs',
  'get_advisors',
  'get_project_url',
  'get_publishable_keys',
  'generate_typescript_types',
  'list_edge_functions',
  'get_edge_function',
  'list_storage_buckets',
  'get_storage_config',
  // Stripe (stripe/agent-toolkit)
  'get_stripe_account_info',
  'retrieve_balance',
  'list_customers',
  'list_products',
  'list_prices',
  'list_invoices',
  'list_payment_intents',
  'list_subscriptions',
  'list_coupons',
  'list_disputes',
  'fetch_stripe_resources',
  // PubMed (claude.ai hosted + community)
  'get_article_metadata',
  'get_full_text_article',
  'convert_article_ids',
  'get_copyright_status',
  'download_paper',
  'list_papers',
  'read_paper',
  'get_paper_fulltext',
  'get_pubmed_article_metadata',
  'download_pubmed_pdf',
  'pubmed_fetch',
  'pubmed_pmc_fetch',
  'pubmed_spell',
  'pubmed_cite',
  'pubmed_related',
  // BigQuery (claude.ai hosted + community)
  'bigquery_query',
  'bigquery_schema',
  'list_dataset_ids',
  'list_table_ids',
  'get_dataset_info',
  'get_table_info',
  // Firecrawl
  'firecrawl_scrape',
  'firecrawl_map',
  'firecrawl_crawl',
  'firecrawl_check_crawl_status',
  'firecrawl_extract',
  // Exa
  'get_code_context_exa',
  'company_research_exa',
  'crawling_exa',
  'deep_researcher_check',
  // Perplexity
  'perplexity_ask',
  'perplexity_research',
  'perplexity_reason',
  // Tavily
  'tavily_extract',
  'tavily_crawl',
  'tavily_map',
  'tavily_research',
  // Obsidian (MarkusPfundstein)
  'obsidian_list_files_in_vault',
  'obsidian_list_files_in_dir',
  'obsidian_get_file_contents',
  'obsidian_batch_get_file_contents',
  'obsidian_get_periodic_note',
  'obsidian_get_recent_periodic_notes',
  'obsidian_get_recent_changes',
  // Figma (GLips/Figma-Context-MCP)
  'get_figma_data',
  'download_figma_images',
  // Playwright (microsoft/playwright-mcp)
  'browser_console_messages',
  'browser_network_requests',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_get_config',
  'browser_route_list',
  'browser_cookie_list',
  'browser_cookie_get',
  'browser_localstorage_list',
  'browser_localstorage_get',
  'browser_sessionstorage_list',
  'browser_sessionstorage_get',
  'browser_storage_state',
  // Puppeteer (@modelcontextprotocol/server-puppeteer)
  'puppeteer_screenshot',
  // MongoDB
  'list_databases',
  'list_collections',
  'collection_indexes',
  'collection_schema',
  'collection_storage_size',
  'db_stats',
  'explain',
  'mongodb_logs',
  'aggregate',
  'count',
  'export',
  // Neo4j
  'get_neo4j_schema',
  'read_neo4j_cypher',
  'list_instances',
  'get_instance_details',
  'get_instance_by_name',
  // Elasticsearch (elastic)
  'list_indices',
  'get_mappings',
  'esql',
  'get_shards',
  // Airtable
  'list_records',
  'list_bases',
  'get_record',
  // Todoist (Doist — kebab-case, normalized)
  'get_productivity_stats',
  'get_overview',
  'fetch_object',
  'user_info',
  'list_workspaces',
  'view_attachment',
  // AWS (awslabs/mcp)
  'get_available_services',
  'read_documentation',
  'read_sections',
  'recommend',
  'analyze_log_group',
  'analyze_metric',
  'describe_log_groups',
  'get_active_alarms',
  'get_alarm_history',
  'get_metric_data',
  'get_metric_metadata',
  // Kubernetes
  'kubectl_get',
  'kubectl_describe',
  'kubectl_logs',
  'kubectl_context',
  'explain_resource',
  'list_api_resources',
  'namespaces_list',
  'nodes_log',
  'nodes_top',
  'pods_get',
  'pods_list',
  'pods_list_in_namespace',
  'pods_log',
  'pods_top',
  'resources_get',
  'resources_list',
])

/**
 * 将工具名称标准化为 snake_case 小写格式。
 *
 * 处理两种非标准命名格式：
 * 1. camelCase → snake_case：在小写字母和大写字母之间插入下划线
 *    示例：'goToDefinition' → 'go_to_definition'
 * 2. kebab-case → snake_case：将连字符替换为下划线
 *    示例：'get-file-contents' → 'get_file_contents'
 * 3. 最后转为全小写
 *
 * @param name - 原始工具名称
 * @returns 标准化后的 snake_case 小写名称
 */
function normalize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase → snake_case
    .replace(/-/g, '_')                      // kebab-case → snake_case
    .toLowerCase()
}

/**
 * 将 MCP 工具分类为搜索操作或只读操作（用于 UI 折叠判断）。
 *
 * 通过以下步骤判断：
 * 1. normalize(toolName) 将工具名称标准化为 snake_case
 * 2. 查询 SEARCH_TOOLS 白名单 → isSearch
 * 3. 查询 READ_TOOLS 白名单 → isRead
 *
 * 保守策略：未知工具名称返回 { isSearch: false, isRead: false }（不折叠）。
 * 服务器名称参数（_serverName）当前被忽略，白名单匹配仅基于工具名称。
 *
 * @param _serverName - MCP 服务器名称（当前未使用，保留供未来扩展）
 * @param toolName - MCP 工具名称
 * @returns { isSearch, isRead } 折叠分类结果
 */
export function classifyMcpToolForCollapse(
  _serverName: string,
  toolName: string,
): { isSearch: boolean; isRead: boolean } {
  const normalized = normalize(toolName)
  return {
    isSearch: SEARCH_TOOLS.has(normalized),
    isRead: READ_TOOLS.has(normalized),
  }
}
