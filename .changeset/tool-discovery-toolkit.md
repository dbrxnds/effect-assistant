---
"effect-assistant": minor
---

`ToolDiscovery` is back as a module, and native: `ToolDiscovery.make(catalog)` returns a toolkit (`search_tools` and `execute_tool`) to merge with yours, and its handlers' layer, which needs the catalog's handlers. What the catalog's tools use at call time is `execute_tool`'s requirement, so the turn provides it as for any tool. A tool run through `execute_tool` gets a call id made from that call's, stable when a crash runs it again.

Breaking: the loop's `catalog` option is gone; use `toolkit: Toolkit.merge(MyTools, ToolDiscovery.make(Catalog).toolkit)` and provide its `layer`.
