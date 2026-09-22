type Listener<T> = (arg: T) => void;

class FakeEvent<T> {
  private readonly listeners = new Set<Listener<T>>();
  addListener(listener: Listener<T>) {
    this.listeners.add(listener);
  }
  removeListener(listener: Listener<T>) {
    this.listeners.delete(listener);
  }
  fire(arg: T) {
    for (const listener of [...this.listeners]) listener(arg);
  }
}

class FakePort {
  readonly name: string;
  readonly onMessage = new FakeEvent<unknown>();
  readonly onDisconnect = new FakeEvent<void>();
  private peer: FakePort | null = null;
  private disconnected = false;

  constructor(name: string) {
    this.name = name;
  }

  linkTo(peer: FakePort) {
    this.peer = peer;
  }

  postMessage(message: unknown) {
    if (this.disconnected) throw new Error("Attempting to use a disconnected port object");
    const peer = this.peer;
    if (peer && !peer.disconnected) queueMicrotask(() => peer.onMessage.fire(message));
  }

  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.fire();
    const peer = this.peer;
    if (peer && !peer.disconnected) {
      peer.disconnected = true;
      queueMicrotask(() => peer.onDisconnect.fire());
    }
  }
}

/**
 * A minimal `chrome.runtime.connect`/`onConnect` simulation, real enough to
 * exercise `directoryLock.ts`'s actual `withDirectoryLock`/
 * `installDirectoryLockArbiter` production code in tests instead of only
 * its fail-soft fallback (Phase 3.5 review round 3, High #4). Every
 * `connect()` call gets its own linked pair of ports (mirroring one real
 * Chrome connection's two ends) and delivers messages/disconnects
 * asynchronously via `queueMicrotask`, same as the real API. Two
 * "contexts" racing a lock in a test are two separate `connect()` calls
 * against the SAME instance - install one per test, not one per context.
 */
export function createFakePortRuntime() {
  const onConnectListeners = new Set<Listener<FakePort>>();

  return {
    connect(connectInfo: { name?: string } = {}): FakePort {
      const name = connectInfo.name ?? "";
      const clientPort = new FakePort(name);
      const arbiterPort = new FakePort(name);
      clientPort.linkTo(arbiterPort);
      arbiterPort.linkTo(clientPort);
      queueMicrotask(() => {
        for (const listener of [...onConnectListeners]) listener(arbiterPort);
      });
      return clientPort;
    },
    onConnect: {
      addListener(listener: Listener<FakePort>) {
        onConnectListeners.add(listener);
      },
    },
  };
}
