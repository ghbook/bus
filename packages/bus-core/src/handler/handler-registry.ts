import { Message } from '@node-ts/bus-messages'
import { getLogger } from '../logger'
import { ClassConstructor } from '../util'
import { HandlerAlreadyRegistered } from './errors'
import { Handler } from './handler'

const logger = getLogger('@node-ts/bus-core:handler-registry')

interface RegisteredHandlers {
  messageType: ClassConstructor<Message>
  handlers: Handler[]
}

interface HandlerRegistrations {
  [key: string]: RegisteredHandlers
}

export interface HandlerResolver {
  handler: Handler
  topicIdentifier: string | undefined
  messageType: ClassConstructor<Message> | undefined
  resolver (message: unknown): boolean
}

type MessageName = string

/**
 * An internal singleton that contains all registrations of messages to functions that handle
 * those messages.
 */
export interface HandlerRegistry {
  /**
   * Registers that a function handles a particular message type
   * @param resolver A method that determines which messages should be forwarded to the handler
   * @param symbol A unique symbol to identify the binding of the message to the function
   * @param handler The function handler to dispatch messages to as they arrive
   * @param messageType The class type of message to handle
   * @param topicIdentifier Identifies the topic where the message is sourced from. This topic must exist
   * before being consumed as the library assumes it's managed externally
   */
  register<TMessage extends Message> (
    messageType: ClassConstructor<TMessage>,
    handler: Handler<TMessage>,
    resolveWith?: (message: TMessage | {}) => boolean,
    topicIdentifier?: string
  ): void

  /**
   * Gets all registered message handlers for a given message name
   * @param messageName Name of the message to get handlers for, found in the `$name` property of the message
   */
  get<MessageType extends Message> (messageName: string): Handler<MessageType>[]

  /**
   * Retrieves a list of all messages that have handler registrations
   */
  getMessageNames (): string[]

  /**
   * Returns the class constructor for a message that has a handler registration
   * @param messageName Message to get a class constructor for
   */
  getMessageConstructor<TMessage extends Message> (messageName: string): ClassConstructor<TMessage> | undefined

  /**
   * Removes all handlers from the registry
   */
  reset (): void
}

class DefaultHandlerRegistry implements HandlerRegistry {

  private registry: HandlerRegistrations = {}
  private unhandledMessages: MessageName[] = []
  private handlerResolvers: HandlerResolver[] = []

  register<TMessage extends Message> (
    messageType: ClassConstructor<TMessage>,
    handler: Handler<TMessage>,
    resolveWith?: (message: TMessage | {}) => boolean,
    topicIdentifier?: string
  ): void {

    // TODO provide optional lookup on resolveWith for external messages
    // this.handlerResolvers.push({
    //   handler,
    //   messageType,
    //   resolver: resolveWith,
    //   topicIdentifier
    // })

    const messageName = new messageType().$name

    if (!this.registry[messageName]) {
      // Register that the message will have subscriptions
      this.registry[messageName] = {
        messageType,
        handlers: []
      }
    }

    const handlerNameAlreadyRegistered = this.registry[messageName].handlers
      .some(registeredHandler => registeredHandler === handler)

    if (handlerNameAlreadyRegistered) {
      throw new HandlerAlreadyRegistered(handler.name)
    }

    this.registry[messageName].handlers.push(handler)
    logger.info('Handler registered', { messageType: messageName, handler: handler.name })
  }

  get<MessageType extends Message> (messageName: string): Handler<MessageType>[] {
    if (!(messageName in this.registry)) {
      // No handlers for the given message
      if (!this.unhandledMessages.some(m => m === messageName)) {
        this.unhandledMessages.push(messageName)
        logger.error(
          `No handlers were registered for message`,
          {
            messageName,
            help: `This could mean that either the handlers haven't been registered with bootstrap.registerHandler(),`
            + ` or that the underlying transport is subscribed to messages that aren't handled and should be removed.`
          })
      }
      return []
    }
    return this.registry[messageName].handlers
  }

  getMessageNames (): string[] {
    return Object.keys(this.registry)
  }

  getMessageConstructor<T extends Message> (messageName: string): ClassConstructor<T> | undefined {
    if (!(messageName in this.registry)) {
      return undefined
    }
    return this.registry[messageName].messageType as ClassConstructor<T>
  }

  reset (): void {
    this.registry = {}
  }
}

export const handlerRegistry: HandlerRegistry = new DefaultHandlerRegistry()
