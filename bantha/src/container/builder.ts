import { spawnSync, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Agent binaries under bin-cache/ are 100-200 MB; re-reading them on every launch
// dominates the context check, so large inputs are hashed by stat instead.
const LARGE_FILE_BYTES = 32 * 1024 * 1024;

export class ContainerBuilder {
  private dockerContextDir: string;
  private imageName: string;

  constructor(dockerContextDir: string, imageName: string = 'bantha:latest') {
    this.dockerContextDir = dockerContextDir;
    this.imageName = imageName;
  }

  /**
   * Checks if the docker image exists locally
   */
  public imageExists(): boolean {
    try {
      const res = spawnSync('docker', ['image', 'inspect', this.imageName], {
        stdio: 'ignore'
      });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Sources of every COPY/ADD line in a Dockerfile, relative to the context dir.
   * These are the only host files the image actually reads, so they define the
   * build context; anything the Dockerfile never reads cannot change the image.
   */
  public copySources(dockerfile: string): string[] {
    const text = fs.readFileSync(dockerfile, 'utf-8').replace(/\\\r?\n/g, ' ');
    const sources: string[] = [];
    for (const line of text.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      if (!/^(COPY|ADD)$/i.test(parts[0])) continue;
      const args = parts.slice(1).filter(a => !a.startsWith('--'));
      if (args.length < 2) continue;
      sources.push(...args.slice(0, -1));   // last argument is the destination
    }
    return sources;
  }

  /** Hash one context input: a file's content, a directory tree, or (for huge files) its stat. */
  private hashContextPath(hash: crypto.Hash, target: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      hash.update('MISSING:' + target);
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) {
        this.hashContextPath(hash, path.join(target, entry));
      }
      return;
    }
    if (stat.size > LARGE_FILE_BYTES) {
      hash.update(`BIG:${target}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
      return;
    }
    hash.update(`FILE:${target}`);
    hash.update(fs.readFileSync(target));
  }

  /**
   * Computes a checksum of the Dockerfile and everything it COPYs
   */
  public computeContextHash(): string {
    const hash = crypto.createHash('sha256');
    const dockerfile = path.join(this.dockerContextDir, 'Dockerfile');
    if (fs.existsSync(dockerfile)) {
      hash.update(fs.readFileSync(dockerfile));
      for (const source of this.copySources(dockerfile)) {
        this.hashContextPath(hash, path.resolve(this.dockerContextDir, source));
      }
    }
    return hash.digest('hex');
  }

  /**
   * Retrieves the context hash label from the local image if it exists
   */
  public getImageContextHash(): string | null {
    try {
      const res = spawnSync('docker', ['image', 'inspect', this.imageName, '--format', '{{index .Config.Labels "bantha.context_hash"}}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (res.status === 0 && res.stdout) {
        const val = res.stdout.trim();
        return val && val !== '<no value>' ? val : null;
      }
    } catch {}
    return null;
  }

  /**
   * Builds the Docker image when it is missing, when the build context changed
   * since it was built, or when explicitly forced. The context hash is stamped
   * on the image at build time, so a changed Dockerfile/COPY input is detected
   * on the next launch instead of silently reusing a stale image.
   */
  public ensureImage(force: boolean = false): void {
    const currentHash = this.computeContextHash();
    const stampedHash = this.getImageContextHash();

    if (this.imageExists() && !force) {
      if (stampedHash === currentHash) {
        console.log(`[BUILD] Image "${this.imageName}" matches the current build context — skipping build.`);
        return;
      }
      console.log(stampedHash
        ? `[BUILD] Build context changed since "${this.imageName}" was built — rebuilding. (use --force to skip the check)`
        : `[BUILD] Image "${this.imageName}" predates context tracking — rebuilding once to enable auto-detection.`);
    }

    console.log(`[BUILD] Building Docker image "${this.imageName}" from ${this.dockerContextDir}...`);

    const res = spawnSync('docker', ['build', '--label', `bantha.context_hash=${currentHash}`, '-t', this.imageName, '.'], {
      cwd: this.dockerContextDir,
      stdio: 'inherit'
    });

    if (res.status !== 0) {
      throw new Error(`[BUILD ERROR] Failed to build image ${this.imageName}. Exit code: ${res.status}`);
    }

    console.log(`[BUILD] Successfully built "${this.imageName}".`);
  }

  /**
   * Builds the gateway image when it is missing, when its context changed, or
   * when forced. Uses the same stamp-and-compare scheme as the main image.
   */
  public ensureGatewayImage(force: boolean = false): void {
    const gatewayImage = 'bantha-gateway:latest';
    const gatewayDir = path.join(this.dockerContextDir, 'gateway');
    if (!fs.existsSync(gatewayDir)) {
      return;
    }

    const currentHash = this.computeGatewayContextHash(gatewayDir);
    const stampedHash = this.getGatewayImageContextHash();

    if (stampedHash === currentHash && !force) {
      console.log(`[BUILD] Gateway image "${gatewayImage}" matches its build context — skipping build.`);
      return;
    }

    console.log(`[BUILD] Building Gateway Docker image "${gatewayImage}" from ${gatewayDir}...`);
    const res = spawnSync('docker', ['build', '--label', `bantha.context_hash=${currentHash}`, '-t', gatewayImage, '.'], {
      cwd: gatewayDir,
      stdio: 'inherit'
    });

    if (res.status !== 0) {
      throw new Error(`[BUILD ERROR] Failed to build gateway image ${gatewayImage}. Exit code: ${res.status}`);
    }

    console.log(`[BUILD] Successfully built "${gatewayImage}".`);
  }

  private getGatewayImageContextHash(): string | null {
    const prevImage = this.imageName;
    this.imageName = 'bantha-gateway:latest';
    const val = this.getImageContextHash();
    this.imageName = prevImage;
    return val;
  }

  private computeGatewayContextHash(gatewayDir: string): string {
    const hash = crypto.createHash('sha256');
    const dockerfile = path.join(gatewayDir, 'Dockerfile');
    if (fs.existsSync(dockerfile)) {
      hash.update(fs.readFileSync(dockerfile));
      for (const source of this.copySources(dockerfile)) {
        this.hashContextPath(hash, path.resolve(gatewayDir, source));
      }
    }
    return hash.digest('hex');
  }
}
