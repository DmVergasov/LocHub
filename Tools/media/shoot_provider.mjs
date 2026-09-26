// Shared provider/model choice for the shoot pipeline: both Tools/media/shoot.mjs (starts the shoot service
// with these flags) and Tools/media/demo_project.ts (records translations with a matching JobOptions.
// translateModel/judgeModel) must agree, or the demo's own recorded provenance ("ai:<model>+<promptVersion>",
// Service/src/job.ts) would show a different model than the running service's own header
// ("AI: <Provider> · <translateModel> / <judgeModel>", Web/src/App.tsx) — a single source of truth avoids that.
//
// Non-Anthropic: its job-cost estimate never calls the network (AnthropicLlmClient.countInputTokens calls the
// real /v1/messages/count_tokens endpoint; every other provider's estimate is purely local, approxInputTokens
// in Service/src/llmShared.ts). Any provider here works; deepseek is picked because Service/src/estimate.ts
// already prices its models.
export const SHOOT_PROVIDER = {
  provider: 'deepseek',
  translateModel: 'deepseek-v4-pro',
  judgeModel: 'deepseek-flash',
  // The service reads the key only from LOCHUB_API_KEY, which the editor sets for the service process it spawns.
  keyVar: 'LOCHUB_API_KEY',
};
