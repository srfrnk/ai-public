# Unified Pattern Syntax & Precedence Rules

Across all configuration files (`filesystem.yaml`, `network.yaml`, `environment.yaml`), patterns use a unified Gitignore-style list format with **strict negation (`!`) precedence**.

---

## 1. Syntax Rules

### 1.1 Standard Glob Patterns
- `*`: Matches zero or more characters within a single path or name segment.
  - Example: `ANTHROPIC_*` matches `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.
- `**`: Matches zero or more directories recursively.
  - Example: `~/projects/**` matches `/home/user/projects/file.txt` and `/home/user/projects/a/b/c/file.txt`.
- `?`: Matches any single character.

### 1.2 Negation Rules (Deny / Blacklist)
- A leading exclamation mark `!` designates a **blacklist** rule.
  - Example: `!~/projects/**/private-*`
  - Example: `!AWS_*`
  - Example: `!*.internal.corp`

### 1.3 Regular Expressions (`regex:`)
- Any pattern starting with `regex:` is compiled directly as an ECMAScript regular expression.
  - Example: `!regex:^.*\\.pem$` (matches any file ending in `.pem`)
  - Example: `!regex:^.*telemetry.*$`

---

## 2. Precedence & Evaluation Order

1. **Deny Rules Always Win**: If an item matches any `!pattern` rule, it is immediately denied/blocked.
2. **Recursive Parent/Child Blocking**:
   - If a parent folder (e.g. `/workspace`) is whitelisted, but a child path (e.g. `/workspace/secret`) matches a deny rule, the child is masked at the kernel level with a read-only `tmpfs`.
   - File tree walks (`find`, `ls -R`) cannot see or enter the masked path.
3. **Whitelist Matching**: If no deny rule matches, at least one positive pattern must match for the item to be allowed.
4. **Default Action**: If no rules match, the item is denied.
