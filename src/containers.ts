import Docker, { ContainerInfo } from 'dockerode';
import { createHash } from 'node:crypto';
import { config } from './config';
import { logger } from './logger';
import { ExposedPort } from '../lib/types/exposed-port';
import { ConsulPodEntry } from '../lib/types/consul-pod-entry';
import { OrchestratorName } from '../lib/const';
import { Container } from '../lib/types/container';

export function getDockerProtocol(port: ExposedPort): string {
  switch(port.protocol) {
    case 'UDP':
      return 'udp';
    default:
      return 'tcp';
  }
}

type ExistingContainers = { [name: string]: ContainerInfo };

/**
 * Get the list of deployed Raftainer containers
 */
async function getExistingContainers(docker: Docker): Promise<ExistingContainers> {
  const existingContainers: ExistingContainers = (await docker.listContainers({ 
    all: true,
    filters: { 
      label: [`OrchestratorName=${OrchestratorName}`],
    } 
  })).reduce((obj, container: ContainerInfo) => {
    logger.trace({ container }, 'Found existing container');
    // @ts-ignore
    obj[container.Names[0].slice(1)] = container; // remove leading slash in name
    return obj;
  }, {});
  return existingContainers;
}

async function launchPodContainer(docker: Docker, 
                                  existingContainers: ExistingContainers, 
                                  podEntry: ConsulPodEntry, 
                                  containerConfig: Container) {
    await docker.pull(containerConfig.image);
    const containerName = `${podEntry.pod.name}.${containerConfig.name}`;
    const configHash = createHash('md5').update(JSON.stringify(containerConfig)).digest('hex');
    const existingContainerInfo = existingContainers[containerName];
    if(existingContainerInfo) {
      logger.debug({ containerName, existingContainerInfo }, 'Found existing container');
      const existingContainer = docker.getContainer(existingContainerInfo.Id)
      // TODO: check image hash
      if(existingContainerInfo.Labels['ConfigHash'] === configHash) {
        logger.debug({ containerName, existingContainerInfo }, 'Container config matches existing config');
        if(existingContainerInfo.State !== 'running' && containerConfig.restartPolicy !== 'no') {
          logger.debug({ containerName, existingContainerInfo }, 'Re-starting existing container');
          await existingContainer.start();
        }
        return { 
          container: await existingContainer.inspect(),
          config: containerConfig,
        };
      } 
      logger.debug({ existingContainerInfo }, 'Removing existing container');
      await existingContainer.remove({ force: true });
      logger.debug({ containerName, existingContainerInfo }, 'Removed existing container');
    }
    const container = await docker.createContainer({
      name: containerName,
      Image: containerConfig.image,
      Env: Object.keys(containerConfig.environment)
        .map(k => `${k}=${containerConfig.environment[k]}`),
      HostConfig: {
        RestartPolicy: { Name: containerConfig.restartPolicy },
        PortBindings: containerConfig.ports.reduce((obj, port) => {
          // @ts-ignore
          obj[`${port.containerPort}/${getDockerProtocol(port)}`] = [
            { HostPort: String(port.containerPort) }
          ];
          return obj;
        }, {}),
        Binds: containerConfig.localVolumes.map(v => `${v.hostPath}:${v.containerPath}:${v.mode}`),
      },
      Labels: {
        PodName: podEntry.pod.name,
        PodConsulKey: podEntry.key,
        PodContainerName: containerConfig.name,
        OrchestratorName,
        ConfigHash: configHash,
      },
    });
    logger.debug({ containerConfig, container }, `Created container`);
    await container.start();
    return { 
      container: await container.inspect(),
      config: containerConfig,
    };

}

export async function launchPodContainers(docker: Docker, podEntry: ConsulPodEntry) {
  const existingContainers = await getExistingContainers(docker);
  logger.info({ podEntry }, 'Launching pod');
  const launchedContainers = await Promise.all(podEntry.pod.containers.map((containerConfig) => launchPodContainer(docker, existingContainers, podEntry, containerConfig)));

  return { podEntry, launchedContainers };
}

