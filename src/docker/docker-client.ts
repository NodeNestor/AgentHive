import Docker from 'dockerode';

let client: Docker | null = null;

export function docker(): Docker {
  if (client) return client;
  // dockerode auto-detects DOCKER_HOST / socket on both Linux and
  // Windows Docker Desktop (npipe on windows via npipe path). For
  // containers mounting /var/run/docker.sock this is the default.
  client = new Docker();
  return client;
}

export async function ensureNetwork(name: string): Promise<void> {
  const nets = await docker().listNetworks({ filters: { name: [name] } });
  if (!nets.some((n) => n.Name === name)) {
    await docker().createNetwork({ Name: name, Driver: 'bridge' });
  }
}

export async function pullImageIfMissing(image: string): Promise<void> {
  try {
    await docker().getImage(image).inspect();
    return;
  } catch {
    // not present — try to pull
  }
  await new Promise<void>((resolve, reject) => {
    docker().pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker().modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
}
