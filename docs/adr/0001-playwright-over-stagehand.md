# Drive the hosted browser with Playwright, not Stagehand

`ScoutAgent` and `HarvestAgent` call OpenRouter through Effect `LanguageModel` (`OpenRouterAgentLanguageModelLive`). Browser act grounding and recipe induction use `OpenRouterGroundingLanguageModelLive`. Stagehand v4 only skips a custom LLM adapter if inference goes through Browserbase Model Gateway, which does not support OpenRouter. We dropped Stagehand and ground `act` with a structured Playwright action so all model traffic stays on OpenRouter and we never map token usage into Stagehand's ClientLLM shape.

## Considered Options

- Keep `stagehand.act` on Model Gateway while scout/harvest agents stay on OpenRouter — two bills and two model configs.
- Keep `Stagehand.create({ model: { generate } })` and map OpenRouter usage into Stagehand — the adapter we refused to maintain.
