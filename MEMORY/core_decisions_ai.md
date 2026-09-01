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

- id: D-011
  date: 2026-05-18
  decision: error_recovery_checkpoints_are_token_position_integers_not_opaque_server_state_blobs
  rationale: integer_index_lets_route_handler_resume_by_skipping_first_n_tokens_no_per_session_server_state_to_manage_keeps_drop_path_deterministic_matches_existing_sse_text_event_shape_client_logic_stays_trivial_single_number_to_record
  alternatives_rejected: [opaque_cursor_strings_forces_server_side_state_map_defeats_deterministic_drop, per_session_backing_store_overkill_for_demo_without_database, client_side_hashing_of_received_text_brittle_loses_sync_with_server_tokenization]
  reversibility: cheap
  related_issues: [5]
  superseded_by: null

- id: D-012
  date: 2026-05-21
  decision: scripts_capture_demo_ts_playwright_driver_is_source_of_truth_binary_recording_split_to_followup
  rationale: deterministic_playwright_script_plus_smoke_test_is_what_lets_the_recording_be_reproduced_on_any_pattern_change_committing_a_one_off_binary_is_downstream_of_that_and_requires_browsers_plus_ffmpeg_locally_split_keeps_the_engineering_landable_and_makes_the_binary_step_a_30min_operational_task_that_doesnt_block_the_six_item_quality_bar_engineering_check_for_v01
  alternatives_rejected: [record_video_in_this_pr_requires_playwright_browsers_plus_ffmpeg_plus_dev_server_lifecycle_during_a_remote_session_not_repeatable_in_ci, ship_only_the_binary_no_script_then_recapture_requires_replaying_clicks_by_hand_pattern_drift_silently_invalidates_the_video, use_a_screen_recorder_macro_no_repository_of_truth_breaks_on_first_pattern_rename]
  reversibility: cheap
  related_issues: [12, 16]
  superseded_by: null

- id: D-013
  date: 2026-09-01
  decision: every_sse_read_path_flushes_its_textdecoder_before_flushing_the_framer_even_though_it_changes_no_frame_today
  rationale: textdecoder_with_stream_true_holds_a_trailing_incomplete_utf8_sequence_and_the_argument_less_decode_is_what_releases_it_as_u_fffd_all_three_read_paths_made_the_streaming_call_and_never_the_flushing_one_MEASURED_the_decoder_level_difference_is_real_data_caf_versus_data_caf_replacement_char_and_the_FRAME_level_difference_is_NIL_across_eight_bodies_covering_lf_crlf_and_cr_framing_plus_lone_cr_terminators_and_multibyte_payloads_times_every_byte_truncation_of_each_times_read_chunk_sizes_1_2_3_5_whole_ZERO_differing_cases_because_the_held_bytes_only_exist_when_the_stream_ended_mid_codepoint_which_means_the_framer_is_holding_an_unterminated_tail_which_flush_deliberately_drops_SO_THIS_IS_NOT_A_BUG_FIX_it_is_adopted_because_it_is_free_because_the_exhaustive_equivalence_proves_it_SAFE_rather_than_merely_hoped_safe_and_because_issue_97_is_open_about_whether_a_truncated_tail_should_surface_as_an_ERROR_and_if_it_ever_says_yes_the_u_fffd_is_the_evidence_and_has_to_have_survived_to_be_it_the_alternative_is_remembering_to_revisit_three_files_at_that_moment
  scope: the_flush_only_the_question_of_whether_the_framers_unterminated_remainder_should_be_emitted_or_raised_remains_97_and_is_untouched
  measured: "decoder level: 'data: café' cut mid-é decodes to 'data: caf' streamed, 'caf' + U+FFFD flushed. Frame level: 8 bodies x every byte truncation x chunk sizes {1,2,3,5,4096} = 0 differing frame sequences. Also checked and NOT a bug: error-recovery-client constructs its TextDecoder inside run(), so a resume gets a fresh one and no held bytes leak across streams."
  alternatives_rejected: [leave_it_and_wait_for_97_which_means_three_files_to_remember_at_a_moment_when_the_person_deciding_97_is_thinking_about_framing_not_decoding, flush_only_in_pumpSseFrames_which_is_the_partial_adoption_shape_114_had_just_fixed, emit_the_framers_unterminated_remainder_too_which_is_97s_question_not_this_one]
  reversibility: cheap
  related_issues: ["#115", "#114", "#97"]
  superseded_by: null
