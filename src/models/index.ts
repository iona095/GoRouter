/**
 * Slice A — public barrel for src/models/*
 * Slice B — re-export DSH sync surface (isolated, does not alter Slice A semantics).
 */
export * from "./types.ts";
export * from "./registry.ts";
export * from "./fetcher.ts";
export * from "./diff.ts";
export * from "./refresh.ts";
export * from "./dsh-types.ts";
export * from "./dsh-client.ts";
export * from "./dsh-eligibility.ts";
export * from "./dsh-sync.ts";
export * from "./dsh-sync-state.ts";
export * from "./dsh-approvals.ts";
export * from "./dsh-binding.ts";
export * from "./dsh-migration.ts";
