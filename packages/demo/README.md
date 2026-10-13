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
- `shared/src/AcmeAssistant.ts`: the assistant's definition, shared with the web app, which folds the
  chat's view with it (`ChatView.apply(AcmeAssistant)`). `shared/src/Research.ts` is its specialist's.
- `api/src/Acme.ts`: the assistant's instructions, skills, tools, and model (`ACME_MODEL`).
- `api/src/Prompts.ts`: the prompts, from Langfuse (label `production`), with defaults in code.
  `pnpm --filter @acme/demo-api prompts:push` uploads the defaults.
- `api/src/Tools.ts`: order history and status, offices, budgets, and the `research` specialist.
- `shared/src/Blocks.ts`: the UI blocks, including `order_draft` and `campaign_draft`: an order
  or campaign the assistant prepared, which only the user places, with the block's button.
- `api/src/Campaign.ts`: the campaign products, `start` (what the campaign block's button runs
  through the `StartCampaign` RPC), and the `CreateCampaign` workflow.
- `api/src/PrintOrders.ts`: `quote_order`, which the assistant uses to tell the user the total,
  `place` (what the order block's button runs through the `PlaceOrder` RPC), and the `PrintOrder`
  workflow.
- `shared/src/OrderPlaced.ts`: what the API tells the chat when the user places an order or starts a
  campaign, one of Acme's own events: the API submits it, so it wakes a turn, and Acme follows up with
  the reference.
- `shared/src/WorkflowStep.ts`: a workflow's step, one of Acme's own events: the workflow submits it, so
  it wakes a turn, and the model reads it as a `<workflow>` update (Acme's history view in
  `api/src/Acme.ts` maps both events to notes).
- `api/src/Steps.ts`: what the workflows share: reporting a step to the chat, and durable waits at
  demo pace.
- `api/src/LiveOrders.ts`: orders placed through Acme, kept up to date by the workflows.
- `api/src/Chats.ts`: the thread list. Deleting a thread deletes its chat (the assistant's `delete`).
- `api/src/Server.ts`: `/health`, `/rpc`, and the web app. `Subscribe` streams the chat's view
  (the assistant's `subscribe`, without Acme's own events, piped through `ChatView.updates`): what the user sees, never
  the assistant's own work.
- `api/src/main.ts`: wires it together on Postgres (`DATABASE_URL`) or in memory.
- `api/scripts/smoke.ts`: an end-to-end check against a running server. It deletes the chats it
  creates.

## Pace

One workflow step is `DEMO_STEP_SECONDS` (default 10). At that pace:

- a print order goes confirmed → printing → shipped → delivered in about a minute;
- a campaign goes creative → scheduled → live → first results about a minute after it starts.

Research lookups take `DEMO_LOOKUP_SECONDS` each (default 3), so a report runs for 30 seconds
or so while the chat stays free.

## A demo script

The empty thread shows these as suggestions:

1. **"Order 300 cotton tote bags for the Berlin office"**. Acme shows the order, with its total
   and the budget left, and a Place order button. Click it, and the order is placed: Acme
   follows up with the reference. Then, without anyone asking, the chat hears it has shipped
   (with a UPS tracking number) and been delivered.
2. **"Where is the Amsterdam office?"**. Acme returns the address, locale, and contact from the
   demo data.
3. **"How much budget does Amsterdam have left this quarter?"**. Ask again after an order, and
   the order counts.
4. **"I want to run a campaign for the London office"**. Acme offers campaign types as
   buttons, and asks for the audience and budget. Then it shows the campaign with a Start
   campaign button. Click it, and the campaign moves on: creative, scheduled, live, first
   results.
5. **"Have research compare this year's campaigns and suggest Q4 budgets"**. The research
   specialist runs in the background. Keep chatting meanwhile; the report arrives when it's
   done.
6. **"Where's the New York tote bag order?"**. It's shipped, with a tracking number.

Things worth trying along the way: interrupt a long answer with a new message, ask for an
order over budget, or ask for a product that isn't in the catalog.
