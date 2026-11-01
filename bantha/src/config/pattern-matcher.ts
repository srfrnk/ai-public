/**
 * Unified gitignore-style and regex pattern matcher.
 * Rules:
 *  - Standard glob syntax: `*` (single segment wildcard), `**` (recursive wildcard), `?`
 *  - Leading `!` indicates a NEGATION (blacklist) rule.
 *  - `regex:` prefix allows arbitrary ECMAScript regular expressions.
 *  - Blacklist / negation rules ALWAYS have strict precedence over allow rules.
 */

export interface RuleMatchResult {
  allowed: boolean;
  matchedRule?: string;
  isBlacklisted: boolean;
}

export class PatternMatcher {
  private allowRules: { raw: string; regex: RegExp }[] = [];
  private denyRules: { raw: string; regex: RegExp }[] = [];

  constructor(rules: (string | { path: string })[] = []) {
    for (const ruleItem of rules) {
      const rawPattern = typeof ruleItem === 'string' ? ruleItem : ruleItem.path;
      if (!rawPattern || typeof rawPattern !== 'string') continue;

      const trimmed = rawPattern.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const isDeny = trimmed.startsWith('!');
      const cleanPattern = isDeny ? trimmed.slice(1).trim() : trimmed;

      const compiled = this.compileToRegex(cleanPattern);
      if (isDeny) {
        this.denyRules.push({ raw: trimmed, regex: compiled });
      } else {
        this.allowRules.push({ raw: trimmed, regex: compiled });
      }
    }
  }

  /**
   * Adds an explicit deny rule (used for hardcoded protected paths)
   */
  public addExplicitDeny(pattern: string): void {
    const trimmed = pattern.startsWith('!') ? pattern.slice(1).trim() : pattern.trim();
    this.denyRules.push({
      raw: `!${trimmed}`,
      regex: this.compileToRegex(trimmed)
    });
  }

  /**
   * Compiles a pattern string to RegExp
   */
  private compileToRegex(pattern: string): RegExp {
    if (pattern.startsWith('regex:')) {
      return new RegExp(pattern.slice(6));
    }

    // Gitignore / glob pattern compiler
    let regexStr = '^';
    let i = 0;
    const len = pattern.length;

    while (i < len) {
      const char = pattern[i];

      if (char === '*' && pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else if (char === '*') {
        regexStr += '[^/]*';
        i++;
      } else if (char === '?') {
        regexStr += '[^/]';
        i++;
      } else if (['.', '(', ')', '+', '|', '^', '$', '[', ']', '{', '}', '\\'].includes(char)) {
        regexStr += '\\' + char;
        i++;
      } else {
        regexStr += char;
        i++;
      }
    }

    regexStr += '$';
    return new RegExp(regexStr);
  }

  /**
   * Evaluates a candidate string against the rule set.
   * STRICT PRECEDENCE:
   * 1. If any deny rule matches -> BLOCKED (allowed = false, isBlacklisted = true)
   * 2. If allow rules exist, at least one must match -> ALLOWED (allowed = true)
   * 3. If no allow rules exist, default to false.
   */
  public test(target: string): RuleMatchResult {
    // 1. Check all deny rules first
    for (const deny of this.denyRules) {
      if (deny.regex.test(target)) {
        return {
          allowed: false,
          matchedRule: deny.raw,
          isBlacklisted: true
        };
      }
    }

    // 2. Check allow rules
    for (const allow of this.allowRules) {
      if (allow.regex.test(target)) {
        return {
          allowed: true,
          matchedRule: allow.raw,
          isBlacklisted: false
        };
      }
    }

    return {
      allowed: false,
      isBlacklisted: false
    };
  }

  /**
   * Specifically checks if a target path matches any deny pattern
   */
  public matchesDeny(target: string): boolean {
    for (const deny of this.denyRules) {
      if (deny.regex.test(target)) {
        return true;
      }
    }
    return false;
  }

  public getDenyRules(): string[] {
    return this.denyRules.map(d => d.raw);
  }

  public getAllowRules(): string[] {
    return this.allowRules.map(a => a.raw);
  }
}
