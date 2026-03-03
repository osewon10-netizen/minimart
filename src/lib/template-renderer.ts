/**
 * Render a ticket markdown from the template structure.
 * Does NOT read the TEMPLATE.md file — generates the markdown directly
 * from the known schema to avoid template parsing complexity.
 */
export function renderTicketMarkdown(fields: {
  id: string;
  author: string;
  created: string;
  service: string;
  summary: string;
  severity: string;
  failureClass: string;
  tags: string[];
  detectedVia: string;
  symptom: string;
  likelyCause: string;
  whereToLook: string[];
}): string {
  const whereLines = fields.whereToLook.map((w) => `- ${w}`).join("\n");
  const tagStr = fields.tags.join(", ");

  return `## **${fields.id}** · [${fields.service}] — ${fields.summary}

| Field | Value |
| --- | --- |
| **Ticket** | ${fields.id} |
| **Author** | ${fields.author} |
| **Created** | ${fields.created} |
| **Severity** | \`${fields.severity}\` |
| **Failure Class** | \`${fields.failureClass}\` |
| **Tags** | ${tagStr} |
| **Status** | \`open\` |
| **Outcome** | \`needs_followup\` |

---

## Detection

**Detected via:** ${fields.detectedVia}
**Symptom:** ${fields.symptom}
**Likely cause:** ${fields.likelyCause}
**Where to look:**

${whereLines}

### Evidence

<!-- To be filled by investigating agent -->

### Evidence Refs

<!-- optional on open, REQUIRED on patched/resolved -->

---

## Patch Notes
<!-- Filled by dev rig agent after fix is applied -->

---

## Verification
<!-- Filled by Mini agent after deploy -->
`;
}

/**
 * Render a patch suggestion markdown.
 */
export function renderPatchMarkdown(fields: {
  id: string;
  author: string;
  created: string;
  service: string;
  summary: string;
  priority: string;
  category: string;
  failureClass: string;
  tags: string[];
  whatToChange: string;
  why: string;
  whereToChange: string[];
}): string {
  const whereLines = fields.whereToChange.map((w) => `- ${w}`).join("\n");
  const tagStr = fields.tags.join(", ");

  return `## **${fields.id}** · [${fields.service}] — ${fields.summary}

| Field | Value |
|-------|-------|
| **Patch** | ${fields.id} |
| **Author** | ${fields.author} |
| **Created** | ${fields.created} |
| **Priority** | \`${fields.priority}\` |
| **Category** | \`${fields.category}\` |
| **Failure Class** | \`${fields.failureClass}\` |
| **Tags** | ${tagStr} |
| **Status** | \`open\` |
| **Outcome** | \`needs_followup\` |

---

## Suggestion

**What to change:** ${fields.whatToChange}
**Why:** ${fields.why}
**Where:**

${whereLines}

### Proposed Diff <!-- optional but encouraged -->

### Evidence Refs <!-- optional on open, REQUIRED on applied/verified -->

---

## Applied
<!-- Filled by dev rig agent after change is applied -->

---

## Verification
<!-- Filled by Mini agent after deploy -->
`;
}
