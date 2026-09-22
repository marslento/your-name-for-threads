export interface SurfaceMount {
  key: string;
  surface: string;
  host: HTMLElement;
  unmount(): void;
}

interface GetOrCreateMount {
  key: string;
  surface: string;
  host: HTMLElement;
  create(): () => void;
}

export class MountRegistry {
  private readonly mounts = new Map<string, SurfaceMount>();

  get(key: string): SurfaceMount | undefined {
    return this.mounts.get(key);
  }

  cleanupKey(key: string): void {
    const mount = this.mounts.get(key);
    this.cleanupMounts(mount ? [mount] : []);
  }

  cleanupDetached(): void {
    this.cleanupMounts(
      [...this.mounts.values()].filter((mount) => !mount.host.isConnected),
    );
  }

  cleanupSurface(surface: string): void {
    this.cleanupMounts(
      [...this.mounts.values()].filter((mount) => mount.surface === surface),
    );
  }

  cleanupAll(): void {
    this.cleanupMounts([...this.mounts.values()]);
  }

  getOrCreate({
    key,
    surface,
    host,
    create,
  }: GetOrCreateMount): SurfaceMount {
    const existing = this.mounts.get(key);
    if (existing?.host.isConnected) {
      return existing;
    }
    if (existing) {
      this.mounts.delete(key);
      this.cleanupMounts([existing]);
      const replacement = this.mounts.get(key);
      if (replacement) {
        return replacement;
      }
    }

    const callerUnmount = create();
    const replacement = this.mounts.get(key);
    if (replacement) {
      try {
        callerUnmount();
      } catch {
        // Losing mount cleanup cannot disturb the winning record.
      }
      return replacement;
    }

    let mounted = true;
    const mount: SurfaceMount = {
      key,
      surface,
      host,
      unmount: () => {
        if (!mounted) {
          return;
        }
        mounted = false;
        if (this.mounts.get(key) === mount) {
          this.mounts.delete(key);
        }
        callerUnmount();
      },
    };
    this.mounts.set(key, mount);
    return mount;
  }

  private cleanupMounts(mounts: readonly SurfaceMount[]): void {
    for (const mount of mounts) {
      try {
        mount.unmount();
      } catch {
        // One mount cannot prevent the registry from cleaning up the rest.
      }
    }
  }
}
