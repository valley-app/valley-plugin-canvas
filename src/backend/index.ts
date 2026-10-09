import { registerWorkflowCommands, type PluginBackendApi, type WorkflowCommandBinding, type WorkflowContributionContract } from '@valley/plugin-sdk'
import config from '../../config.json'
import { registerCanvasDocumentCommands } from './documents'

export const bindings: WorkflowCommandBinding[] = [
  {
    "nodeId": "canvas.create",
    "command": "canvas:create",
    "schemaFingerprint": "6869b54879f68f726633f617d49f6ee2daf49967e3dde30a7b21e5512c7ab528",
    "effect": "write"
  },
  {
    "nodeId": "canvas.get",
    "command": "canvas:get",
    "schemaFingerprint": "0019fb74431c69f98bcf6b8b2302577e49fdfee59b5f767c63f83acf2f93983e",
    "effect": "read"
  },
  {
    "nodeId": "canvas.edit",
    "command": "canvas:edit",
    "schemaFingerprint": "b00eb4435a5c6801c5c33f5af3727162602664261511410b294cd11d07bf825a",
    "effect": "write"
  }
]

export function register(api: PluginBackendApi): () => void {
  const contribution = config.runtime.services.find(service => service.id === 'workflow.provider')!
  const registration = registerWorkflowCommands(api, contribution.metadata!.workflow as unknown as WorkflowContributionContract, bindings)
  const offDocuments = registerCanvasDocumentCommands(api)
  return () => { offDocuments(); registration.dispose() }
}
