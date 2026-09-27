// Shared Length Check setup for the shoot pipeline: Tools/media/demo_project.ts runs its translation jobs with
// SHOOT_LENGTH_CHECK.config (JobOptions.lengthCheck) and Tools/media/shoot.mjs starts the shoot service with
// SHOOT_LENGTH_CHECK.args, so the bands the demo stored and the live check every card runs agree. Both are the Project
// Settings defaults (Length Check on, UI strings, Warning, ratio 1.3, 4 extra characters, Tell the Translator on) --
// what a fresh project gets. `args` joined with spaces is exactly what the service reports as /api/health ai.lengthArgs.
export const SHOOT_LENGTH_CHECK = {
  config: { mode: 'warning', scope: 'ui', ratio: 1.3, extra: 4, ratios: {}, hint: true },
  args: ['--length-check', 'warning', '--length-scope', 'ui', '--length-ratio', '1.30', '--length-extra', '4', '--length-hint', 'on'],
};
