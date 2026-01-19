use git2::{Repository, Sort, Oid};
use serde::Serialize;

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

#[derive(Serialize, Clone, Debug)]
pub struct FileChange {
    pub path: String,
    pub status: String,
}

#[tauri::command]
pub fn get_commits(path: String) -> Result<Vec<CommitInfo>, String> {
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;

    // Collect refs to map them to commits
    let mut ref_map: std::collections::HashMap<String, Vec<RefInfo>> = std::collections::HashMap::new();
    let mut relevant_oids: std::collections::HashSet<String> = std::collections::HashSet::new();

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
                    let target_oid = target.to_string();

                    ref_map.entry(target_oid.clone()).or_default().push(RefInfo {
                        name: short_name,
                        kind: kind.to_string(),
                    });

                    relevant_oids.insert(target_oid);
                }
            }
        }
    }

    // Check HEAD
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
             let target_oid = target.to_string();
             ref_map.entry(target_oid.clone()).or_default().push(RefInfo {
                name: "HEAD".to_string(),
                kind: "HEAD".to_string(),
            });
            relevant_oids.insert(target_oid);
        }
    }

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.to_string())?;

    // Push all refs
    let _ = revwalk.push_glob("refs/heads/*");
    let _ = revwalk.push_glob("refs/tags/*");
    let _ = revwalk.push_glob("refs/remotes/*");
    if revwalk.push_head().is_err() {}

    let mut all_commits = Vec::new();

    for oid in revwalk {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;

        let parents: Vec<String> = commit.parent_ids().map(|p| p.to_string()).collect();

        let info = CommitInfo {
            oid: oid.to_string(),
            parents: parents.clone(),
            author: commit.author().name().unwrap_or("Unknown").to_string(),
            email: commit.author().email().unwrap_or("").to_string(),
            date: commit.time().seconds(),
            message: commit.message().unwrap_or("").to_string(),
            refs: ref_map.get(&oid.to_string()).cloned().unwrap_or_default(),
        };

        all_commits.push(info);

        if all_commits.len() >= 2000 { break; }
    }

    // Now we have a list of commits (topologically sorted).
    // We want to filter `all_commits` to only include those that are "interesting" (have refs)
    // AND re-link their parents to the nearest interesting ancestor.

    // Map OID -> CommitInfo
    let mut commit_map: std::collections::HashMap<String, CommitInfo> = std::collections::HashMap::new();
    for c in &all_commits {
        commit_map.insert(c.oid.clone(), c.clone());
    }

    let mut simplified_commits = Vec::new();

    for commit in &all_commits {
        // Keep if it has refs OR is a merge commit (optional, but good for graph) OR is the very first commit
        let has_refs = !commit.refs.is_empty();
        let is_merge = commit.parents.len() > 1;
        let is_root = commit.parents.is_empty();

        if has_refs || is_merge || is_root {
            let mut new_commit = commit.clone();

            // Find nearest interesting ancestors for each parent
            let mut new_parents = Vec::new();
            for parent_oid in &commit.parents {
                let mut runner = parent_oid.clone();
                let mut seen = std::collections::HashSet::new();

                loop {
                    if seen.contains(&runner) { break; } // Cycle protection
                    seen.insert(runner.clone());

                    if let Some(ancestor) = commit_map.get(&runner) {
                        let ancestor_has_refs = !ancestor.refs.is_empty();
                        let ancestor_is_merge = ancestor.parents.len() > 1;
                        let ancestor_is_root = ancestor.parents.is_empty();

                        if ancestor_has_refs || ancestor_is_merge || ancestor_is_root {
                            // Found an interesting ancestor
                            new_parents.push(runner);
                            break;
                        } else {
                            // Keep walking up
                            if !ancestor.parents.is_empty() {
                                runner = ancestor.parents[0].clone();
                            } else {
                                break;
                            }
                        }
                    } else {
                        // Ancestor not in our loaded list (maybe beyond 2000 limit)
                        // Just keep the link to the edge
                        new_parents.push(runner);
                        break;
                    }
                }
            }
            // Deduplicate parents
            new_parents.sort();
            new_parents.dedup();

            new_commit.parents = new_parents;
            simplified_commits.push(new_commit);
        }
    }

    // If simplified list is empty (e.g. no refs, no merges), just return everything?
    // Or if the user has a repo with just one commit and no refs (unlikely).
    if simplified_commits.is_empty() && !all_commits.is_empty() {
        return Ok(all_commits);
    }

    Ok(simplified_commits)
}

#[tauri::command]
pub fn checkout_ref(path: String, reference: String) -> Result<(), String> {
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;

    // Try to find the ref (branch/tag) or commit
    // If reference is a branch name like "main", we want to checkout that branch
    // If it's a commit hash, we checkout detached

    // First try to resolve as a reference
    let (object, ref_obj) = match repo.revparse_ext(&reference) {
        Ok(res) => res,
        Err(_) => return Err(format!("Reference not found: {}", reference)),
    };

    // Checkout the tree
    repo.checkout_tree(&object, None).map_err(|e| e.to_string())?;

    match ref_obj {
        Some(gref) => {
            // It's a reference (branch/tag)
            if gref.is_branch() {
                 repo.set_head(gref.name().unwrap()).map_err(|e| e.to_string())?;
            } else {
                 repo.set_head_detached(object.id()).map_err(|e| e.to_string())?;
            }
        },
        None => {
            // It's a commit ID
            repo.set_head_detached(object.id()).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_commit_changes(path: String, oid: String) -> Result<Vec<FileChange>, String> {
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(Oid::from_str(&oid).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;

    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0).map_err(|e| e.to_string())?.tree().map_err(|e| e.to_string())?)
    } else {
        None
    };

    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None).map_err(|e| e.to_string())?;

    let mut changes = Vec::new();
    diff.foreach(&mut |delta, _| {
        let path = delta.new_file().path().unwrap_or(delta.old_file().path().unwrap());
        let status = format!("{:?}", delta.status());
        changes.push(FileChange {
            path: path.to_string_lossy().to_string(),
            status,
        });
        true
    }, None, None, None).map_err(|e| e.to_string())?;

    Ok(changes)
}

#[tauri::command]
pub fn compare_commits(path: String, oid1: String, oid2: String) -> Result<Vec<FileChange>, String> {
    let repo = Repository::open(&path).map_err(|e| e.to_string())?;
    let commit1 = repo.find_commit(Oid::from_str(&oid1).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let commit2 = repo.find_commit(Oid::from_str(&oid2).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;

    let tree1 = commit1.tree().map_err(|e| e.to_string())?;
    let tree2 = commit2.tree().map_err(|e| e.to_string())?;

    let diff = repo.diff_tree_to_tree(Some(&tree1), Some(&tree2), None).map_err(|e| e.to_string())?;

    let mut changes = Vec::new();
    diff.foreach(&mut |delta, _| {
        let path = delta.new_file().path().unwrap_or(delta.old_file().path().unwrap());
        let status = format!("{:?}", delta.status());
        changes.push(FileChange {
            path: path.to_string_lossy().to_string(),
            status,
        });
        true
    }, None, None, None).map_err(|e| e.to_string())?;

    Ok(changes)
}

#[tauri::command]
pub fn clone_repo(url: String, path: String) -> Result<String, String> {
    let _ = Repository::clone(&url, &path).map_err(|e| e.to_string())?;
    Ok("Cloned successfully".to_string())
}
