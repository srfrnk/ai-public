import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LoadedSandboxConfig, MountRuleObject } from '../config/loader';

export interface PlannedMount {
  type: 'bind' | 'tmpfs';
  source?: string;
  destination: string;
  mode: 'ro' | 'rw';
}

export class MountPlanner {
  private config: LoadedSandboxConfig;

  constructor(config: LoadedSandboxConfig) {
    this.config = config;
  }

  /**
   * Plans the mounts for docker execution:
   * 1. Evaluates all whitelisted paths.
   * 2. Checks each against protected ancestors (throws error if forbidden).
   * 3. Discovers blacklisted subtrees/files inside those mounts and adds read-only tmpfs masks.
   */
  public planMounts(currentHostWorkdir: string, agentName?: string): { mounts: PlannedMount[]; containerWorkdir: string } {
    const planned: PlannedMount[] = [];
    const whitelistedBinds: { host: string; container: string; mode: 'ro' | 'rw' }[] = [];

    const home = os.homedir();
    const sandboxDataDir = path.join(this.config.configDir, 'data');

    // 1. Persistent Shared Hub: skills, mcp, rules (RW across all agents)
    const sharedHostDir = path.join(sandboxDataDir, 'shared');
    fs.mkdirSync(path.join(sharedHostDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(sharedHostDir, 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(sharedHostDir, 'rules'), { recursive: true });

    whitelistedBinds.push({
      host: sharedHostDir,
      container: '/home/sandbox/.shared',
      mode: 'rw'
    });

    // 2. Per-Agent Persistent Storage (Sessions, state, memory)
    if (agentName) {
      const agentHostDir = path.join(sandboxDataDir, 'agents', agentName);
      fs.mkdirSync(agentHostDir, { recursive: true });
      whitelistedBinds.push({
        host: agentHostDir,
        container: `/home/sandbox/.agent-state/${agentName}`,
        mode: 'rw'
      });
    }

    // 3. Always include current working directory by default as RW unless protected or blacklisted
    const resolvedCurrent = path.resolve(currentHostWorkdir);
    const isCurrentProtected = this.config.validator.isProtectedAncestor(resolvedCurrent);
    const isCurrentBlacklisted = this.config.filesystemMatcher.matchesDeny(resolvedCurrent);

    if (!isCurrentProtected && !isCurrentBlacklisted && fs.existsSync(resolvedCurrent)) {
      whitelistedBinds.push({
        host: resolvedCurrent,
        container: resolvedCurrent,
        mode: 'rw'
      });
    }

    // 2. Process config mounts rules
    for (const rule of this.config.filesystem.mounts.rules || []) {
      let hostPath: string;
      let containerPath: string | undefined;
      let mode: 'ro' | 'rw' = 'rw';

      if (typeof rule === 'string') {
        const trimmed = rule.trim();
        if (trimmed.startsWith('!')) continue; // Skip deny rules in positive mount collection
        hostPath = trimmed.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
      } else {
        hostPath = rule.path;
        containerPath = rule.container_path;
        mode = rule.mode || 'rw';
      }

      hostPath = hostPath.replace(/^~(?=$|\/|\\)/, os.homedir());
      const resolvedHost = path.resolve(hostPath);

      // Validate against protected ancestors
      if (this.config.validator.isProtectedAncestor(resolvedHost)) {
        throw new Error(
          `[SECURITY VIOLATION] Mount target "${resolvedHost}" is a protected sandbox or ancestor directory and cannot be mounted!`
        );
      }

      if (!fs.existsSync(resolvedHost)) {
        continue;
      }

      const dest = containerPath ? containerPath : resolvedHost;
      // Do not duplicate if already added
      const existing = whitelistedBinds.find(b => b.host === resolvedHost);
      if (existing) {
        existing.mode = mode;
        if (containerPath) existing.container = containerPath;
      } else {
        whitelistedBinds.push({
          host: resolvedHost,
          container: dest,
          mode
        });
      }
    }

    // 2. Add whitelisted bind mounts
    for (const b of whitelistedBinds) {
      planned.push({
        type: 'bind',
        source: b.host,
        destination: b.container,
        mode: b.mode
      });

      // 3. Scan for blacklisted paths inside this bind mount to apply kernel tmpfs masks
      this.applyBlacklistMasks(b.host, b.container, planned);
    }

    // 4. Determine container working directory
    let containerWorkdir = '/home/sandbox';

    // If current working directory is under one of the whitelisted mounts and not blacklisted
    for (const b of whitelistedBinds) {
      if (resolvedCurrent === b.host || resolvedCurrent.startsWith(b.host + path.sep)) {
        const relative = path.relative(b.host, resolvedCurrent);
        const mapped = path.join(b.container, relative);
        if (!this.config.filesystemMatcher.matchesDeny(resolvedCurrent)) {
          containerWorkdir = mapped;
          break;
        }
      }
    }

    return { mounts: planned, containerWorkdir };
  }

  /**
   * Applies kernel-level tmpfs masks for blacklisted children inside mounted host roots
   */
  private applyBlacklistMasks(hostRoot: string, containerRoot: string, planned: PlannedMount[]): void {
    const denyRules = this.config.filesystemMatcher.getDenyRules();

    for (const rawDeny of denyRules) {
      const clean = rawDeny.replace(/^!/, '').trim();
      if (clean.startsWith('regex:')) continue; // Dynamic regex masks applied on exact directory hits if scanned

      let candidateHost = clean.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
      candidateHost = candidateHost.replace(/^~(?=$|\/|\\)/, os.homedir());
      const resolvedDeny = path.resolve(candidateHost);

      // If the blacklisted path is within this host mount
      if (resolvedDeny.startsWith(hostRoot + path.sep) && fs.existsSync(resolvedDeny)) {
        const rel = path.relative(hostRoot, resolvedDeny);
        const containerDest = path.join(containerRoot, rel);

        // Check if already masked
        if (!planned.some(p => p.destination === containerDest)) {
          planned.push({
            type: 'tmpfs',
            destination: containerDest,
            mode: 'ro'
          });
        }
      }
    }
  }
}
