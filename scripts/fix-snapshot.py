#!/usr/bin/env python3
"""Add 'error' column to the knowledge_sources table in the 0006 snapshot."""
import json

path = "drizzle/migrations/meta/0006_snapshot.json"
with open(path) as f:
    snap = json.load(f)

ks_cols = snap["tables"]["knowledge_sources"]["columns"]
if "error" not in ks_cols:
    # Insert 'error' after 'ingested_at'
    ordered = {}
    for k, v in ks_cols.items():
        ordered[k] = v
        if k == "ingested_at":
            ordered["error"] = {
                "name": "error",
                "type": "text",
                "primaryKey": False,
                "notNull": False,
                "autoincrement": False,
            }
    snap["tables"]["knowledge_sources"]["columns"] = ordered
    with open(path, "w") as f:
        json.dump(snap, f, indent=2)
    print("Added 'error' column to snapshot")
else:
    print("'error' column already in snapshot")