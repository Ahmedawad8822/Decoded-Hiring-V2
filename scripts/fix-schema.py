#!/usr/bin/env python3
"""Fix literal \\n characters in schema.ts introduced by a bad patch."""
import re

path = "src/lib/db/schema.ts"
with open(path, "r") as f:
    content = f.read()

# Replace literal backslash-n sequences with actual newlines
content = content.replace("\\n\\n", "\n\n")
content = content.replace("\\n", "\n")

with open(path, "w") as f:
    f.write(content)

# Verify
with open(path, "r") as f:
    lines = f.readlines()

for i, line in enumerate(lines[280:295], start=281):
    print(f"{i}: {line}", end="")
