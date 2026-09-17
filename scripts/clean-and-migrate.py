#!/usr/bin/env python3
"""Clean D1 state and re-apply migrations from scratch."""
import shutil
import subprocess
from pathlib import Path

base = Path("/Users/ahmedelrashidy/Documents/ChatGPT/Decoded Hiring V2/.worktrees/t_cbbe1207")
d1_dir = base / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"

if d1_dir.exists():
    shutil.rmtree(d1_dir)
    print(f"Deleted {d1_dir}")
else:
    print(f"Already clean: {d1_dir}")

# Re-run migration
result = subprocess.run(
    ["scripts/_diagnose.ts"],
    capture_output=False,
    cwd=str(base),
)
print(f"\nMigration exit code: {result.returncode}")