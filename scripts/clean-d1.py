#!/usr/bin/env python3
"""Clean D1 state for fresh migration."""
import shutil
from pathlib import Path

base = Path("/Users/ahmedelrashidy/Documents/ChatGPT/Decoded Hiring V2/.worktrees/t_cbbe1207")
d1_path = base / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"
if d1_path.exists():
    shutil.rmtree(d1_path)
    print("D1 state deleted")
else:
    print("No D1 state found")
