# Relay

[![CI](https://github.com/jasonhulbert/relay/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jasonhulbert/relay/actions/workflows/ci.yml)

## What is Relay?

Relay is a standalone, terminal-based, multi-provider loop generator and orchestrator for software work. You specify verifiable outcomes instead of authoring step-by-step plans, and capable models decide how to reach them just in time. The plan becomes a loop the system runs and verifies on its own, handing work to Claude Code and Codex as interchangeable executor backends. The target is macOS only, with Windows a later second backend behind an adapter contract. The scale target is explicit: multi-codebase changes and large data jobs, run by a deep tree of orchestrators.

The core loop: the orchestrator is the loop, and it is a **code-owned state machine**, not an autonomous agent. Code owns the loop, the gates, and every `.relay/` write. The model is called only for discrete judgments. Orchestrators are disposable and hierarchical, with durable truth in `.relay/`. Done-ness is ruled by an independent cross-provider critic that sees evidence only. The spine language is one TypeScript codebase on Node, shipped as a single macOS binary via Node SEA, one OS process per active orchestrator, with MCP as the universal capability bus.

## Design Philosophy

**Don't depend on a model behaving well under pressure. Make the structure hold the truth, make the agents disposable, and author every durable record for the specific consumer whose correctness depends on it.**
