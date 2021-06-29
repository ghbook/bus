import { WorkflowState, WorkflowStatus } from '../workflow-state'
import { Message, MessageAttributes } from '@node-ts/bus-messages'
import { MessageWorkflowMapping } from '../message-workflow-mapping'
import * as uuid from 'uuid'
import { Workflow, WhenHandler, OnWhenHandler } from '../workflow'
import { getPersistence } from '../persistence/persistence'
import { ClassConstructor } from '../../util'
import { handlerRegistry } from '../../handler/handler-registry'
import { getLogger } from '../../logger'
import { PersistenceNotConfigured } from '../persistence/error'

const logger = getLogger('@node-ts/bus-core:workflow-registry')

const createWorkflowState = <TWorkflowState extends WorkflowState> (workflowStateType: ClassConstructor<TWorkflowState>) => {
  const data = new workflowStateType()
  data.$status = WorkflowStatus.Running
  data.$workflowId = uuid.v4()
  return data
}

const dispatchMessageToWorkflow = async (
  message: Message,
  attributes: MessageAttributes,
  workflowName: string,
  workflowState: WorkflowState,
  workflowStateConstructor: ClassConstructor<WorkflowState>,
  handler: WhenHandler<Message, WorkflowState>
) => {
  const immutableWorkflowState = Object.freeze({...workflowState})
  const workflowStateOutput = await handler({
    message,
    attributes,
    state: immutableWorkflowState
  })

  if (workflowStateOutput && workflowStateOutput.$status === WorkflowStatus.Discard) {
    logger.debug(
      'Workflow step is discarding state changes. State changes will not be persisted',
      { workflowId: immutableWorkflowState.$workflowId, workflowName }
    )
  } else if (workflowStateOutput) {
    logger.debug(
      'Changes detected in workflow state and will be persisted.',
      {
        workflowId: immutableWorkflowState.$workflowId,
        workflowName,
        changes: workflowStateOutput
      }
    )

    const updatedWorkflowState = Object.assign(
      new workflowStateConstructor(),
      workflowState,
      workflowStateOutput
    )

    try {
      await persist(updatedWorkflowState)
    } catch (error) {
      logger.warn(
        'Error persisting workflow state',
        { err: error, workflow: workflowName }
      )
      throw error
    }
  } else {
    logger.trace('No changes detected in workflow state.', { workflowId: immutableWorkflowState.$workflowId })
  }
}

const persist = async (data: WorkflowState) => {
  try {
    await getPersistence().saveWorkflowState(data)
    logger.info('Saving workflow state', { data })
  } catch (err) {
    logger.error('Error persisting workflow state', { err })
    throw err
  }
}

/**
 * The central workflow registry that holds all workflows managed by the application. This includes
 *   - the list of workflows
 *   - what messages start the workflow
 *   - what messages are handled by each workflow
 */
class WorkflowRegistry {

  private workflowRegistry: Workflow[] = []
  private isInitialized = false
  private isInitializing = false

  async register (workflow: Workflow): Promise<void> {
    if (this.isInitialized) {
      throw new Error(
        `Attempted to register workflow (${workflow.workflowName}) after workflows have been initialized`
      )
    }

    const duplicateWorkflowName = this.workflowRegistry
      .some(r => r.workflowName === workflow.workflowName)

    if (duplicateWorkflowName) {
      throw new Error(`Attempted to register two workflows with the same name (${workflow.workflowName})`)
    }

    this.workflowRegistry.push(workflow)
  }

  /**
   * Initialize all services that are used to support workflows. This registers all messages subscribed to
   * in workflows as handlers with the bus, as well as initializing the persistence service so that workflow
   * states can be stored.
   *
   * This should be called once as the application is starting.
   */
  async initialize (): Promise<void> {
    if (this.workflowRegistry.length === 0) {
      logger.info('No workflows registered, skipping this step.')
      return
    }

    if (this.isInitialized || this.isInitializing) {
      throw new Error('Attempted to initialize workflow registry after it has already been initialized.')
    }

    this.isInitializing = true
    logger.info('Initializing workflows...')

    for (const workflow of this.workflowRegistry) {

      this.registerFnStartedBy(workflow)
      this.registerFnHandles(workflow)

      const messageWorkflowMappings: MessageWorkflowMapping[] = Array.from<[ClassConstructor<Message>, OnWhenHandler], MessageWorkflowMapping>(
        workflow.onWhen,
        ([_, onWhenHandler]) => onWhenHandler.options
      )
      await getPersistence().initializeWorkflow(workflow.stateType, messageWorkflowMappings)
      logger.debug('Workflow initialized', { workflowName: workflow.workflowName })
    }

    this.workflowRegistry = []

    if (getPersistence().initialize) {
      await getPersistence().initialize!()
    }

    this.isInitialized = true
    this.isInitializing = false
    logger.info('Workflows initialized')
  }

  async dispose (): Promise<void> {
    try {
      if (getPersistence().dispose) {
        await getPersistence().dispose!()
      }
    } catch (error) {
      if (error instanceof PersistenceNotConfigured) {
        return
      }
      throw error
    }
  }

  private registerFnStartedBy (
    workflow: Workflow
  ): void {
    workflow.onStartedBy.forEach((handler, messageConstructor) =>
      handlerRegistry.register(
        messageConstructor,
        async ({ message, attributes }) => {
          const workflowState = createWorkflowState(workflow.stateType)
          const immutableWorkflowState = Object.freeze({...workflowState})
          const result = await handler({ message, attributes, state: immutableWorkflowState })
          if (result) {
            await getPersistence().saveWorkflowState({
              ...workflowState,
              ...result
            })
          }
        }
    ))
  }

  private registerFnHandles (
    workflow: Workflow
  ): void {
    workflow.onWhen.forEach((handler, messageConstructor) => {
      const messageMapping: MessageWorkflowMapping<Message, WorkflowState> = {
        lookup: handler.options.lookup,
        mapsTo: handler.options.mapsTo
      }
      handlerRegistry.register(
        messageConstructor,
        async ({ message, attributes }) => {
          const workflowState = await getPersistence().getWorkflowState(
            workflow.stateType,
            messageMapping,
            message,
            attributes,
            false
          )

          if (!workflowState.length) {
            logger.info('No existing workflow state found for message. Ignoring.', { message })
            return
          }

          const workflowHandlers = workflowState.map(state => dispatchMessageToWorkflow(
            message,
            attributes,
            workflow.workflowName,
            state,
            workflow.stateType,
            handler.handler
          ))

          await Promise.all(workflowHandlers)
        }
      )
    })
  }
}

export const workflowRegistry = new WorkflowRegistry()
