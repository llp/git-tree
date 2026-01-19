use git2::{Repository, Sort, Oid};
use serde::{Serialize, Deserialize};
use chrono::{DateTime, NaiveDateTime, Utc};

#[derive(Serialize, Clone, Debug)]
pub struct CommitInfo {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub message: String,
    pub refs: Vec<RefInfo>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RefInfo {
    pub name: String,
    pub kind: String, // "branch", "remote", "tag", "HEAD"
}

#[tauri::command]
pub fn get_commits(path: String) -> Result<Vec<CommitInfo>, String> {
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;

    // Also push all branches and tags to ensure we see everything
    // This might be expensive for huge repos, but for a tree view we usually want to see all refs
    // Or maybe just HEAD for now? The requirement says "all branches".
    // Let's try to push glob "refs/heads/*" and "refs/tags/*" and "refs/remotes/*"
    let _ = revwalk.push_glob("refs/heads/*");
    let _ = revwalk.push_glob("refs/tags/*");
    let _ = revwalk.push_glob("refs/remotes/*");

    let mut commits = Vec::new();

    // Collect refs to map them to commits
    let mut ref_map: std::collections::HashMap<String, Vec<RefInfo>> = std::collections::HashMap::new();

    let references = repo.references().map_err(|e| e.to_string())?;
    for reference in references {
        if let Ok(r) = reference {
            if let Some(name) = r.name() {
                if let Some(target) = r.target() {
                    let kind = if r.is_remote() {
                        "remote"
                    } else if r.is_tag() {
                        "tag"
                    } else if r.is_branch() {
                        "branch"
                    } else {
                        "other"
                    };

                    let short_name = r.shorthand().unwrap_or(name).to_string();

                    ref_map.entry(target.to_string()).or_default().push(RefInfo {
                        name: short_name,
                        kind: kind.to_string(),
                    });
                }
            }
        }
    }

    // Check HEAD
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
             ref_map.entry(target.to_string()).or_default().push(RefInfo {
                name: "HEAD".to_string(),
                kind: "HEAD".to_string(),
            });
        }
    }

    for oid in revwalk {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;

        let parents: Vec<String> = commit.parent_ids().map(|p| p.to_string()).collect();
        let author = commit.author();
        let sig = commit.author();

        let refs = ref_map.get(&oid.to_string()).cloned().unwrap_or_default();

        commits.push(CommitInfo {
            oid: oid.to_string(),
            parents,
            author: author.name().unwrap_or("Unknown").to_string(),
            email: author.email().unwrap_or("").to_string(),
            date: commit.time().seconds(),
            message: commit.message().unwrap_or("").to_string(),
            refs,
        });

        // Limit to 1000 commits for performance for now
        if commits.len() >= 1000 {
            break;
        }
    }

    Ok(commits)
}

#[tauri::command]
pub fn open_repo_dialog() -> Result<String, String> {
    // In Tauri v2 we use the dialog plugin usually, but here we might just return a dummy or handle it in frontend.
    // Actually, the user asked to "select local repository folder".
    // The frontend can use @tauri-apps/plugin-dialog.
    // I will leave this empty or remove it if not needed in backend.
    Ok("".to_string())
}
