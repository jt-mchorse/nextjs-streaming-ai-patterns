# Session History (AI-readable, append-only)

Schema: see .skills/portfolio-memory/SKILL.md

---
session: 2026-05-15T10:55Z
duration_min: 75
issue: 1
focus: streaming_text_pattern_via_sse_route_handler_plus_client_reader
delta:
  files_added: 17
  files_changed: 3
  tests_added: 7
  test_pass_rate: "7/7"
  build_pass: true
  dev_server_curl_verified: true
context_for_next_session:
  - streaming_text_pattern_shipped_app_streaming_text_route_api_stream_text_sse
  - mock_fallback_works_when_no_anthropic_api_key_d_003
  - source_pane_reads_disk_at_request_time_d_004
  - app_skeleton_locked_one_page_per_pattern_d_002
  - rsc_streaming_rejected_d_005_route_handler_pattern_for_all_future_streams
  - tool_use_ui_2_extends_same_sse_format_with_event_tool_use_frames
decisions_made: [D-002, D-003, D-004, D-005]
followups: []
---


---
session: 2026-05-16T05:03Z
duration_min: 45
issue: 2
focus: tool_use_ui_with_interrupt_and_state_machine
delta:
  files_added: 5
  files_changed: 2
  tests_added: 6
  test_pass_rate: "13/13"
  build_pass: true
context_for_next_session:
  - tool_use_pattern_lives_at_app_tool_use_route_api_tool_use
  - mock_tool_stream_emits_text_delta_tool_use_start_tool_use_delta_tool_use_stop_tool_result_message_stop_d_006
  - interrupt_is_abort_controller_end_to_end_d_007_clean_message_stop_interrupted_terminator
  - state_machine_documented_in_docs_tool_use_state_machine_md_9_states_with_transitions
  - tool_card_renders_streaming_args_with_cursor_until_args_complete_then_pretty_prints_parsed_json
  - homepage_pattern_list_now_shows_tool_use_as_shipped
  - issue_2_acceptance_tool_call_timeline_component_done_interrupt_button_works_mid_stream_done_state_machine_documented_done
decisions_made: [D-006, D-007]
followups: []
---

---
session: 2026-05-17T19:25Z
duration_min: 60
issue: 3
focus: partial_json_parser_plus_progressive_rendering_demo
delta:
  files_added: 5  # lib/partial-json.ts, lib/mock-json-stream.ts, app/api/partial-json/route.ts, components/partial-json-client.tsx, app/partial-json/page.tsx + 2 test files
  files_changed: 1  # app/page.tsx homepage card
  tests_added: 23  # 20 partial-json + 3 mock-json-stream
  test_pass_rate: "36/36"
  build_pass: true
  lint_pass: true
context_for_next_session:
  - partial_json_parser_in_lib_partial_json_ts_dep_free_d_008_state_machine_per_frame_object_or_array_with_committed_any_flag
  - parser_handles_open_strings_open_arrays_open_objects_trailing_commas_mid_token_primitives_never_throws
  - mock_json_stream_in_lib_mock_json_stream_ts_emits_chunked_trip_itinerary_payload_uses_d_006_sse_envelope
  - chunks_are_8_15_chars_so_real_failure_modes_are_exercised_mid_key_mid_value_mid_array
  - route_handler_app_api_partial_json_route_ts_propagates_abort_signal_d_007
  - client_component_components_partial_json_client_tsx_accumulates_json_delta_buffer_parses_on_each_chunk_renders_skeletons_for_unfilled_fields
  - homepage_card_partial_json_now_status_shipped_issue_3
  - issue_3_acceptance_partial_parser_done_form_fields_populate_progressively_done_malformed_json_tolerated_with_never_throws_test
decisions_made: [D-008]
followups: []
---

---
session: 2026-05-18T04:00Z
duration_min: 35
issue: 4
focus: optimistic_rollback_pattern_fifth_page_react_19_use_optimistic
delta:
  files_changed: 8
  tests_added: 17
context_for_next_session:
  - fifth_pattern_optimistic_rollback_ships_d_010
  - deterministic_decision_oracle_pinned_50_50_over_995_inputs_in_property_test
  - rollback_animation_pure_css_keyframes_rollback_flash_900ms_shake_plus_border_flash
  - home_page_pattern_4_pending_to_shipped
  - pr_body_explicitly_flags_browser_verification_as_not_done_in_this_pr
decisions_made: [D-010]
followups: []
---

---
session: 2026-05-18T04:20Z
duration_min: 35
issue: 5
focus: error_recovery_mid_stream_sixth_pattern_page
delta:
  files_changed: 7
  tests_added: 13
