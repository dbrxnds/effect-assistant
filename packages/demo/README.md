# Acme demo

Acme is a marketing assistant for a company with eight offices. Offices order
campaigns and branded products, track orders, check their quarterly budget, and
ask for reports.

## Files

- `shared/src`: the demo data, shared with the web app:
  - `Locations`: the eight offices;
  - `Products`: the branded product catalog;
  - `Orders`: a year of campaign and product orders;
  - `Budgets`: quarterly budgets per office;
  - `Performance`: campaign results.
- `api/src/Acme.ts`: the assistant's instructions, skills, tools, and model (`ACME_MODEL`).
- `api/src/Prompts.ts`: the prompts, from Langfuse (label `production`), with defaults in code.
  `pnpm --filter @acme/demo-api prompts:push` uploads the defaults.
- `api/src/Tools.ts`: order history and status, offices, budgets, and the `research` specialist.
- `api/src/Campaign.ts`: `start_campaign`, which waits for the user's decision, and the
  `CreateCampaign` workflow.
- `api/src/PrintOrders.ts`: `quote_order`, which the assistant uses to tell the user the total,
  `order_products`, which waits for the user's decision, and the `PrintOrder` workflow.
- `api/src/WorkflowStep.ts`: a workflow's step, one of Acme's own events: it wakes a turn, and the
  model reads it as a `<workflow>` update.
- `api/src/Steps.ts`: what the workflows share: reporting a step to the chat, and durable waits at
  demo pace.
- `api/src/LiveOrders.ts`: orders placed through Acme, kept up to date by the workflows.
- `api/src/Chats.ts`: the thread list. Deleting a thread deletes its chat (`AcmeAssistant.delete`).
- `api/src/Server.ts`: `/health`, `/rpc`, and the web app. `Subscribe` streams the chat's view
  (`AcmeAssistant.subscribeView`): what the user sees, never the assistant's own work.
- `api/src/main.ts`: wires it together on Postgres (`DATABASE_URL`) or in memory.
- `api/scripts/smoke.ts`: an end-to-end check against a running server. It deletes the chats it
  creates.

## Pace

One workflow step is `DEMO_STEP_SECONDS` (default 10). At that pace:

- a print order goes confirmed → printing → shipped → delivered in about a minute;
- a campaign goes creative → scheduled → live → first results about a minute after approval.

Research lookups take `DEMO_LOOKUP_SECONDS` each (default 3), so a report runs for 30 seconds
or so while the chat stays free.

## A demo script

The empty thread shows these as suggestions:

1. **"Order 300 cotton tote bags for the Berlin office"**. Acme asks you to approve the order,
   with its total and the budget left. Approve it, and the order is placed. Then, without anyone
   asking, the chat hears it has shipped (with a UPS tracking number) and been delivered.
2. **"Where is the Amsterdam office?"**. Acme returns the address, locale, and contact from the
   demo data.
3. **"How much budget does Amsterdam have left this quarter?"**. Ask again after an order, and
   the order counts.
4. **"I want to run a campaign for the London office"**. Acme offers campaign types as
   buttons, and asks for the audience and budget. Starting it waits for your decision, and Acme
   shows it with Approve / Decline. Approve, and the campaign moves on:
   creative, scheduled, live, first results.
5. **"Have research compare this year's campaigns and suggest Q4 budgets"**. The research
   specialist runs in the background. Keep chatting meanwhile; the report arrives when it's
   done.
6. **"Where's the New York tote bag order?"**. It's shipped, with a tracking number.

Things worth trying along the way: interrupt a long answer with a new message, ask for an
order over budget, or ask for a product that isn't in the catalog.
