import { defineConfig } from "vitepress"

const modules = [
  "AppEvent",
  "Assistant",
  "AssistantActivity",
  "AssistantChat",
  "AssistantEngine",
  "AssistantEvent",
  "ChatLog",
  "ChatView",
  "AssistantLoop",
  "Block",
  "BlockKit",
  "Decision",
  "Instructions",
  "Skill",
  "Specialist",
  "ToolDiscovery",
  "ToolFailure",
  "ChatId",
  "DecisionId",
  "InputId",
  "RunId"
]

export default defineConfig({
  title: "effect-assistant",
  description: "A colleague assistant on Effect",
  // The demo server serves the built docs at /docs.
  base: "/docs/",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "API", link: "/api/" }
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Start",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Scope and non-goals", link: "/guide/scope" }
          ]
        },
        {
          text: "Core concepts",
          items: [
            { text: "Assistants and handlers", link: "/guide/assistant" },
            { text: "Turns", link: "/guide/turns" },
            { text: "The event log", link: "/guide/events" },
            { text: "Engines", link: "/guide/engines" }
          ]
        },
        {
          text: "Building an assistant",
          items: [
            { text: "Tools", link: "/guide/tools" },
            { text: "Chats and users", link: "/guide/chats" },
            { text: "Your own events and background work", link: "/guide/app-events" },
            { text: "Specialists", link: "/guide/specialists" },
            { text: "Skills", link: "/guide/skills" },
            { text: "UI blocks", link: "/guide/blocks" },
            { text: "Decisions", link: "/guide/decisions" },
            { text: "The chat client", link: "/guide/client" },
            { text: "Compaction", link: "/guide/compaction" },
            { text: "Instructions and prompts", link: "/guide/instructions" }
          ]
        },
        {
          text: "Operating",
          items: [
            { text: "Deploying", link: "/guide/deploying" },
            { text: "Observability", link: "/guide/observability" },
            { text: "Testing", link: "/guide/testing" }
          ]
        },
        {
          text: "Advanced",
          items: [{ text: "Custom loops", link: "/guide/loops" }]
        }
      ],
      "/api/": [
        {
          text: "API reference",
          items: [{ text: "Overview", link: "/api/" }, ...modules.map((m) => ({ text: m, link: `/api/${m}` }))]
        }
      ]
    },
    outline: { level: [2, 3] },
    search: { provider: "local" }
  }
})
