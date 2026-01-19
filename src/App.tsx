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

type ViewMode = 'history' | 'topology';

function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('history');
  
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
    
    if (viewMode === 'history') {
        drawTree();
    } else {
        drawTopology();
    }
  }, [commits, hoveredCommit, canvasWidth, viewMode]);

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

    // Enable high DPI rendering
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, rect.width, rect.height);

    const ROW_HEIGHT = 50;
    const COL_WIDTH = 24;
    const PADDING_TOP = 30;
    const PADDING_LEFT = 30;

    // --- Improved Layout Algorithm (Greedy Lane Assignment) ---
    const columns: { [oid: string]: number } = {};
    const activeLanes: (string | null)[] = []; // Stores the OID of the commit that "owns" this lane
    const rowIndex: { [oid: string]: number } = {};
    
    commits.forEach((c, i) => rowIndex[c.oid] = i);
    
    nodePositions.current = [];

    commits.forEach((commit, _) => {
      let col = -1;
      
      // 1. Check if this commit is the "next" in an active lane
      const existingLaneIndex = activeLanes.indexOf(commit.oid);
      
      if (existingLaneIndex !== -1) {
        col = existingLaneIndex;
        // We consumed this expectation. Now this lane is free to be extended to a parent.
        activeLanes[existingLaneIndex] = null; 
      } else {
        // This commit was not expected by any previous child. It must be a new branch tip.
        col = activeLanes.indexOf(null);
        if (col === -1) {
          col = activeLanes.length;
          activeLanes.push(null);
        }
      }
      
      columns[commit.oid] = col;

      // 2. Propagate lane to parents
      commit.parents.forEach((parentOid, pIdx) => {
        if (pIdx === 0) {
           // Primary parent inherits the lane
           if (activeLanes[col] === null) {
             activeLanes[col] = parentOid;
           } else {
             // If lane is already booked, we can't use it.
             // This happens in forks. The parent will be picked up by another child's lane.
           }
        } else {
           // Secondary parents (merge sources)
           // Check if this parent is already expected in some lane
           const existingParentLane = activeLanes.indexOf(parentOid);
           if (existingParentLane === -1) {
             // Not expected yet. Assign a new lane for it.
             let freeCol = activeLanes.indexOf(null);
             if (freeCol === -1) {
               freeCol = activeLanes.length;
               activeLanes.push(null);
             }
             activeLanes[freeCol] = parentOid;
           }
        }
      });
    });

    const totalHeight = (commits.length + 1) * ROW_HEIGHT + PADDING_TOP;
    if (canvas.height / dpr < totalHeight) {
        if (canvas.style.height !== `${totalHeight}px`) {
            canvas.style.height = `${totalHeight}px`;
            requestAnimationFrame(drawTree);
            return;
        }
    }

    commits.forEach((commit, index) => {
      const x = PADDING_LEFT + columns[commit.oid] * COL_WIDTH;
      const y = PADDING_TOP + index * ROW_HEIGHT;
      
      // Determine node type
      const isMerge = commit.parents.length > 1;
      const nodeSize = isMerge ? 10 : 6; 
      
      nodePositions.current.push({ oid: commit.oid, x, y, radius: nodeSize });

      const isCurrentBranch = currentBranchOids.current.has(commit.oid);
      // Use the column index to determine color, so the whole "lane" has the same color
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
          
          // Improved Bezier for "Metro Map" style
          // If same column, straight line
          if (columns[commit.oid] === parentCol) {
              ctx.lineTo(parentX, parentY);
          } else {
              // Curve
              ctx.bezierCurveTo(x, y + ROW_HEIGHT / 2, parentX, parentY - ROW_HEIGHT / 2, parentX, parentY);
          }
          
          const isParentOnCurrent = currentBranchOids.current.has(parentOid);
          if (isCurrentBranch && isParentOnCurrent && pIdx === 0) {
              ctx.strokeStyle = "#e74c3c";
              ctx.lineWidth = 3;
          } else {
              if (pIdx === 0) {
                  // Primary parent connection: use current node's color
                  ctx.strokeStyle = getBranchColor(columns[commit.oid]);
              } else {
                  // Merge connection: use the parent's color (the branch being merged in)
                  ctx.strokeStyle = getBranchColor(columns[parentOid]);
              }
              ctx.lineWidth = 2;
          }
          
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
      if (isMerge) {
          ctx.rect(x - nodeSize/2, y - nodeSize/2, nodeSize, nodeSize);
      } else {
          ctx.arc(x, y, nodeSize, 0, 2 * Math.PI);
      }
      
      ctx.fillStyle = nodeColor;
      ctx.fill();
      
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
      
      const isHead = commit.refs.some(r => r.kind === "HEAD");
      if (isHead) {
          ctx.beginPath();
          if (isMerge) {
              ctx.rect(x - nodeSize/2 - 3, y - nodeSize/2 - 3, nodeSize + 6, nodeSize + 6);
          } else {
              ctx.arc(x, y, nodeSize + 3, 0, 2 * Math.PI);
          }
          ctx.strokeStyle = "#e74c3c"; 
          ctx.lineWidth = 2;
          ctx.stroke();
      }
      
      if (hoveredCommit && hoveredCommit.oid === commit.oid) {
          ctx.beginPath();
          if (isMerge) {
              ctx.rect(x - nodeSize/2, y - nodeSize/2, nodeSize, nodeSize);
          } else {
              ctx.arc(x, y, nodeSize, 0, 2 * Math.PI);
          }
          ctx.strokeStyle = "#333";
          ctx.lineWidth = 2;
          ctx.stroke();
      }
      
      // Draw refs
      let textOffset = 15;
      
      const sortedRefs = [...commit.refs].sort((a, b) => {
          const order = { "HEAD": 0, "branch": 1, "remote": 2, "tag": 3, "other": 4 };
          return (order[a.kind as keyof typeof order] || 4) - (order[b.kind as keyof typeof order] || 4);
      });

      sortedRefs.forEach(ref => {
        ctx.font = "bold 11px Inter, sans-serif";
        const textMetrics = ctx.measureText(ref.name);
        const textWidth = textMetrics.width;
        const padding = 6;
        
        ctx.fillStyle = getRefColor(ref.kind);
        roundRect(ctx, x + textOffset, y - 10, textWidth + padding * 2, 20, 4);
        ctx.fill();
        
        ctx.fillStyle = ref.kind === "tag" ? "#333" : "white";
        ctx.fillText(ref.name, x + textOffset + padding, y + 4);
        
        textOffset += textWidth + padding * 2 + 8;
      });

      // Draw message
      ctx.fillStyle = "#333";
      ctx.font = "14px Inter, sans-serif";
      const message = commit.message.split('\n')[0];
      ctx.fillText(message, x + textOffset + 10, y + 5);
      
      // Draw author and date
      const dateStr = new Date(commit.date * 1000).toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const authorStr = commit.author;
      
      const rightMargin = 20;
      const canvasWidthCss = rect.width;
      
      ctx.font = "12px Inter, sans-serif";
      ctx.fillStyle = "#666";
      
      const dateWidth = ctx.measureText(dateStr).width;
      const authorWidth = ctx.measureText(authorStr).width;
      
      ctx.fillText(dateStr, canvasWidthCss - rightMargin - dateWidth, y + 5);
      
      ctx.fillStyle = "#444";
      ctx.font = "bold 12px Inter, sans-serif";
      ctx.fillText(authorStr, canvasWidthCss - rightMargin - dateWidth - authorWidth - 20, y + 5);
    });
  }

  function drawTopology() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Enable high DPI rendering
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;

      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      // Filter for "interesting" commits (Refs, Roots)
      // Removed Merges (c.parents.length > 1) from filter as requested
      const interestingCommits = commits.filter(c => 
          c.refs.length > 0 || c.parents.length === 0
      );
      
      // Build a map for fast lookup
      const commitMap = new Map(commits.map(c => [c.oid, c]));
      
      // For each interesting commit, find its nearest interesting ancestors
      const simplifiedEdges: { from: string, to: string, distance: number }[] = [];
      
      interestingCommits.forEach(commit => {
          commit.parents.forEach(parentOid => {
              let runner = parentOid;
              let distance = 1;
              let seen = new Set<string>();
              
              while (true) {
                  if (seen.has(runner)) break;
                  seen.add(runner);
                  
                  const ancestor = commitMap.get(runner);
                  if (!ancestor) break; 
                  
                  // Check if ancestor is interesting
                  // Must match the filter above!
                  if (ancestor.refs.length > 0 || ancestor.parents.length === 0) {
                      simplifiedEdges.push({ from: commit.oid, to: runner, distance });
                      break;
                  }
                  
                  if (ancestor.parents.length === 0) break;
                  runner = ancestor.parents[0]; 
                  distance++;
              }
          });
      });
      
      // Layout Logic for Topology
      // We can reuse the column logic but with the filtered list
      const ROW_HEIGHT = 80; // Larger for topology
      const COL_WIDTH = 180; // Wider columns for labels
      const PADDING_TOP = 40;
      const PADDING_LEFT = 40;
      
      const columns: { [oid: string]: number } = {};
      const activeLanes: (string | null)[] = [];
      const rowIndex: { [oid: string]: number } = {};
      
      interestingCommits.forEach((c, i) => rowIndex[c.oid] = i);
      nodePositions.current = [];
      
      interestingCommits.forEach((commit) => {
          let col = -1;
          const existingLaneIndex = activeLanes.indexOf(commit.oid);
          
          if (existingLaneIndex !== -1) {
              col = existingLaneIndex;
              activeLanes[existingLaneIndex] = null;
          } else {
              col = activeLanes.indexOf(null);
              if (col === -1) {
                  col = activeLanes.length;
                  activeLanes.push(null);
              }
          }
          columns[commit.oid] = col;
          
          // Find edges from this commit
          const edges = simplifiedEdges.filter(e => e.from === commit.oid);
          edges.forEach((edge, idx) => {
              if (idx === 0) {
                  if (activeLanes[col] === null) {
                      activeLanes[col] = edge.to;
                  }
              } else {
                  const existingParentLane = activeLanes.indexOf(edge.to);
                  if (existingParentLane === -1) {
                      let freeCol = activeLanes.indexOf(null);
                      if (freeCol === -1) {
                          freeCol = activeLanes.length;
                          activeLanes.push(null);
                      }
                      activeLanes[freeCol] = edge.to;
                  }
              }
          });
      });

      // Calculate required dimensions
      const totalHeight = (interestingCommits.length + 1) * ROW_HEIGHT + PADDING_TOP;
      const maxCol = Math.max(...Object.values(columns), 0);
      const totalWidth = (maxCol + 1) * COL_WIDTH + PADDING_LEFT + 200; // Extra padding for labels

      // Update canvas style size to allow scrolling
      if (canvas.style.height !== `${totalHeight}px`) {
          canvas.style.height = `${totalHeight}px`;
      }
      if (canvas.style.width !== `${totalWidth}px`) {
          canvas.style.width = `${totalWidth}px`;
      }

      // Update internal resolution if needed
      if (canvas.width !== totalWidth * dpr || canvas.height !== totalHeight * dpr) {
          canvas.width = totalWidth * dpr;
          canvas.height = totalHeight * dpr;
          // After resizing, context is reset, so we need to scale again and redraw
          ctx.scale(dpr, dpr);
      } else {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // Reset transform to identity * dpr
          ctx.clearRect(0, 0, totalWidth, totalHeight);
      }

      // Draw Edges
      simplifiedEdges.forEach(edge => {
          const fromIdx = rowIndex[edge.from];
          const toIdx = rowIndex[edge.to];
          
          if (fromIdx !== undefined && toIdx !== undefined) {
              const fromCol = columns[edge.from];
              const toCol = columns[edge.to];
              
              const x1 = PADDING_LEFT + fromCol * COL_WIDTH + 10; // Center of node
              const y1 = PADDING_TOP + fromIdx * ROW_HEIGHT;
              const x2 = PADDING_LEFT + toCol * COL_WIDTH + 10;
              const y2 = PADDING_TOP + toIdx * ROW_HEIGHT;
              
              ctx.beginPath();
              ctx.moveTo(x1, y1);
              
              if (fromCol === toCol) {
                  ctx.lineTo(x2, y2);
              } else {
                  ctx.bezierCurveTo(x1, y1 + ROW_HEIGHT/2, x2, y2 - ROW_HEIGHT/2, x2, y2);
              }
              
              ctx.strokeStyle = getBranchColor(toCol);
              ctx.lineWidth = 2;
              
              if (edge.distance > 1) {
                  ctx.setLineDash([5, 5]);
              } else {
                  ctx.setLineDash([]);
              }
              ctx.stroke();
              ctx.setLineDash([]);
          }
      });

      // Draw Nodes
      interestingCommits.forEach((commit, index) => {
          const col = columns[commit.oid];
          const x = PADDING_LEFT + col * COL_WIDTH;
          const y = PADDING_TOP + index * ROW_HEIGHT;
          
          nodePositions.current.push({ oid: commit.oid, x: x + 10, y, radius: 15 });
          
          // Draw Box
          const boxWidth = 150;
          const boxHeight = 40;
          
          ctx.fillStyle = "white";
          ctx.strokeStyle = getBranchColor(col);
          ctx.lineWidth = 2;
          
          // Draw a pill or box
          roundRect(ctx, x - 10, y - boxHeight/2, boxWidth, boxHeight, 6);
          ctx.fill();
          ctx.stroke();
          
          // Draw Text
          ctx.fillStyle = "#333";
          ctx.font = "bold 12px Inter, sans-serif";
          
          let label = "";
          if (commit.refs.length > 0) {
              // Show branch name
              label = commit.refs[0].name;
          } else if (commit.parents.length > 1) {
              label = "Merge";
          } else {
              label = commit.oid.substring(0, 7);
          }
          
          // Truncate label if too long
          if (label.length > 20) {
              label = label.substring(0, 17) + "...";
          }
          
          ctx.fillText(label, x, y + 4);
          
          // Draw Ref badges if multiple
          if (commit.refs.length > 1) {
              ctx.font = "10px Inter, sans-serif";
              ctx.fillStyle = "#666";
              ctx.fillText(`+${commit.refs.length - 1}`, x + boxWidth - 30, y + 4);
          }
      });
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function getBranchColor(colIndex: number) {
    const colors = ["#2ecc71", "#3498db", "#9b59b6", "#f1c40f", "#e67e22", "#1abc9c"];
    return colors[colIndex % colors.length];
  }

  function getRefColor(kind: string) {
    switch (kind) {
      case "HEAD": return "#e74c3c"; // Red
      case "branch": return "#27ae60"; // Green
      case "remote": return "#8e44ad"; // Purple
      case "tag": return "#f39c12"; // Orange/Yellow
      default: return "#7f8c8d";
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Adjust hit detection based on view mode
      // const ROW_HEIGHT = viewMode === 'topology' ? 80 : 50;
      // const PADDING_TOP = viewMode === 'topology' ? 40 : 30;
      
      // Use nodePositions which is updated by both draw functions
      // But we need to be careful about the index approximation
      
      // Simple distance check for all nodes (since we have < 2000 usually)
      let found = null;
      let minDist = Infinity;
      
      // Optimization: only check nodes in visible range?
      // For now, iterate all.
      for (const pos of nodePositions.current) {
          const dx = x - pos.x;
          const dy = y - pos.y;
          const dist = dx*dx + dy*dy;
          // Radius depends on view mode, but stored in pos
          if (dist <= (pos.radius + 5) * (pos.radius + 5)) {
              if (dist < minDist) {
                  minDist = dist;
                  // Find commit info
                  found = commits.find(c => c.oid === pos.oid) || null;
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
                <div style={{display: 'flex', gap: '10px', alignItems: 'center'}}>
                    <button onClick={() => {
                        const repo = repos.find(r => r.id === selectedRepoId);
                        if (repo) loadCommits(repo.path);
                    }}>Refresh</button>
                    
                    <div className="view-toggle">
                        <button 
                            className={viewMode === 'history' ? 'active' : ''} 
                            onClick={() => setViewMode('history')}
                        >
                            History
                        </button>
                        <button 
                            className={viewMode === 'topology' ? 'active' : ''} 
                            onClick={() => setViewMode('topology')}
                        >
                            Topology
                        </button>
                    </div>
                </div>
                <span style={{marginLeft: '10px', fontSize: '0.9em', color: '#666'}}>
                    {commits.length} commits loaded
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
