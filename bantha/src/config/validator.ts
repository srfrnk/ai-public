import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Validates path security and protects configuration and ancestor directories.
 * Protects:
 * - ~/.bantha and all parent/ancestor directories ($HOME, /home, etc.)
 * - Symlink targets of the runner and the source repository
 */
export class PathValidator {
  private protectedDirectories: Set<string> = new Set();

  constructor(sourceRepoDir?: string) {
    this.initProtectedPaths(sourceRepoDir);
  }

  private initProtectedPaths(sourceRepoDir?: string): void {
    const home = os.homedir();
    const banthaDir = path.join(home, '.bantha');

    // Protect ~/.bantha and its canonical realpath
    this.addPathAndAncestors(banthaDir);

    // If a source directory is provided or discoverable, protect it and its ancestors
    if (sourceRepoDir) {
      this.addPathAndAncestors(sourceRepoDir);
    }
  }

  private addPathAndAncestors(targetPath: string): void {
    try {
      const real = fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath);
      let curr = real;
      while (curr && curr !== path.dirname(curr)) {
        this.protectedDirectories.add(curr);
        curr = path.dirname(curr);
      }
      this.protectedDirectories.add('/');
    } catch {
      let curr = path.resolve(targetPath);
      while (curr && curr !== path.dirname(curr)) {
        this.protectedDirectories.add(curr);
        curr = path.dirname(curr);
      }
      this.protectedDirectories.add('/');
    }
  }

  /**
   * Returns whether a candidate path directly attempts to bind a protected ancestor
   */
  public isProtectedAncestor(hostPath: string): boolean {
    const resolved = path.resolve(hostPath.replace(/^~(?=$|\/|\\)/, os.homedir()));
    const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;

    const home = os.homedir();
    const banthaDir = path.resolve(home, '.bantha');
    const banthaDataDir = path.resolve(banthaDir, 'data');

    // Allow ~/.bantha/data subdirectories
    if (real === banthaDataDir || real.startsWith(banthaDataDir + path.sep)) {
      return false;
    }

    // Strict exact equality checks for dangerous mounts
    if (real === banthaDir || real.startsWith(banthaDir + path.sep)) {
      return true;
    }

    if (real === home || real === path.resolve(home, '.config')) {
      return true;
    }

    if (real === '/' || real === '/home' || real === '/root') {
      return true;
    }

    return false;
  }

  public getProtectedDirectories(): string[] {
    return Array.from(this.protectedDirectories);
  }
}
