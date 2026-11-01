import { spawnSync, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export class ContainerBuilder {
  private dockerContextDir: string;
  private imageName: string;

  constructor(dockerContextDir: string, imageName: string = 'agent-sandbox:latest') {
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
   * Computes a checksum of Dockerfile and entrypoint script
   */
  public computeContextHash(): string {
    const hash = crypto.createHash('sha256');
    const files = ['Dockerfile', 'entrypoint.sh', 'dns-gate.py'];

    for (const f of files) {
      const p = path.join(this.dockerContextDir, f);
      if (fs.existsSync(p)) {
        hash.update(fs.readFileSync(p));
      }
    }

    return hash.digest('hex');
  }

  /**
   * Builds the Docker image if missing or requested
   */
  public ensureImage(force: boolean = false): void {
    const exists = this.imageExists();
    if (exists && !force) {
      return;
    }

    console.log(`[BUILD] Building Docker image "${this.imageName}" from ${this.dockerContextDir}...`);
    const res = spawnSync('docker', ['build', '-t', this.imageName, '.'], {
      cwd: this.dockerContextDir,
      stdio: 'inherit'
    });

    if (res.status !== 0) {
      throw new Error(`[BUILD ERROR] Failed to build image ${this.imageName}. Exit code: ${res.status}`);
    }

    console.log(`[BUILD] Successfully built "${this.imageName}".`);
  }
}