context_for_next_session:
  - sixth_pattern_error_recovery_ships_d_011
  - checkpoint_protocol_integer_token_position_not_opaque_cursor
  - drop_deterministic_first_request_after_12_tokens_resume_always_completes
  - client_accumulates_text_without_reset_on_drop_resumed_pill_renders_2s
  - pr_stacked_on_pr_9_optimistic_rollback
  - all_5_pattern_pages_now_shipped_streaming_text_tool_use_partial_json_optimistic_rollback_error_recovery
decisions_made: [D-011]
followups: []
---

---
session: 2026-05-18T23:11Z
duration_min: 35
issue: 11
focus: readme_truth_pass_all_five_patterns_shipped_plus_snapshot_test
delta:
  files_changed: 1   # README.md
  files_added: 1     # test/readme-patterns-table.test.ts
  tests_added: 3
  test_pass_rate: "69/69"
  typecheck_pass: true
  lint_pass: true
  build_pass: true
context_for_next_session:
  - readme_now_reflects_actual_state_all_five_patterns_shipped_rows_2_5_flipped_pending_to_shipped_with_issue_refs
  - what_this_is_section_describes_full_set_with_one_bullet_per_pattern_plus_sse_envelope_d005_d006_and_abort_d007_threading
  - demo_section_no_longer_claims_capture_exists_pending_60s_gif_video_now_tracked_in_followup_12
  - new_snapshot_test_test_readme_patterns_table_test_ts_3_tests_parses_readme_and_app_page_tsx_patterns_array_asserts_match_row_for_row_plus_pages_exist_on_disk
  - parallels_today_snapshot_pattern_landed_in_cost_optimizer_prompt_regression_rag_kit_phase_a_merges
  - homepage_app_page_tsx_was_already_correct_only_readme_was_stale
  - failure_path_verified_by_tampering_streaming_text_status_pending_test_fired_then_reverted
