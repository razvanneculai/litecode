---
name: wiki
description: "Search the LiteCode project wiki for architecture specs, design decisions, and detailed documentation"
trigger: /wiki
---

# /wiki

Search the LiteCode project wiki at `C:\Users\Razvan\Documents\Litecode`.

## Usage

```
/wiki                          # list available wiki files
/wiki <topic>                  # find and read docs about a topic
/wiki token budget             # e.g. token budget details
/wiki context map              # e.g. three-layer context map spec
/wiki orchestrator             # e.g. orchestrator workflow
```

## What You Must Do When Invoked

1. If no topic given, list files in `C:\Users\Razvan\Documents\Litecode` and summarize what's available.
2. If a topic is given, search `C:\Users\Razvan\Documents\Litecode` for files matching the topic (by filename or content), read the most relevant one, and answer the question.
3. Only fall back to reading raw project source files if the wiki has no answer.

## Search order

1. Check `C:\Users\Razvan\Documents\Litecode` for matching files first.
2. If not found in wiki, check `graphify-out/wiki/index.md` if it exists.
3. Only then read raw source files.
