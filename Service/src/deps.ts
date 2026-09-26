// The only runtime npm imports of the service. The release bundle turns this module into
// Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs (Fab 4.3.7.3.d: third-party code lives in Source/ThirdParty);
// any other npm import in src/ fails the bundle (scripts/bundle.mjs). Type-only imports may still name the packages.
export { default as Fastify } from 'fastify';
export { default as Anthropic } from '@anthropic-ai/sdk';
