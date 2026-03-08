# Lessons

- When a settings screen uses a wide table, do not hide primary actions like edit or remove in the last column. Existing items need obvious inline actions that remain discoverable at normal desktop widths.
- Do not expose internal identifiers like slugs or keys in the primary create flow when a human-facing name is sufficient. Generate those identifiers automatically and keep them read-only or hidden unless an operator explicitly needs them.
- Action labels must match the real behavior. If something archives rather than deletes, label it as archive, and avoid side-by-side actions that blur the distinction between “edit metadata” and “open another workspace.”
