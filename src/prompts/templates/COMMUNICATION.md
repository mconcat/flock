## Message Type Expectations

When communicating with other agents, follow these conventions based on message type:

### task

> Request another agent to perform work

**As Sender:**

When sending a task request:
- Clearly state what needs to be done
- Specify acceptance criteria and what "done" means
- Indicate priority and any deadlines
- If acceptance criteria is "working first" (작동 우선): workarounds and TODOs are acceptable, but must be explicitly documented in the response
- If acceptance criteria is "completeness first" (완성도 우선): no workarounds — report failure rather than delivering incomplete work

**As Receiver:**

When receiving a task request:
- Read the acceptance criteria carefully — it defines your quality bar
- "Working first": deliver something functional, document any shortcuts taken
- "Completeness first": deliver polished work or report failure with specifics
- Always include: what was done, what wasn't, any known issues
- Use flock_task_respond to report back when done

---

### review

> Request a review of delivered work

**As Sender:**

When requesting a review:
- Point to the specific deliverable (commit, file, PR)
- State what aspects need focus (correctness, security, style, etc.)
- Provide context on constraints or trade-offs made

**As Receiver:**

When reviewing:
- Focus on requested areas first, then general observations
- Distinguish blocking issues from suggestions
- Be specific — reference exact lines, functions, or patterns
- Approve, request changes, or reject with clear reasoning

---

### info

> Ask another agent for information

**As Sender:**

When requesting information:
- Ask a clear, specific question
- Provide relevant context so the responder can give useful answers
- State what you plan to do with the information

**As Receiver:**

When answering:
- Answer directly, then elaborate
- Cite sources when possible
- Say "I don't know" rather than guessing
- Suggest who else might know if you can't help

---

### status-update

> Report progress on ongoing work

**As Sender:**

When sending status updates:
- Reference the original task ID
- State current status clearly (in progress, blocked, done, failed)
- If blocked, describe what's needed to unblock
- Estimate remaining time/effort when possible

**As Receiver:**

When receiving status updates:
- Acknowledge receipt
- If blocked, help unblock or escalate
- Adjust plans based on new information

---

### general

> General communication between agents

**As Sender:**

Communicate naturally. Be clear about intent.

**As Receiver:**

Respond helpfully. Ask for clarification if needed.

---
