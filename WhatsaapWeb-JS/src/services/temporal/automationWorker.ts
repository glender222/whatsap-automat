import { NativeConnection, Worker } from '@temporalio/worker';
import pool from '../../config/database';
import { OutboxRelayDaemon } from '../outbox/OutboxRelayDaemon';
import { AUTOMATION_TASK_QUEUE, WorkflowDispatchService } from '../workflows/WorkflowDispatchService';
import { recordWorkflowRunCheckpointActivity } from './activities/recordWorkflowRunCheckpointActivity';
import { getTemporalClient, temporalClientFactory } from './TemporalClientFactory';
import { temporalTlsFromEnvironment } from './temporalTls';

async function main(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS || '127.0.0.1:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';
  const tls = temporalTlsFromEnvironment();
  const connection = await NativeConnection.connect({ address, tls });
  const relay = new OutboxRelayDaemon({
    batchSize: 1,
    workflowDispatch: new WorkflowDispatchService(),
    temporalClientProvider: () => getTemporalClient({ address, namespace, tls }),
    onError: (error) => console.error('Automation relay poll failed', {
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    }),
  });

  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: AUTOMATION_TASK_QUEUE,
      workflowsPath: require.resolve('./workflows/DurableAutomationWorkflow'),
      activities: { recordWorkflowRunCheckpointActivity },
    });
    await relay.start();
    await worker.run();
  } finally {
    await relay.stop();
    await temporalClientFactory.close();
    await connection.close();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Automation worker stopped', error instanceof Error ? error.message : 'Unknown failure');
    process.exitCode = 1;
  });
}
