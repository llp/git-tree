import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface RefInfo {
  name: string;
  kind: string;
}

interface CommitInfo {
  oid: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  message: string;
  refs: RefInfo[];
}

interface FileChange {
  path: string;
  status: string;
}

interface Repo {
  id: string;
  name: string;
  path: string;
  group: string;
}

interface NodePosition {
  oid: string;
  x: number;
  y: number;
  radius: number;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  commit: CommitInfo | null;
}

function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  
  // Add Repo Inputs
  const [repoPathInput, setRepoPathInput] = useState("");
  const [repoNameInput, setRepoNameInput] = useState("");
  const [repoGroupInput, setRepoGroupInput] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  
  // Edit Repo State
  const [editingRepo, setEditingRepo] = useState<Repo | null>(null);
  
  const [hoveredCommit, setHoveredCommit] = useState<CommitInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, commit: null });
  
  const [changesModalOpen, setChangesModalOpen] = useState(false);
  const [selectedCommitChanges, setSelectedCommitChanges] = useState<FileChange[]>([]);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [changesModalTitle, setChangesModalTitle] = useState("");
  const [viewingCommit, setViewingCommit] = useState<CommitInfo | null>(null);

  const [compareSourceCommit, setCompareSourceCommit] = useState<CommitInfo | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(800);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodePositions = useRef<NodePosition[]>([]);
  const currentBranchOids = useRef<Set<string>>(new Set());

  useEffect(() => {
    const storedRepos = localStorage.getItem("git-tree-repos");
    if (storedRepos) {
      setRepos(JSON.parse(storedRepos));
    }
    
    const handleResize = () => {
        if (containerRef.current) {
            setCanvasWidth(containerRef.current.clientWidth - 40); // padding
        }
    };
    
    window.addEventListener('resize', handleResize);
    handleResize();
    
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    localStorage.setItem("git-tree-repos", JSON.stringify(repos));
  }, [repos]);

  useEffect(() => {
    if (selectedRepoId) {
      const repo = repos.find(r => r.id === selectedRepoId);
      if (repo) {
        loadCommits(repo.path);
      }
    }
  }, [selectedRepoId]);

  useEffect(() => {
    // Identify current branch commits (simple heuristic: follow first parent from HEAD)
    const headCommit = commits.find(c => c.refs.some(r => r.kind === "HEAD"));
    const newCurrentBranchOids = new Set<string>();
    
    if (headCommit) {
        let current: CommitInfo | undefined = headCommit;
        while (current) {
            newCurrentBranchOids.add(current.oid);
            if (current.parents.length > 0) {
                // Follow first parent
                current = commits.find(c => c.oid === current!.parents[0]);
            } else {
                current = undefined;
            }
        }
    }
    currentBranchOids.current = newCurrentBranchOids;
    
    drawTree();
  }, [commits, hoveredCommit, canvasWidth]);

  useEffect(() => {
    const handleClick = () => setContextMenu({ ...contextMenu, visible: false });
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [contextMenu]);

  async function loadCommits(path: string) {
    try {
      const result = await invoke<CommitInfo[]>("get_commits", { path });
      setCommits(result);
    } catch (error) {
      console.error("Failed to load commits:", error);
      alert("Failed to load commits: " + error);
    }
  }

  async function addRepo() {
    if (!repoPathInput || !repoNameInput) return;

    let finalPath = repoPathInput;

    // Check if it's a URL
    if (repoPathInput.startsWith("http://") || repoPathInput.startsWith("https://") || repoPathInput.startsWith("git@")) {
        const urlParts = repoPathInput.split('/');
        const repoName = urlParts[urlParts.length - 1].replace('.git', '');
        
        const localDest = prompt(`Enter local path to clone ${repoName} into:`, "");
        if (!localDest) return;
        
        setIsCloning(true);
        try {
            await invoke("clone_repo", { url: repoPathInput, path: localDest });
            finalPath = localDest;
        } catch (e) {
            alert("Clone failed: " + e);
            setIsCloning(false);
            return;
        }
        setIsCloning(false);
    }

    const newRepo: Repo = {
      id: Date.now().toString(),
      name: repoNameInput,
      path: finalPath,
      group: repoGroupInput || "Default",
    };
    setRepos([...repos, newRepo]);
    setRepoPathInput("");
    setRepoNameInput("");
    setRepoGroupInput("");
  }
  
  function deleteRepo(e: React.MouseEvent, id: string) {
      e.stopPropagation();
      if (confirm("Are you sure you want to remove this repository from the list?")) {
          setRepos(repos.filter(r => r.id !== id));
          if (selectedRepoId === id) {
              setSelectedRepoId(null);
              setCommits([]);
          }
      }
  }

  function startEditRepo(e: React.MouseEvent, repo: Repo) {
      e.stopPropagation();
      setEditingRepo({ ...repo });
  }

  function saveEditRepo() {
      if (!editingRepo) return;
      setRepos(repos.map(r => r.id === editingRepo.id ? editingRepo : r));
      setEditingRepo(null);
  }

  function drawTree() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const ROW_HEIGHT = 40;
    const COL_WIDTH = 20;
    const PADDING_TOP = 20;
    const PADDING_LEFT = 20;

    const columns: { [oid: string]: number } = {};
    const activeColumns: (string | null)[] = [];
    const rowIndex: { [oid: string]: number } = {};
    
    commits.forEach((c, i) => rowIndex[c.oid] = i);
    
    nodePositions.current = [];

    commits.forEach((commit, index) => {
      let col = -1;
      const existingColIndex = activeColumns.indexOf(commit.oid);
      
      if (existingColIndex !== -1) {
        col = existingColIndex;
        activeColumns[existingColIndex] = null;
      } else {
        col = activeColumns.indexOf(null);
        if (col === -1) {
          col = activeColumns.length;
          activeColumns.push(null);
        }
      }
      
      columns[commit.oid] = col;

      commit.parents.forEach((parentOid, pIdx) => {
        if (pIdx === 0) {
           if (activeColumns[col] === null) {
             activeColumns[col] = parentOid;
           } else {
             activeColumns[col] = parentOid;
           }
        } else {
           const existingParentCol = activeColumns.indexOf(parentOid);
           if (existingParentCol === -1) {
             let freeCol = activeColumns.indexOf(null);
             if (freeCol === -1) {
               freeCol = activeColumns.length;
               activeColumns.push(null);
             }
             activeColumns[freeCol] = parentOid;
           }
        }
      });
    });

    commits.forEach((commit, index) => {
      const x = PADDING_LEFT + columns[commit.oid] * COL_WIDTH;
      const y = PADDING_TOP + index * ROW_HEIGHT;
      
      nodePositions.current.push({ oid: commit.oid, x, y, radius: 5 });

      const isCurrentBranch = currentBranchOids.current.has(commit.oid);
      const nodeColor = isCurrentBranch ? "#e74c3c" : getBranchColor(columns[commit.oid]);

      // Draw connections
      commit.parents.forEach((parentOid, pIdx) => {
        const parentIndex = rowIndex[parentOid];
        if (parentIndex !== undefined) {
          const parentCol = columns[parentOid];
          const parentX = PADDING_LEFT + parentCol * COL_WIDTH;
          const parentY = PADDING_TOP + parentIndex * ROW_HEIGHT;
          
          ctx.beginPath();
          ctx.moveTo(x, y);
          
          // If the parent is immediately above, draw a straight line
          // But since we are simplifying, the parent might be far away in index, but logically connected.
          // The rowIndex is based on the simplified list, so it should be fine.
          
          // Check if parent is "far away" (more than 1 row) to maybe draw a dashed line?
          // For now, solid line is fine.
          
          ctx.bezierCurveTo(x, y + ROW_HEIGHT / 2, parentX, parentY - ROW_HEIGHT / 2, parentX, parentY);
          
          // Color line red if both this commit and parent are on current branch and it's the first parent
          const isParentOnCurrent = currentBranchOids.current.has(parentOid);
          if (isCurrentBranch && isParentOnCurrent && pIdx === 0) {
              ctx.strokeStyle = "#e74c3c";
              ctx.lineWidth = 3;
          } else {
              ctx.strokeStyle = getBranchColor(columns[commit.oid]);
              ctx.lineWidth = 2;
          }
          
          // If the distance is large, maybe make it dashed to indicate skipped commits?
          if (Math.abs(index - parentIndex) > 1) {
              ctx.setLineDash([5, 5]);
              ctx.stroke();
              ctx.setLineDash([]);
          } else {
              ctx.stroke();
          }
        }
      });

      // Draw node
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, 2 * Math.PI);
      ctx.fillStyle = nodeColor;
      ctx.fill();
      
      if (hoveredCommit && hoveredCommit.oid === commit.oid) {
          ctx.strokeStyle = "black";
          ctx.lineWidth = 2;
          ctx.stroke();
      }
      
      // Draw refs
      let textOffset = 10;
      commit.refs.forEach(ref => {
        ctx.font = "10px sans-serif";
        const textWidth = ctx.measureText(ref.name).width;
        
        ctx.fillStyle = getRefColor(ref.kind);
        ctx.fillRect(x + textOffset, y - 8, textWidth + 4, 12);
        
        ctx.fillStyle = "black";
        ctx.fillText(ref.name, x + textOffset + 2, y + 2);
        
        textOffset += textWidth + 8;
      });

      // Draw message
      ctx.fillStyle = "#333";
      ctx.font = "12px sans-serif";
      const message = commit.message.split('\n')[0];
      ctx.fillText(message, x + textOffset + 10, y + 4);
      
      // Draw author and date
      const dateStr = new Date(commit.date * 1000).toLocaleString();
      const authorStr = `${commit.author}`;
      const infoStr = `${authorStr} - ${dateStr}`;
      
      ctx.fillStyle = "#666";
      const infoX = Math.max(x + textOffset + 10 + ctx.measureText(message).width + 20, 400);
      ctx.fillText(infoStr, infoX, y + 4);
    });
    
    if (canvas.height < (commits.length + 1) * ROW_HEIGHT) {
        canvas.height = (commits.length + 1) * ROW_HEIGHT;
        requestAnimationFrame(drawTree);
    }
  }

  function getBranchColor(colIndex: number) {
    const colors = ["#2ecc71", "#3498db", "#9b59b6", "#f1c40f", "#e67e22", "#1abc9c"];
    return colors[colIndex % colors.length];
  }

  function getRefColor(kind: string) {
    switch (kind) {
      case "HEAD": return "#e74c3c"; // Red
      case "branch": return "#2ecc71"; // Green
      case "remote": return "#9b59b6"; // Magenta
      case "tag": return "#f1c40f"; // Yellow
      default: return "#95a5a6";
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const ROW_HEIGHT = 40;
      const PADDING_TOP = 20;
      
      const approxIndex = Math.floor((y - PADDING_TOP + ROW_HEIGHT/2) / ROW_HEIGHT);
      
      let found = null;
      for (let i = Math.max(0, approxIndex - 1); i <= Math.min(commits.length - 1, approxIndex + 1); i++) {
          const pos = nodePositions.current.find(p => p.oid === commits[i].oid);
          if (pos) {
              const dx = x - pos.x;
              const dy = y - pos.y;
              if (dx*dx + dy*dy <= (pos.radius + 2) * (pos.radius + 2)) {
                  found = commits[i];
                  break;
              }
          }
      }
      
      if (found !== hoveredCommit) {
          setHoveredCommit(found);
      }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (hoveredCommit) {
          setContextMenu({
              visible: true,
              x: e.clientX,
              y: e.clientY,
              commit: hoveredCommit
          });
      }
  };

  const handleCheckout = async () => {
      if (!contextMenu.commit || !selectedRepoId) return;
      const repo = repos.find(r => r.id === selectedRepoId);
      if (!repo) return;

      try {
          await invoke("checkout_ref", { path: repo.path, reference: contextMenu.commit.oid });
          alert(`Checked out ${contextMenu.commit.oid.substring(0, 7)}`);
          loadCommits(repo.path);
      } catch (e) {
          alert("Checkout failed: " + e);
      }
      setContextMenu({ ...contextMenu, visible: false });
  };

  const handleViewChanges = async () => {
      if (!contextMenu.commit || !selectedRepoId) return;
      const repo = repos.find(r => r.id === selectedRepoId);
      if (!repo) return;

      setViewingCommit(contextMenu.commit);
      setChangesModalOpen(true);
      setLoadingChanges(true);
      setSelectedCommitChanges([]);
      setChangesModalTitle(`Changes in ${contextMenu.commit.oid.substring(0, 7)}`);
      setContextMenu({ ...contextMenu, visible: false });

      try {
          const changes = await invoke<FileChange[]>("get_commit_changes", { 
              path: repo.path, 
              oid: contextMenu.commit.oid 
          });
          setSelectedCommitChanges(changes);
      } catch (e) {
          alert("Failed to get changes: " + e);
          setChangesModalOpen(false);
      } finally {
          setLoadingChanges(false);
      }
  };

  const handleSelectForCompare = () => {
      if (contextMenu.commit) {
          setCompareSourceCommit(contextMenu.commit);
          setContextMenu({ ...contextMenu, visible: false });
      }
  };

  const handleCompareWithSelected = async () => {
      if (!contextMenu.commit || !compareSourceCommit || !selectedRepoId) return;
      const repo = repos.find(r => r.id === selectedRepoId);
      if (!repo) return;

      setViewingCommit(null);
      setChangesModalOpen(true);
      setLoadingChanges(true);
      setSelectedCommitChanges([]);
      setChangesModalTitle(`Comparing ${compareSourceCommit.oid.substring(0, 7)} with ${contextMenu.commit.oid.substring(0, 7)}`);
      setContextMenu({ ...contextMenu, visible: false });

      try {
          const changes = await invoke<FileChange[]>("compare_commits", { 
              path: repo.path, 
              oid1: compareSourceCommit.oid,
              oid2: contextMenu.commit.oid
          });
          setSelectedCommitChanges(changes);
      } catch (e) {
          alert("Failed to compare: " + e);
          setChangesModalOpen(false);
      } finally {
          setLoadingChanges(false);
          setCompareSourceCommit(null);
      }
  };

  const handleCopySha = () => {
      if (contextMenu.commit) {
          navigator.clipboard.writeText(contextMenu.commit.oid);
          setContextMenu({ ...contextMenu, visible: false });
      }
  };

  // Group repos
  const groupedRepos: { [group: string]: Repo[] } = {};
  repos.forEach(repo => {
      const group = repo.group || "Default";
      if (!groupedRepos[group]) groupedRepos[group] = [];
      groupedRepos[group].push(repo);
  });
  const sortedGroups = Object.keys(groupedRepos).sort();

  return (
    <div className="app-container">
      <div className="sidebar">
        <h2>Repositories</h2>
        <div className="add-repo-form">
          <input 
            placeholder="Name" 
            value={repoNameInput} 
            onChange={e => setRepoNameInput(e.target.value)} 
          />
          <input 
            placeholder="Local Path or Remote URL" 
            value={repoPathInput} 
            onChange={e => setRepoPathInput(e.target.value)} 
          />
          <input 
            placeholder="Group" 
            value={repoGroupInput} 
            onChange={e => setRepoGroupInput(e.target.value)} 
          />
          <button onClick={addRepo} disabled={isCloning}>
              {isCloning ? "Cloning..." : "Add"}
          </button>
        </div>
        <div className="repo-list">
          {sortedGroups.map(group => (
              <div key={group} className="repo-group-section">
                  <div className="repo-group-header">{group}</div>
                  {groupedRepos[group].map(repo => (
                    <div 
                      key={repo.id} 
                      className={`repo-item ${selectedRepoId === repo.id ? 'selected' : ''}`}
                      onClick={() => setSelectedRepoId(repo.id)}
                    >
                      <div className="repo-header">
                          <span className="repo-name">{repo.name}</span>
                          <div className="repo-actions">
                              <button className="icon-btn" onClick={(e) => startEditRepo(e, repo)}>✎</button>
                              <button className="icon-btn delete-btn" onClick={(e) => deleteRepo(e, repo.id)}>×</button>
                          </div>
                      </div>
                      <div className="repo-path">{repo.path}</div>
                    </div>
                  ))}
              </div>
          ))}
        </div>
      </div>
      <div className="main-content" ref={containerRef}>
        {selectedRepoId ? (
          <>
            <div className="toolbar">
                <button onClick={() => {
                    const repo = repos.find(r => r.id === selectedRepoId);
                    if (repo) loadCommits(repo.path);
                }}>Refresh</button>
                <span style={{marginLeft: '10px', fontSize: '0.9em', color: '#666'}}>
                    {commits.length} commits loaded (Simplified View)
                </span>
            </div>
            <div className="git-graph-container" style={{overflow: 'auto', height: 'calc(100vh - 40px)'}}>
                <canvas 
                    ref={canvasRef} 
                    width={Math.max(canvasWidth, 800)} 
                    height={600} 
                    onMouseMove={handleMouseMove}
                    onContextMenu={handleContextMenu}
                />
                {hoveredCommit && (
                    <div style={{
                        position: 'fixed',
                        bottom: 10,
                        right: 10,
                        backgroundColor: 'rgba(0,0,0,0.8)',
                        color: 'white',
                        padding: '10px',
                        borderRadius: '5px',
                        pointerEvents: 'none',
                        maxWidth: '400px',
                        zIndex: 100
                    }}>
                        <div><strong>Commit:</strong> {hoveredCommit.oid.substring(0, 8)}</div>
                        <div><strong>Author:</strong> {hoveredCommit.author} &lt;{hoveredCommit.email}&gt;</div>
                        <div><strong>Date:</strong> {new Date(hoveredCommit.date * 1000).toLocaleString()}</div>
                        <div style={{marginTop: '5px', whiteSpace: 'pre-wrap'}}>{hoveredCommit.message}</div>
                    </div>
                )}
                {contextMenu.visible && (
                    <div 
                        className="context-menu"
                        style={{
                            position: 'fixed',
                            top: contextMenu.y,
                            left: contextMenu.x,
                            backgroundColor: 'white',
                            border: '1px solid #ccc',
                            boxShadow: '2px 2px 5px rgba(0,0,0,0.2)',
                            zIndex: 1000,
                            padding: '5px 0',
                            borderRadius: '4px'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="menu-item" onClick={handleViewChanges}>View Changes / Log</div>
                        <div className="menu-item" onClick={handleCheckout}>Checkout this commit</div>
                        <div className="menu-item" onClick={handleSelectForCompare}>Select for compare</div>
                        {compareSourceCommit && (
                            <div className="menu-item" onClick={handleCompareWithSelected}>Compare with selected</div>
                        )}
                        <div className="menu-item" onClick={handleCopySha}>Copy SHA</div>
                    </div>
                )}
            </div>
          </>
        ) : (
          <div className="placeholder">Select a repository</div>
        )}
      </div>

      {/* Edit Repo Modal */}
      {editingRepo && (
          <div className="modal-overlay" onClick={() => setEditingRepo(null)}>
              <div className="modal-content" style={{width: '400px'}} onClick={e => e.stopPropagation()}>
                  <h3>Edit Repository</h3>
                  <div className="add-repo-form">
                      <label>Name</label>
                      <input 
                          value={editingRepo.name} 
                          onChange={e => setEditingRepo({...editingRepo, name: e.target.value})} 
                      />
                      <label>Path</label>
                      <input 
                          value={editingRepo.path} 
                          onChange={e => setEditingRepo({...editingRepo, path: e.target.value})} 
                      />
                      <label>Group</label>
                      <input 
                          value={editingRepo.group} 
                          onChange={e => setEditingRepo({...editingRepo, group: e.target.value})} 
                      />
                  </div>
                  <div style={{display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px'}}>
                      <button onClick={() => setEditingRepo(null)}>Cancel</button>
                      <button onClick={saveEditRepo}>Save</button>
                  </div>
              </div>
          </div>
      )}

      {changesModalOpen && (
          <div className="modal-overlay" onClick={() => setChangesModalOpen(false)}>
              <div className="modal-content" onClick={e => e.stopPropagation()}>
                  {viewingCommit && (
                      <div className="commit-details">
                          <div className="commit-info-row">
                              <span className="commit-oid">{viewingCommit.oid}</span>
                              <span className="commit-date">{new Date(viewingCommit.date * 1000).toLocaleString()}</span>
                          </div>
                          <div className="commit-author"><strong>{viewingCommit.author}</strong> &lt;{viewingCommit.email}&gt;</div>
                          <pre className="commit-message">{viewingCommit.message}</pre>
                      </div>
                  )}
                  <h3>{changesModalTitle}</h3>
                  {loadingChanges ? (
                      <p>Loading...</p>
                  ) : (
                      <div className="changes-list">
                          {selectedCommitChanges.length === 0 ? (
                              <p>No changes (merge commit or empty)</p>
                          ) : (
                              <table>
                                  <thead>
                                      <tr>
                                          <th>Status</th>
                                          <th>Path</th>
                                      </tr>
                                  </thead>
                                  <tbody>
                                      {selectedCommitChanges.map((change, idx) => (
                                          <tr key={idx}>
                                              <td className={`status-${change.status}`}>{change.status}</td>
                                              <td>{change.path}</td>
                                          </tr>
                                      ))}
                                  </tbody>
                              </table>
                          )}
                      </div>
                  )}
                  <button className="close-btn" onClick={() => setChangesModalOpen(false)}>Close</button>
              </div>
          </div>
      )}
    </div>
  );
}

export default App;
