mod git;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            git::git_status,
            git::git_log,
            git::git_branches,
            git::git_diff,
            git::git_fetch,
            git::git_show,
            git::git_diff_untracked,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_checkout,
            git::git_branch_create,
            git::git_branch_delete,
            git::git_branch_rename,
            git::git_merge,
            git::git_push_delete,
            git::git_get_user,
            git::git_config_user,
            git::git_discard,
            git::git_revert,
            git::git_diff_unpushed,
            git::git_write_file,
            git::git_remote_url,
            git::git_show_file,
            git::git_blame,
            git::git_reset_unpushed,
            git::git_commit_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
