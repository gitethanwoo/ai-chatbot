# Mentioned Agents Plan

## Goal
Enable users to reference saved agents with `@slug` mentions inside the chat composer so each agent can process its own message segment and reply inline without overriding the main assistant.

## Guiding Principles
- Treat each `@agent` mention as an isolated request whose prompt, tools, and context remain scoped to that agent.
- Keep the base chat history human-readable; persist mention metadata separately for replay.
- Preserve UX fluidity: auto-complete agents, show progress placeholders, and stream agent responses with clear attribution.

## High-Level Tasks
1. Extend chat message schema/types to include structured agent mention parts while retaining raw text for display/search.
2. Update the composer to insert mention metadata when users select an agent via an inline picker.
3. Detect mention parts on the server, run the corresponding agent pipelines, and stream their outputs back into the chat with proper sequencing.
4. Render agent-attributed assistant bubbles and inline mention styling in the transcript.
5. Add analytics/hooks for future rate limiting or billing if needed.

## Open Questions / Follow-Up
- Parallel vs. sequential execution for multiple mentions in one message.
- How to handle errors or timeouts from agent runs (fallback text vs. retry controls).
- Whether to persist dedicated `AgentInvocation` records for observability.
