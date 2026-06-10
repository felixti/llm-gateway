# Graphify Artifacts

Generated knowledge graph of the LLM Gateway codebase.

## Files

- **GRAPH_REPORT.md** — Audit report with god nodes, surprising connections, and community analysis
- **graph.html** — Interactive graph visualization (open in browser)
- **graph.json** — Raw graph data for programmatic queries
- **cost.json** — Token cost tracking for graph generation

## Regenerating

To rebuild from current codebase:

```bash
/graphify .
```

Or update incrementally:

```bash
/graphify . --update
```

## Generated

- Date: $(date -u +%Y-%m-%d)
- Corpus: 309 files, ~184K words
- Nodes: 1,589 | Edges: 2,516 | Communities: 223
