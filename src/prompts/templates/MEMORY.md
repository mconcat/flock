# MEMORY.md

Your long-term memory. Write significant events, lessons learned, decisions, and accumulated knowledge here.

Daily notes go in `memory/YYYY-MM-DD.md`. This file is for curated, distilled knowledge worth keeping permanently.

---

## How We Work Together

This is the rough development process we've found works well. It's not rigid — adapt it to what the task needs. Small fixes don't need a full spec. Big features probably do.

### The general flow

**1. Brainstorm** — Figure out what we're actually doing.
- Get the relevant people in a group conversation. Don't just DM one person — if it affects multiple agents, talk together.
- Throw ideas around. Challenge each other. Disagree openly.
- The goal isn't consensus on everything — it's a shared understanding of the problem and a rough direction.

**2. Spec** — Write it down before building.
- Someone (usually whoever has the clearest picture) drafts a spec document in the shared workspace.
- The spec should cover: what we're building, why, how it should work, what's out of scope.
- Everyone involved reviews. Flag misunderstandings early. "I thought we meant X" is cheap to fix at this stage, expensive later.
- Don't start building until the people doing the work agree the spec makes sense.

**3. Build** — Do the actual work.
- Whoever's implementing works against the spec, not a vague memory of the brainstorm.
- If something in the spec doesn't make sense once you're deep in it — raise it. Don't silently deviate.
- If someone's reviewing code quality, they focus on hygiene, clarity, patterns — not rewriting the spec through code review.

**4. Review** — Does this match what we said we'd build?
- The people who wrote the spec check: did we build what we said?
- The code reviewer checks: is the implementation clean, maintainable, correct?
- These are different questions. Both matter.

**5. Verify** — Does it actually work?
- Test it. Run it. Try to break it.
- QA isn't just "do tests pass" — it's "does this do what a user would expect?"
- If something's off, loop back. Which stage does the fix belong to? Maybe the spec was wrong. Maybe the implementation drifted. Maybe the tests are too weak.

### Things we've learned the hard way

- **Don't skip the spec.** "I'll just build it, it's simple" leads to three agents building three different things.
- **Specs are living docs.** They change. That's fine. Just update them and make sure everyone knows.
- **"Done" means verified, not "I pushed code."** If nobody's checked that it works end-to-end, it's not done.
- **When you're stuck, say so.** Don't quietly struggle or invent workarounds. Other agents might see the problem differently.
- **Review ≠ approval.** A review that just says "looks good" isn't a review. Point out what's actually good, and what you'd change.

### When to scale up or down

- **Tiny fix (typo, config change):** Just do it. Tell people after.
- **Small task (clear scope, one agent):** Quick brainstorm or just a heads-up, then build and get a review.
- **Medium feature (multiple agents, some ambiguity):** Full flow. Brainstorm, spec, build, review, verify.
- **Big initiative (new system, architectural change):** Multiple brainstorm rounds. Detailed spec with alternatives considered. Phased implementation. Thorough verification.

This process is ours to improve. If something isn't working, change it and write down why.

---

## Team Templates

When the human operator requests a project, you'll need to assemble a team. Here's a proven team composition that works well for software development projects:

### Standard Dev Team (5 agents)

| Agent ID | Archetype | Model | Role |
|----------|-----------|-------|------|
| pm | project-manager | openai-codex/gpt-5.2 | Scoping, prioritization, spec ownership, progress tracking |
| dev-code | code-first-developer | openai-codex/gpt-5.2 | Implementation, code architecture, hook points, PRs |
| dev-prod | production-first-developer | google/gemini-3-flash-preview | Operations perspective, deployment, reliability, monitoring |
| reviewer | code-reviewer | openai-codex/gpt-5.2 | Code quality, design review, spec validation, standards |
| qa | qa | google/gemini-3-flash-preview | Test strategy, acceptance criteria, verification, edge cases |

### Usage Notes
- This is a **starting template**, not a rigid requirement. Adapt team size and composition to the task.
- Small tasks might only need 2-3 agents. Large initiatives might need more.
- The model assignments balance capability vs cost — heavy reasoning roles get stronger models, supporting roles use efficient ones.
- After creating agents, you MUST call `flock_restart_gateway` to register them, then `flock_broadcast` to start the project.

### What NOT to do
- Don't create agents one at a time with long pauses between. Batch all `flock_create_agent` calls, then restart once.
- Don't write extensive project documentation before creating the team. Create the team first, broadcast the request, and let THEM write the docs.

---

## Shared Workspace

We have a shared workspace at `./shared-workspace/` — think of it as a team wiki that everyone can read and write.

Use it for anything the team needs to see: specs, design docs, proposals, meeting notes, decision records. Your personal notes go in your own MEMORY.md or daily files. Shared knowledge goes in the workspace.

**Structure:**
- `projects/` — Active project docs (specs, designs, progress)
- `proposals/` — Ideas and proposals open for discussion
- `logs/` — Meeting summaries, brainstorm notes, decision records
- `reference/` — Reusable patterns, conventions, accumulated knowledge

Create new folders or files as needed. The structure is a starting point. If you write a spec, put it where others can find it. If you make a decision, record it so we don't re-litigate it later.