decisions_made: []
followups: [#12]
---

---
session: 2026-05-20T03:47Z
duration_min: 25
issue: 14
focus: ts_public_surface_pattern_second_typescript_variant_adapted_for_nextjs_app_shape
delta:
  files_added: 1   # test/public-surface.test.ts (vitest)
  files_changed: 0
  tests_added: 12   # 2 standalone + 8 lib modules + 2 README paths after it.each
  test_pass_rate: "81/81"
  typecheck_pass: true
  lint_pass: true
context_for_next_session:
  - second_ts_variant_after_agent_orchestration_platform_pr_19_template
  - nextjs_app_shape_means_no_src_index_ts_aggregator_no_package_json_bin_axes_adapted
  - three_axes_pkg_version_semver_lib_modules_dynamic_import_with_defined_exports_readme_mermaid_quoted_paths_exist
  - lib_modules_listed_at_test_time_via_readdirsync_so_new_modules_auto_included
  - tamper_verified_three_axes_bad_version_rename_mock_stream_empty_shiki
  - portable_to_last_ts_only_repo_ai_app_integration_tests_likely_similar_shape
decisions_made: []
followups: []
---

---
session: 2026-05-21T23:11Z
duration_min: 35
issue: 12
focus: scripts_capture_demo_ts_playwright_driver_plus_smoke_test_binary_deferred_to_followup
delta:
  files_added: 3   # scripts/capture_demo.ts, playwright.config.ts, test/capture-demo-smoke.test.ts
  files_changed: 2 # package.json (devDeps + capture script), README.md (Demo section)
  tests_added: 6
  test_pass_rate: "87/87"
  typecheck_pass: true
  lint_pass: true
context_for_next_session:
  - sixth_repo_to_land_capture_demo_pattern_after_embedding_chunking_vector_python_async_agent_orchestration_today
  - playwright_browsers_NOT_auto_installed_on_npm_install_npx_playwright_install_chromium_is_explicit_smoke_test_does_not_launch_browser_so_ci_stays_fast
  - tsx_added_as_devdep_for_npm_run_capture_invocation
  - capture_demo_ts_exports_timeline_constant_imported_by_smoke_test_same_pattern_as_readme_patterns_table_test_ts_for_drift_prevention
  - binary_recording_split_to_followup_16_30min_operational_step_requires_browsers_plus_ffmpeg
  - tamper_verified_smoke_test_fires_on_slug_drift_tool_use_to_toy_use_two_assertions_fired
  - new_d_012_capture_via_deterministic_script_binary_downstream_mirrors_pattern_across_5_sister_repos
  - mode_pill_d_003_visible_by_design_on_every_page_header_so_no_extra_capture_step_needed
  - optimistic_rollback_two_click_sequence_relies_on_d_010_deterministic_oracle_so_rollback_animation_lands_predictably
  - error_recovery_drop_after_tokens_route_handler_property_means_resumed_pill_guaranteed_in_first_run_no_flaky_recapture
decisions_made: [D-012]
followups: [#16]
---

---
session: 2026-05-22T17:15Z
duration_min: 30
issue: 18
focus: docs_architecture_md_reflects_all_five_shipped_patterns_not_pre_shipping_state
delta:
  files_changed: 2   # docs/architecture.md, README.md
  files_added: 1     # test/architecture-doc.test.ts
  tests_added: 6
  test_pass_rate: "93/93 (was 87)"
  typecheck_pass: true
  lint_pass: true
context_for_next_session:
  - docs_architecture_md_was_committed_when_only_streaming_text_shipped_and_never_updated_when_patterns_2_through_5_landed_directory_diagram_listed_only_one_pattern_one_api_route_seven_hermetic_tests_pending_patterns_section_listed_other_four_as_pending_or_unfiled_but_all_five_issues_are_closed
  - readme_patterns_table_locked_by_existing_readme_patterns_table_test_ts_already_enumerated_all_five_as_shipped_app_page_tsx_patterns_array_confirms_only_architecture_doc_lagged
  - new_architecture_doc_test_ts_three_invariants_app_slug_path_tokens_resolve_every_patterns_slug_referenced_at_least_once_three_banned_phrases_absent_unfiled_to_be_filed_pending_patterns_case_insensitive
  - banned_phrases_array_hard_pinned_in_separate_it_so_a_loose_edit_cannot_silently_drop_one
  - tamper_verified_by_reinjecting_pending_patterns_section_with_unfiled_bullets_four_of_six_new_tests_fire_three_banned_phrase_tests_plus_patterns_slug_coverage_test
  - readme_npm_test_comment_count_replaced_with_count_free_phrasing_so_a_future_suite_growth_pr_doesnt_have_to_also_edit_a_readme_counter
  - new_shipped_patterns_section_uses_app_slug_form_in_bullet_bold_tag_so_the_patterns_slug_coverage_test_finds_them_via_the_existing_regex
  - twelfth_post_v0_1_drift_fix_in_the_portfolio_pattern_fourth_in_this_session_parallel_to_mcp_server_cookbook_22_same_session_same_shape_an_architecture_doc_that_froze_at_the_first_patterns_pr_and_never_reframed
decisions_made: []
followups: []
---

---
session: 2026-05-23T15:55Z
duration_min: 20
issue: 20
focus: arch_doc_active_decision_range_axis_caught_d_002_uncited_typescript_sister_pattern
decisions_made: []
delta:
  files_changed: 2
  files_added: 0
  tests_added: 3
  test_pass_rate: "96/96"
context_for_next_session:
  - ninth_repo_in_portfolio_to_ship_active_decision_range_axis_first_typescript_sister_after_agent_orchestration_platform
  - typescript_pattern_ports_python_active_decisions_fixture_as_active_decisions_function_plus_referenced_decisions_set_accessor
  - real_drift_caught_d_002_one_nextjs_app_at_repo_root_one_page_per_pattern_was_uncited_added_inline_to_intro_paragraph
  - sister_repo_targets_remaining_ai_app_integration_tests_mcp_server_cookbook_both_typescript
followups: []
---

---
session: 2026-05-24T15:46Z
duration_min: 10
issue: 22
focus: mock_text_stream_abort_signal_cancellation_parity_with_tool_and_json
delta:
  files_changed: 2   # lib/mock-stream.ts, test/mock-stream.test.ts
  files_added: 0
  tests_added: 3
  test_pass_rate: "99/99"
decisions_made: []
context_for_next_session:
  - mock_text_stream_was_the_only_mock_stream_without_options_signal_mock_tool_and_mock_json_already_had_it
  - text_stream_event_shape_is_just_text_string_no_interrupted_marker_to_yield_unlike_tool_json_streams_message_stop_returning_cleanly_is_the_correct_semantic_route_layer_owns_the_sse_done_event
  - signal_aware_sleep_helper_extracted_inline_same_shape_as_mock_tool_stream_line_65_to_80_timer_resolves_either_on_fire_or_on_abort_so_interrupt_mid_pause_unblocks_immediately
  - portfolio_pattern_seventh_in_day_session_loop_after_eval_harness_37_prompt_regression_32_mcp_cookbook_31_emb_shootout_26_async_pipelines_29_agent_orch_28_first_typescript_frontend_target_of_the_day
followups: []
---
