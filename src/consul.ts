import Consul from 'consul';
import { config } from './config';
import { logger } from './logger';
import { Pod, ConsulPodEntry } from '@raftainer/models';

export const HostSessionName = 'Raftainer Host';

export async function configureHostSession (consul: Consul.Consul): Promise<string> {
  if(!config.fastStartup) {
    // @ts-expect-error consul API call
    while ((await consul.session.node(config.name)).find(({ Name: name }) => name === HostSessionName)) {
      logger.warn('Node already has a Raftainer lock. Waiting for lock to expire...');
      await new Promise(resolve => setTimeout(resolve, 10_000 * Math.random()));
    }
  }
  // @ts-expect-error consul API call
  const session: string = (await consul.session.create({
    name: HostSessionName,
    node: config.name,
    ttl: '10s',
    lockdelay: '10s'
  })).ID;
  logger.info(`Created consul session: ${session}`);

  setInterval(async () => {
    // @ts-expect-error consul API call
    const [{ CreateIndex: createIndex, ModifyIndex: modifyIndex }] = await consul.session.renew(session);
    logger.trace(`Renewed consul session: ${session}: ${createIndex}, ${modifyIndex}`);
  }, 5_000);

  process.on('exit', function () {
    consul.session.destroy(session)
      .catch(error => { logger.error(`Failed to destroy consul session during shutdown: ${error}`); });
  });

  return session;
}

export async function getPods (consul: Consul.Consul): Promise<ConsulPodEntry[]> {
  const keys: string[] = await consul.kv.keys('raftainer/pods');
  return await Promise.all(keys.map(async (key: string) => {
    // @ts-expect-error consul API call
    const json: string = (await consul.kv.get(key)).Value;
    return { key, pod: JSON.parse(json) as Pod };
  }));
}


export interface ConsulPodEntryWithLock extends ConsulPodEntry {
  readonly lockKey: string;
}

export async function tryLockPod(
  consul: Consul.Consul, 
  session: string, 
  pod: ConsulPodEntry,
): Promise<ConsulPodEntryWithLock | null> {
  logger.info('Attempting to lock pod %s', pod.pod.name);

  for(let i = 0; i < pod.pod.maxInstances; i++) {
    const lockKey = `${pod.key}/hosts/${i}/.lock`;
    logger.debug('Attempting to lock key %s', lockKey);
    const lockResult = await consul.kv.set({ 
      key: lockKey, 
      value: JSON.stringify({ 
        holders: [session],
        host: config.name,
        region: config.region,
        timestamp: Date.now(),
      }), 
      acquire: session 
    });
    logger.debug('Lock result for key %s: ', lockKey, lockResult || false);
    if(lockResult) {
      logger.info('Got lock %d for pod %s', i, pod.pod.name);
      return { ...pod, lockKey };
    }
  }
  logger.info('Did not get lock for pod %s', pod.pod.name);

  return null;
}


