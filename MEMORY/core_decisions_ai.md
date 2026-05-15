# Core Decisions (AI-readable, YAML, append-only)
# Schema: see .skills/portfolio-memory/SKILL.md

- id: D-001
  date: 2026-05-10
  decision: scope_per_portfolio_handoff_section_2
  rationale: locked_scope_prevents_drift
  alternatives_rejected: []
  reversibility: expensive
  related_issues: []
  superseded_by: null

- id: D-002
  date: 2026-05-15
  decision: one_nextjs_app_at_repo_root_one_page_per_pattern
  rationale: patterns_repo_not_monorepo_each_page_self_contained_in_app_subdir
  alternatives_rejected: [per_pattern_subpackages, separate_apps_per_pattern, examples_in_storybook]
  reversibility: cheap
  related_issues: [#1, #2]
  superseded_by: null

- id: D-003
  date: 2026-05-15
  decision: every_demo_runs_with_no_anthropic_api_key_committed_mock_fallback_required
  rationale: repo_must_be_demoable_on_fresh_clone_no_account_setup
  alternatives_rejected: [require_key_for_demos, recorded_responses_only]
  reversibility: cheap
  related_issues: [#1]
  superseded_by: null

- id: D-004
  date: 2026-05-15
  decision: source_displayed_alongside_demo_is_read_from_disk_at_request_time_not_copy_pasted
  rationale: prevents_displayed_source_drifting_from_actual_source
  alternatives_rejected: [code_blocks_in_jsx, mdx_with_inline_code, build_step_extracting_snippets]
  reversibility: cheap
  related_issues: [#1]
  superseded_by: null

- id: D-005
  date: 2026-05-15
  decision: streaming_pattern_uses_route_handler_sse_plus_client_reader_not_pure_rsc
  rationale: react_19_does_not_provide_zero_js_per_token_browser_streaming_from_server_components
  alternatives_rejected: [pure_rsc_with_suspense_boundaries, ai_sdk_streamable_value, websockets]
  reversibility: cheap
  related_issues: [#1, #2]
  superseded_by: null
