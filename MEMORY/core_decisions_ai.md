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

- id: D-006
  date: 2026-05-16
  decision: tool_use_streaming_uses_same_sse_format_as_text_only_additional_event_types
  rationale: one_protocol_for_all_patterns_client_renderer_unions_over_event_types_dispatches_in_one_place
  alternatives_rejected: [separate_json_endpoint_for_tool_use, websocket_for_tool_use_only_inconsistent_with_text_pattern]
  reversibility: cheap
  related_issues: [#2]
  superseded_by: null

- id: D-007
  date: 2026-05-16
  decision: interrupt_uses_abort_controller_end_to_end_client_fetch_to_route_handler_to_stream_source
  rationale: standard_browser_primitive_propagates_naturally_through_next_request_signal_no_custom_cancellation_token_required
  alternatives_rejected: [server_side_cancellation_token, websocket_close, separate_endpoint_to_signal_interrupt]
  reversibility: cheap
  related_issues: [#2]
  superseded_by: null

- id: D-008
  date: 2026-05-17
  decision: partial_json_parser_is_dep_free_in_repo_implementation_not_a_vendored_npm_package
  rationale: repo_is_a_reference_for_patterns_a_vendored_library_hides_the_technique_an_in_repo_120_line_state_machine_shows_it_transparently_and_keeps_runtime_dep_count_at_zero
  alternatives_rejected: [vendor_partial_json_npm_package_hides_pattern_adds_runtime_dep, vendor_json_parse_stream_same_issues, ad_hoc_regex_repair_fragile_at_edge_cases_no_committedAny_concept]
  reversibility: cheap
  related_issues: [#3]
  superseded_by: null

- id: D-010
  date: 2026-05-18
  decision: optimistic_rollback_demo_uses_deterministic_decision_oracle_keyed_by_id_plus_click_count_not_random_rng
  rationale: rollback_path_is_load_bearing_ux_for_this_pattern_needs_to_fire_reproducibly_for_visitors_and_be_pinnable_by_tests_first_click_bias_keeps_happy_path_visible_first_subsequent_clicks_split_5050_via_fnv1a_low_bit
  alternatives_rejected: [math_random_at_route_handler_flaky_in_ci_no_repro, seeded_rng_with_static_seed_every_click_same_outcome_defeats_demo, seeded_rng_keyed_only_by_id_same_item_always_succeeds_or_always_fails]
  reversibility: cheap
  related_issues: [4]
  superseded_by: null
